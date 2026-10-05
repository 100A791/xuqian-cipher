/**
 * 元数据与规则块的编码 —— SPEC 第 5 节阶段二「再写 metadata.js 定义元数据编码」。
 *
 * 为什么是自定义二进制而不是 JSON：
 *   · SPEC §7 明令「禁止用 UTF-8 文本格式存储密文文件」；
 *   · 规则块与元数据都要被整体 MAC 覆盖，JSON 的键顺序/空白会产生**非规范字节**
 *     （简单加密路线已踩过 meta 键序进 AAD 的坑），二进制帧可以精确定长、无解析歧义。
 *
 * 统一帧格式（大端，SPEC §3「字段长度前缀统一大端」）：
 *
 *   KV := u32 count
 *         entry × count
 *   entry := u8  keyLen, key(keyLen 字节, ASCII),
 *            u8  type                // 0=bytes 1=uint64 2=utf8
 *            u32 valueLen, value(valueLen 字节)
 *
 * 元数据与规则块**共用同一套编码**（决策记录 §9-9）：少一套解析器就少一处攻击面。
 */
import { FormatError } from './format.js'

export const TYPE_BYTES = 0
export const TYPE_UINT64 = 1
export const TYPE_UTF8 = 2
const KNOWN_TYPES = new Set([TYPE_BYTES, TYPE_UINT64, TYPE_UTF8])

/** 键名限制为 ASCII 短标识，避免编码里出现多字节键名带来的边界歧义。 */
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new FormatError('KV_KEY_INVALID', `键名非法（只允许 ASCII 字母数字与 _.-，长度 1~64）：${String(key)}`)
  }
}

/** 把 JS 值规范化成 { type, bytes }。 */
function normalizeValue(key, value) {
  if (value instanceof Uint8Array) return { type: TYPE_BYTES, bytes: value }
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
    const asBig = typeof value === 'bigint' ? value : BigInt(value)
    if (asBig < 0n || asBig > 0xffffffffffffffffn) {
      throw new FormatError('KV_VALUE_RANGE', `${key} 超出 uint64 范围`)
    }
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, asBig)
    return { type: TYPE_UINT64, bytes }
  }
  if (typeof value === 'string') return { type: TYPE_UTF8, bytes: textEncoder.encode(value) }
  throw new FormatError('KV_VALUE_TYPE', `${key} 的取值类型不支持：${typeof value}`)
}

/**
 * 编码 KV 块。
 * @param {Array<[string, Uint8Array|number|bigint|string]>} entries 键值对（顺序即写入顺序）
 * @returns {Uint8Array}
 */
export function encodeKv(entries) {
  if (!Array.isArray(entries)) throw new FormatError('KV_INVALID', 'KV 条目必须是数组')
  const seen = new Set()
  const chunks = []
  let total = 4

  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new FormatError('KV_INVALID', 'KV 条目必须是 [key, value]')
    const [key, value] = pair
    assertKey(key)
    if (seen.has(key)) throw new FormatError('KV_KEY_DUPLICATE', `键重复：${key}`)
    seen.add(key)

    const { type, bytes } = normalizeValue(key, value)
    const keyBytes = textEncoder.encode(key)
    const head = new Uint8Array(1 + keyBytes.length + 1 + 4)
    head[0] = keyBytes.length
    head.set(keyBytes, 1)
    head[1 + keyBytes.length] = type
    new DataView(head.buffer).setUint32(1 + keyBytes.length + 1, bytes.length)

    chunks.push(head, bytes)
    total += head.length + bytes.length
  }

  const out = new Uint8Array(total)
  new DataView(out.buffer).setUint32(0, entries.length)
  let off = 4
  for (const chunk of chunks) {
    out.set(chunk, off)
    off += chunk.length
  }
  return out
}

/**
 * 解码 KV 块。严格要求**整块被消费完**（尾部有多余字节即视为格式错误），
 * 避免"多出来的数据被静默忽略"这类解析漏洞。
 */
export function decodeKv(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new FormatError('KV_INVALID', 'KV 必须是字节串')
  if (bytes.length < 4) throw new FormatError('KV_TRUNCATED', 'KV 块过短')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = dv.getUint32(0)

  // 每条最少 1+1+1+4 = 7 字节，用下界先挡掉明显不可能的 count（防止构造超大 count 触发长循环）
  if (4 + count * 7 > bytes.length) throw new FormatError('KV_TRUNCATED', 'KV 条目数与长度不符')

  const entries = []
  const seen = new Set()
  let off = 4
  for (let i = 0; i < count; i++) {
    if (off + 1 > bytes.length) throw new FormatError('KV_TRUNCATED', '键长度字段缺失')
    const keyLen = bytes[off]
    off += 1
    if (off + keyLen + 1 + 4 > bytes.length) throw new FormatError('KV_TRUNCATED', '键或长度字段越界')
    const key = new Uint8Array(bytes.buffer, bytes.byteOffset + off, keyLen)
    let keyText
    try {
      keyText = textDecoder.decode(key)
    } catch {
      throw new FormatError('KV_KEY_INVALID', '键名不是合法 ASCII')
    }
    assertKey(keyText)
    off += keyLen
    if (seen.has(keyText)) throw new FormatError('KV_KEY_DUPLICATE', `键重复：${keyText}`)
    seen.add(keyText)

    const type = bytes[off]
    off += 1
    if (!KNOWN_TYPES.has(type)) throw new FormatError('KV_TYPE_UNKNOWN', `未知取值类型：${type}`)
    const valueLen = dv.getUint32(off)
    off += 4
    if (off + valueLen > bytes.length) throw new FormatError('KV_TRUNCATED', '取值越界')

    const valueBytes = bytes.slice(off, off + valueLen)
    off += valueLen

    let value
    if (type === TYPE_BYTES) value = valueBytes
    else if (type === TYPE_UINT64) {
      if (valueBytes.length !== 8) throw new FormatError('KV_VALUE_LENGTH', 'uint64 必须是 8 字节')
      value = new DataView(valueBytes.buffer, valueBytes.byteOffset).getBigUint64(0)
    } else {
      if (valueBytes.length > 4096) throw new FormatError('KV_VALUE_LENGTH', '文本取值过长')
      try {
        value = textDecoder.decode(valueBytes)
      } catch {
        throw new FormatError('KV_VALUE_ENCODING', '文本取值不是合法 UTF-8')
      }
    }
    entries.push([keyText, value])
  }

  if (off !== bytes.length) throw new FormatError('KV_TRAILING_BYTES', 'KV 块尾部有多余字节')
  return entries
}

/** 便捷：把条目数组转成 Map。 */
export function kvToMap(entries) {
  return new Map(entries)
}

/** 便捷：按 Map/对象构造条目数组（保持插入顺序）。 */
export function toEntries(input) {
  if (input instanceof Map) return [...input.entries()]
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') return Object.entries(input)
  throw new FormatError('KV_INVALID', '无法转换为 KV 条目')
}

// ---------------------------------------------------------------------------
// 元数据 / 规则块：语义层
// ---------------------------------------------------------------------------

/** 元数据允许的键（白名单，避免把任意字段写进文件）。 */
export const META_KEYS = Object.freeze(['name', 'size', 'mime', 'created', 'note'])

/** 构造并编码元数据块。未知键直接拒绝，不做静默丢弃。 */
export function encodeMetadata(meta) {
  const entries = toEntries(meta)
  for (const [key] of entries) {
    if (!META_KEYS.includes(key)) throw new FormatError('META_KEY_UNKNOWN', `未知元数据键：${key}`)
  }
  return encodeKv(entries)
}

export function decodeMetadata(bytes) {
  return kvToMap(decodeKv(bytes))
}

/** 规则块：与元数据同一套编码；语义由上层（水印/解密流程）解释。 */
export function encodeRules(entries) {
  return encodeKv(toEntries(entries))
}

export function decodeRules(bytes) {
  return kvToMap(decodeKv(bytes))
}
