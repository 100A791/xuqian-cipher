/**
 * AES —— SPEC 第 5 节阶段一「再写 aes.js 的密钥扩展和单块加密，跑 FIPS 197 测试向量」。
 * 自研实现，不引入任何第三方库（SPEC 第 7 节）。
 *
 * S-box 由数学定义**程序生成**（GF(2^8) 求逆 + 仿射变换），不手抄 256 个常数——
 * 手抄表一旦错一格，向量测试会全线失败且极难定位。
 */

/** GF(2^8) 乘法，模 AES 既约多项式 x^8+x^4+x^3+x+1 (0x11b)。 */
function gfMul(a, b) {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p & 0xff
}

/** GF(2^8) 乘法逆元（0 的逆元约定为 0）；用 a^254 = a^-1。 */
function gfInv(a) {
  if (a === 0) return 0
  let result = 1
  for (let i = 0; i < 254; i++) result = gfMul(result, a)
  return result
}

const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff

/** 生成 S-box（FIPS 197 §5.1.1）。仿射变换 = inv ⊕ rotl(inv,1..4) ⊕ 0x63，别漏掉 inv 本身。 */
function buildSbox() {
  const sbox = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    const inv = gfInv(i)
    sbox[i] = inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63
  }
  return sbox
}

export const SBOX = buildSbox()

/** 轮常量 Rcon（FIPS 197 §5.2）。 */
const RCON = Uint8Array.from([0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36])

const NK_BY_KEY_LEN = { 16: 4, 24: 6, 32: 8 }

/** 单字节代换。 */
const subByte = (b) => SBOX[b]

/**
 * AES 密钥扩展（FIPS 197 §5.2）。
 * @param {Uint8Array} key 16 / 24 / 32 字节
 * @returns {{ roundKeys: Uint8Array, rounds: number }} roundKeys 为 (rounds+1)*16 字节
 */
export function expandKey(key) {
  if (!(key instanceof Uint8Array)) throw new TypeError('expandKey 只接受 Uint8Array')
  const nk = NK_BY_KEY_LEN[key.length]
  if (!nk) throw new RangeError(`AES 密钥长度必须是 16/24/32 字节，实际 ${key.length}`)
  const rounds = nk + 6
  const totalWords = 4 * (rounds + 1)
  const w = new Uint8Array(totalWords * 4)
  w.set(key, 0)

  for (let i = nk; i < totalWords; i++) {
    let t0 = w[(i - 1) * 4]
    let t1 = w[(i - 1) * 4 + 1]
    let t2 = w[(i - 1) * 4 + 2]
    let t3 = w[(i - 1) * 4 + 3]

    if (i % nk === 0) {
      // RotWord + SubWord + Rcon
      const tmp = t0
      t0 = subByte(t1) ^ RCON[i / nk]
      t1 = subByte(t2)
      t2 = subByte(t3)
      t3 = subByte(tmp)
    } else if (nk > 6 && i % nk === 4) {
      // 仅 AES-256：额外的 SubWord
      t0 = subByte(t0)
      t1 = subByte(t1)
      t2 = subByte(t2)
      t3 = subByte(t3)
    }

    w[i * 4] = w[(i - nk) * 4] ^ t0
    w[i * 4 + 1] = w[(i - nk) * 4 + 1] ^ t1
    w[i * 4 + 2] = w[(i - nk) * 4 + 2] ^ t2
    w[i * 4 + 3] = w[(i - nk) * 4 + 3] ^ t3
  }

  return { roundKeys: w, rounds }
}

/** AddRoundKey：state 与第 round 组轮密钥异或（FIPS 197 §5.1.4）。 */
function addRoundKey(state, roundKeys, round) {
  const off = round * 16
  for (let i = 0; i < 16; i++) state[i] ^= roundKeys[off + i]
}

/** ShiftRows（FIPS 197 §5.1.2）。状态按列主序：state[r + 4c]。 */
function shiftRows(state) {
  // 必须显式复制：Node Buffer.prototype.slice 其实是 subarray（共享内存的视图），
  // 用 slice() 会先读到已被本行覆盖的值，把 ShiftRows 算坏。
  const t = new Uint8Array(state)
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      state[r + 4 * c] = t[r + 4 * ((c + r) % 4)]
    }
  }
}

/** MixColumns（FIPS 197 §5.1.3）。 */
function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = 4 * c
    const a0 = state[i]
    const a1 = state[i + 1]
    const a2 = state[i + 2]
    const a3 = state[i + 3]
    state[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3
    state[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3
    state[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3)
    state[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2)
  }
}

/**
 * 单块加密（AES-128/192/256，ECB 单块语义）。
 * @param {Uint8Array} block 16 字节明文
 * @param {Uint8Array|{roundKeys:Uint8Array,rounds:number}} key 原始密钥或已扩展密钥
 * @returns {Uint8Array} 16 字节密文
 */
export function encryptBlock(block, key) {
  if (!(block instanceof Uint8Array) || block.length !== 16) throw new RangeError('AES 分组必须是 16 字节')
  const schedule = key && key.roundKeys ? key : expandKey(key)
  const { roundKeys, rounds } = schedule

  // 显式复制，不要用 block.slice()：传入 Node Buffer 时会返回共享内存的视图，
  // 后续就地轮变换会改写调用方的明文缓冲区。
  const state = new Uint8Array(block)
  addRoundKey(state, roundKeys, 0)
  for (let round = 1; round < rounds; round++) {
    for (let i = 0; i < 16; i++) state[i] = subByte(state[i])
    shiftRows(state)
    mixColumns(state)
    addRoundKey(state, roundKeys, round)
  }
  for (let i = 0; i < 16; i++) state[i] = subByte(state[i])
  shiftRows(state)
  addRoundKey(state, roundKeys, rounds)
  return state
}
