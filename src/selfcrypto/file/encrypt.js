/**
 * 自研路线的加密 —— SPEC 第 5 节阶段二「再写 encrypt.js 实现六步加密流程」。
 * 零第三方依赖（SPEC §7）。
 *
 * SPEC 只说"六步"、未逐条列出，这里给出明确流程（**决策记录 D7**，可被用户否决）：
 *
 *   第 1 步  生成随机材料：SALT_RANDOM(32)、BOOT_NONCE(16)、主密钥 K(16)（调用方也可自带 K）
 *   第 2 步  派生子密钥：encKey / macKey / keyCheck（见 crypto/kdf.js，只用 HMAC-SHA256）
 *   第 3 步  组装明文载荷：u32(metaLen) ‖ 元数据 KV ‖ 文件内容
 *            —— 元数据**一并加密**，因此原文件名等不会出现在明文里
 *   第 4 步  分块 AES-CTR：每块 CHUNK_SIZE；块 i 的计数器 = BOOT_NONCE(完整 128 位) + i × 每块计数器个数
 *            —— 16 字节 nonce **全部参与**，计数器空间按块不重叠，满足 §7「禁止 nonce 复用」
 *   第 5 步  段拆分与重排：密文按字节交错拆成 SEGMENTS 份，再按头部记录的 SEGMENT_ORDER 排列
 *   第 6 步  整体 MAC：HMAC(macKey, 头部 ‖ 规则块 ‖ 载荷)，追加到文件末尾（encrypt-then-MAC）
 */
import { CHUNK_SIZE, MAC_LEN } from '../common/constants.js'
import { concatBytes, copyBytes, takeBytes, writeUint64BE } from '../common/bytes.js'
import { randomBytes } from '../crypto/random.js'
import { hmacSha256 } from '../crypto/hmac.js'
import { aesCtr } from '../crypto/ctr.js'
import { deriveSubkeys, MASTER_KEY_LEN } from '../crypto/kdf.js'
import { assertExactLength, assertBytes } from '../common/validate.js'
import { FLAG_FULL_NONCE_COUNTER, FormatError, assembleFile, defaultHeader, serializeHeader } from './format.js'
import { encodeRules, encodeMetadata, META_KEYS } from './metadata.js'

/** 每块的 AES 计数器个数（分块大小必须是 16 的整数倍，否则块边界会切碎一个计数器）。 */
const BLOCKS_PER_CHUNK = CHUNK_SIZE / 16

/**
 * 往 16 字节大端计数器上累加一个 64 位无符号值（含进位）。
 * 用于按块推进 CTR 计数器空间：`counter(块 i) = nonce + i × 每块计数器数`。
 */
function addToCounter(counter, value) {
  const addend = writeUint64BE(value)
  let carry = 0
  for (let i = 15; i >= 0; i--) {
    const sum = counter[i] + (i >= 8 ? addend[i - 8] : 0) + carry
    counter[i] = sum & 0xff
    carry = sum >> 8
  }
  return counter
}

/**
 * 第 4 步用的计数器。两种构造方式，由头部的 `FLAG_FULL_NONCE_COUNTER` 选择：
 *
 *   fullNonce = true（新文件）：整个 16 字节 BOOT_NONCE 作 128 位初值，
 *                              再累加块偏移 → **完整 128 位 nonce 空间**。
 *   fullNonce = false（v1 旧文件）：前 8 字节取 BOOT_NONCE、后 8 字节放块偏移，
 *                              块 0 时后 8 字节恒为全零 → 有效 nonce 只有 64 位。
 *                              保留此分支**仅为能解开旧文件**，新文件一律用上面那种。
 *
 * 两种方式下不同块的计数器都不重叠：块内由 aesCtr 自行自增，块间靠块偏移跳段。
 */
export function blockCounter(bootNonce, chunkIndex, fullNonce = true) {
  assertExactLength(bootNonce, 16, 'BOOT_NONCE')
  const counter = new Uint8Array(16)
  if (fullNonce) {
    counter.set(bootNonce, 0)
  } else {
    counter.set(bootNonce.subarray(0, 8), 0)
  }
  return addToCounter(counter, BigInt(chunkIndex) * BigInt(BLOCKS_PER_CHUNK))
}

/** 第 j 份的长度：收下标 i 满足 i % segments === j 的字节。 */
export function shareLengths(totalLen, segments) {
  return Array.from({ length: segments }, (_, j) => (j < totalLen ? Math.ceil((totalLen - j) / segments) : 0))
}

/** 第 5 步：按字节交错拆成 segments 份（纯拆分，不含重排）。 */
export function interleaveSplit(bytes, segments) {
  if (!Number.isInteger(segments) || segments < 1) throw new RangeError('段数非法')
  const lens = shareLengths(bytes.length, segments)
  const shares = lens.map((n) => new Uint8Array(n))
  const cursor = new Array(segments).fill(0)
  for (let i = 0; i < bytes.length; i++) {
    const j = i % segments
    shares[j][cursor[j]++] = bytes[i]
  }
  return shares
}

/** 纯合并：按 i % segments 回放各份（份的排列已是逻辑顺序）。 */
export function interleaveJoin(shares) {
  const total = shares.reduce((sum, s) => sum + s.length, 0)
  const out = new Uint8Array(total)
  const cursor = new Array(shares.length).fill(0)
  for (let i = 0; i < total; i++) {
    const j = i % shares.length
    out[i] = shares[j][cursor[j]++]
  }
  return out
}

/** 按 order 把逻辑份排列成写入顺序。 */
export function reorderShares(shares, order) {
  return concatBytes(...Array.from(order).map((physical) => shares[physical]))
}

/**
 * 把写入顺序的载荷还原成**逻辑顺序**的份。
 * 关键：必须按 shareLengths 算出的长度切片——载荷重排后"第 i 个字节属于哪一份"已经变了，
 * 再按 index % segments 去切会切错（这个 bug 就是被与 OpenSSL 的交叉验证抓出来的）。
 */
export function unreorderShares(payload, segments, order) {
  const lens = shareLengths(payload.length, segments)
  const shares = new Array(segments)
  let off = 0
  for (const physical of Array.from(order)) {
    const len = lens[physical]
    const slice = new Uint8Array(len)
    slice.set(payload.subarray(off, off + len))
    shares[physical] = slice
    off += len
  }
  if (off !== payload.length) throw new FormatError('SEGMENTS_INVALID', '段长度与载荷长度不吻合')
  return shares
}

/**
 * 把载荷按块做 CTR 变换（与 decrypt 侧逐块对应）。
 *
 * 注意：**加密与解密调用的是同一个函数**（CTR 是对称流模式，异或同一段密钥流
 * 即可加可解），所以 decrypt.js 里"解密"也是调它。名字保留为 encryptPayload
 * 是为了与 SPEC 的模块划分一致，不要被名字误导。
 *
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} encKey
 * @param {Uint8Array} bootNonce
 * @param {(progress: {phase: string, done: number, total: number}) => void} [onProgress]
 *        逐块上报进度。**只覆盖分块变换这一段**（phase='cipher'），
 *        不把"分块进度"冒充"整个文件加密的进度"——后面还有段拆分与整体 MAC。
 * @param {boolean} [fullNonce] 是否用完整 16 字节 nonce 作 128 位计数器起点。
 *        新文件为 true；解 64 位时代的旧文件时才传 false（见 blockCounter）。
 */
export function encryptPayload(plaintext, encKey, bootNonce, onProgress, fullNonce = true) {
  const out = new Uint8Array(plaintext.length)
  const total = Math.max(1, Math.ceil(plaintext.length / CHUNK_SIZE))
  if (plaintext.length === 0) {
    onProgress?.({ phase: 'cipher', done: 1, total: 1 })
    return out
  }
  for (let offset = 0, index = 0; offset < plaintext.length; offset += CHUNK_SIZE, index++) {
    const chunk = plaintext.subarray(offset, Math.min(offset + CHUNK_SIZE, plaintext.length))
    out.set(aesCtr(encKey, blockCounter(bootNonce, index, fullNonce), chunk), offset)
    onProgress?.({ phase: 'cipher', done: index + 1, total })
  }
  return out
}

/**
 * 加密文件。
 * @param {Uint8Array} data 原文件字节
 * @param {Array<[string, any]>|Map|object} metadata 元数据（键必须在 META_KEYS 白名单内）
 * @param {{masterKey?: Uint8Array, rules?: Array<[string, any]>, flags?: number, now?: number,
 *          onProgress?: (progress: {phase: string, done: number, total: number}) => void}} [options]
 * @returns {{ cipherBytes: Uint8Array, keyK: Uint8Array, header: object }}
 */
export function encryptFile(data, metadata = [], options = {}) {
  assertBytes(data, 'data')
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : undefined

  // 第 1 步：随机材料
  const keyK = options.masterKey ? copyBytes(assertExactLength(options.masterKey, MASTER_KEY_LEN, '主密钥')) : randomBytes(MASTER_KEY_LEN)
  const salt = randomBytes(32)
  const bootNonce = randomBytes(16)

  // 第 2 步：派生子密钥
  const { encKey, macKey, keyCheck } = deriveSubkeys(keyK, salt)

  // 第 3 步：明文载荷 = 元数据长度 + 元数据 + 内容
  const metaBytes = encodeMetadata(metadata)
  const lenPrefix = new Uint8Array(4)
  new DataView(lenPrefix.buffer).setUint32(0, metaBytes.length)
  const plaintext = concatBytes(lenPrefix, metaBytes, data)

  // 第 4 步：分块 CTR —— 新文件一律把**完整 16 字节** BOOT_NONCE 用作 128 位计数器起点
  const fullNonce = true
  onProgress?.({ phase: 'setup', done: 0, total: 1 })
  const ciphertext = encryptPayload(plaintext, encKey, bootNonce, onProgress, fullNonce)

  // 第 5 步：段拆分与重排
  onProgress?.({ phase: 'split', done: 0, total: 1 })
  // 注意用 Array.from(order) 再 map：TypedArray.prototype.map 返回的仍是 TypedArray，
  // 直接 map 会把 Uint8Array 强转成数字，concatBytes 收到的就不是字节串了。
  const order = Uint8Array.from([2, 0, 1])
  const shares = interleaveSplit(ciphertext, 3)
  const payload = reorderShares(shares, order)

  // 第 6 步：整体 MAC（覆盖头部 ‖ 规则块 ‖ 载荷）
  onProgress?.({ phase: 'mac', done: 0, total: 1 })
  const rulesBytes = encodeRules(options.rules ?? [])
  const header = defaultHeader({
    // 必须把"用了完整 nonce"记进文件：否则解密端无从判断该用哪种计数器构造，
    // 只能靠猜默认值 —— 那会让旧文件解不开。与上面的 fullNonce 变量同源，不会漂移。
    flags: (options.flags ?? 0) | (fullNonce ? FLAG_FULL_NONCE_COUNTER : 0),
    timestamp: options.now ?? Math.floor(Date.now() / 1000),
    bootNonce,
    salt,
    keyCheck,
    segmentOrder: order,
  })
  // 规则块长度要先进头部，MAC 才算得准
  const headerForMac = defaultHeader({ ...header, rulesLen: rulesBytes.length, payloadLen: payload.length })
  const mac = hmacSha256(macKey, concatBytes(serializeHeader(headerForMac), rulesBytes, payload))

  const { bytes, header: finalHeader } = assembleFile({
    header: headerForMac,
    rules: rulesBytes,
    payload,
    mac: takeBytes(mac, MAC_LEN),
  })
  return { cipherBytes: bytes, keyK, header: finalHeader }
}

export { META_KEYS }
