/**
 * Shamir 秘密共享（Shamir's Secret Sharing over GF(256)）。
 *
 * 说明：这是 Shamir 于 1979 年提出的公开方案，属于成熟密码学构造，不是自创算法。
 * 这里采用 GF(2^8) 上的多项式插值，对 128 位主密钥的**每一个字节**独立做 (M, N) 门限分割，
 * 因此任意 M 份可以恢复完整密钥，少于 M 份得不到任何信息（信息论安全）。
 *
 * 安全注意：
 * - 分片一旦生成，请分发给不同保管人；任意 M 份组合即可还原密钥。
 * - 分片只在密钥弹窗内生成，关闭弹窗后本模块不持有任何数据。
 */

/**
 * GF(2^8) 乘法表。生成元 g = 0x03，约化多项式 x^8+x^4+x^3+x+1（AES 同款）。
 *
 * 注意：这里必须用 xtime 逐字节计算，不能用 `x <<= 1; if (x & 0x100) x ^= 0x11b`
 * 那种写法——那样会在 255 步内提前回到 0，导致 exp/log 表退化（乘法恒为 1）。
 */
const EXP = new Uint8Array(255)
const LOG = new Uint8Array(256)

;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    // x = x * 0x03 = xtime(x) ^ x
    let doubled = x << 1
    if (doubled & 0x100) doubled ^= 0x11b
    x = (doubled ^ x) & 0xff
  }
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  const sum = LOG[a] + LOG[b]
  return EXP[sum >= 255 ? sum - 255 : sum]
}

function gfInv(a: number): number {
  if (a === 0) throw new Error('SHAMIR_INV_ZERO')
  const log = LOG[a]
  return EXP[log === 0 ? 0 : 255 - log]
}

export interface ShamirShare {
  /** 分片编号 x，从 1 开始 */
  x: number
  /** 分片字节（长度 = 主密钥长度） */
  y: Uint8Array
}

/**
 * 把 secret 分成 n 份，至少 m 份可恢复。
 * @param secret 主密钥字节（16 字节）
 * @param m 门限（>=2）
 * @param n 总分片数（m <= n <= 255）
 * @param randomFn 随机字节源（默认为 CSPRNG，测试时可注入）
 */
export function splitSecret(
  secret: Uint8Array,
  m: number,
  n: number,
  randomFn: (len: number) => Uint8Array,
): ShamirShare[] {
  if (!Number.isInteger(m) || !Number.isInteger(n)) throw new Error('SHAMIR_BAD_PARAMS')
  if (m < 2 || n < m || n > 255) throw new Error('SHAMIR_BAD_PARAMS')
  if (secret.length === 0) throw new Error('SHAMIR_EMPTY_SECRET')

  const shares: ShamirShare[] = []
  for (let i = 1; i <= n; i++) shares.push({ x: i, y: new Uint8Array(secret.length) })

  for (let byteIndex = 0; byteIndex < secret.length; byteIndex++) {
    // 构造 m−1 次多项式：f(0) = secret[byteIndex]
    const coeffs = new Uint8Array(m)
    coeffs[0] = secret[byteIndex]
    const rand = randomFn(m - 1)
    for (let i = 1; i < m; i++) coeffs[i] = rand[i - 1]

    for (const share of shares) {
      let acc = 0
      let pow = 1
      for (let i = 0; i < m; i++) {
        acc ^= gfMul(coeffs[i], pow)
        pow = gfMul(pow, share.x)
      }
      share.y[byteIndex] = acc
    }
  }
  return shares
}

/** 由至少 m 份分片恢复秘密。分片数不足时会得到错误结果，调用方需自行校验指纹。 */
export function combineShares(shares: ShamirShare[]): Uint8Array {
  if (shares.length === 0) throw new Error('SHAMIR_NO_SHARES')
  const len = shares[0].y.length
  for (const s of shares) {
    if (s.y.length !== len) throw new Error('SHAMIR_LENGTH_MISMATCH')
    if (s.x < 1 || s.x > 255) throw new Error('SHAMIR_BAD_SHARE')
  }
  const xs = new Set(shares.map((s) => s.x))
  if (xs.size !== shares.length) throw new Error('SHAMIR_DUPLICATE_SHARE')

  const out = new Uint8Array(len)
  for (let byteIndex = 0; byteIndex < len; byteIndex++) {
    let acc = 0
    for (let i = 0; i < shares.length; i++) {
      // 拉格朗日插值在 x=0 处的取值
      let num = 1
      let den = 1
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue
        num = gfMul(num, shares[j].x)
        den = gfMul(den, shares[i].x ^ shares[j].x)
      }
      const basis = gfMul(num, gfInv(den))
      acc ^= gfMul(shares[i].y[byteIndex], basis)
    }
    out[byteIndex] = acc
  }
  return out
}

/** 分片文本编码：XUQIAN-SHARE-<x>-<base64url> */
export function encodeShare(share: ShamirShare, total: number, threshold: number): string {
  let bin = ''
  for (const b of share.y) bin += String.fromCharCode(b)
  const b64 = btoaSafe(bin)
  return `XUQIAN-SHARE-${share.x}of${total}-${threshold}-${b64}`
}

export function decodeShare(text: string): { share: ShamirShare; total: number; threshold: number } {
  const m = /^XUQIAN-SHARE-(\d+)of(\d+)-(\d+)-([A-Za-z0-9+/=_-]+)$/.exec(text.trim())
  if (!m) throw new Error('SHAMIR_BAD_FORMAT')
  const x = Number.parseInt(m[1], 10)
  const total = Number.parseInt(m[2], 10)
  const threshold = Number.parseInt(m[3], 10)
  const bin = b64Decode(m[4])
  const y = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) y[i] = bin.charCodeAt(i)
  return { share: { x, y }, total, threshold }
}

function btoaSafe(bin: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bin.length; i += 3) {
    const b0 = bin.charCodeAt(i)
    const b1 = i + 1 < bin.length ? bin.charCodeAt(i + 1) : NaN
    const b2 = i + 2 < bin.length ? bin.charCodeAt(i + 2) : NaN
    out += chars[b0 >> 2]
    out += chars[((b0 & 3) << 4) | (Number.isNaN(b1) ? 0 : b1 >> 4)]
    out += Number.isNaN(b1) ? '=' : chars[((b1 & 15) << 2) | (Number.isNaN(b2) ? 0 : b2 >> 6)]
    out += Number.isNaN(b2) ? '=' : chars[b2 & 63]
  }
  return out
}

function b64Decode(text: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = text.replace(/=+$/, '')
  let bin = ''
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = chars.indexOf(ch)
    if (v < 0) throw new Error('SHAMIR_BAD_BASE64')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bin += String.fromCharCode((acc >> bits) & 0xff)
    }
  }
  return bin
}
