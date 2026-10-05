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
 *   第 4 步  分块 AES-CTR：每块 CHUNK_SIZE；块 i 的计数器 = BOOT_NONCE[0..8] ‖ u64(i × 每块计数器个数)
 *            —— 计数器空间按块**不重叠**，满足 §7「禁止 nonce 复用」
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
import { FormatError, assembleFile, defaultHeader, serializeHeader } from './format.js'
import { encodeRules, encodeMetadata, META_KEYS } from './metadata.js'

/** 每块的 AES 计数器个数（分块大小必须是 16 的整数倍，否则块边界会切碎一个计数器）。 */
const BLOCKS_PER_CHUNK = CHUNK_SIZE / 16

/**
 * 第 4 步用的计数器：前 8 字节取自 BOOT_NONCE，后 8 字节是该块的起始计数（大端 u64）。
 * 这样不同块用的计数器永不重叠；块内由 aesCtr 自行自增。
 */
export function blockCounter(bootNonce, chunkIndex) {
  assertExactLength(bootNonce, 16, 'BOOT_NONCE')
  const counter = new Uint8Array(16)
  counter.set(bootNonce.subarray(0, 8), 0)
  counter.set(writeUint64BE(BigInt(chunkIndex) * BigInt(BLOCKS_PER_CHUNK)), 8)
  return counter
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
 * 把明文载荷按块加密成密文（与 decrypt 侧逐块对应）。
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} encKey
 * @param {Uint8Array} bootNonce
 * @param {(progress: {phase: string, done: number, total: number}) => void} [onProgress]
 *        逐块上报进度。**只覆盖分块变换这一段**（phase='cipher'），
 *        不把"分块进度"冒充"整个文件加密的进度"——后面还有段拆分与整体 MAC。
 */
export function encryptPayload(plaintext, encKey, bootNonce, onProgress) {
  const out = new Uint8Array(plaintext.length)
  const total = Math.max(1, Math.ceil(plaintext.length / CHUNK_SIZE))
  if (plaintext.length === 0) {
    onProgress?.({ phase: 'cipher', done: 1, total: 1 })
    return out
  }
  for (let offset = 0, index = 0; offset < plaintext.length; offset += CHUNK_SIZE, index++) {
    const chunk = plaintext.subarray(offset, Math.min(offset + CHUNK_SIZE, plaintext.length))
    out.set(aesCtr(encKey, blockCounter(bootNonce, index), chunk), offset)
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

  // 第 4 步：分块 CTR
  onProgress?.({ phase: 'setup', done: 0, total: 1 })
  const ciphertext = encryptPayload(plaintext, encKey, bootNonce, onProgress)

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
    flags: options.flags ?? 0,
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
