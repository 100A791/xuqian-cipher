/**
 * 自研路线的文件头与整体布局 —— SPEC 第 5 节阶段二「先写 format.js 定义文件头和字段序列化」。
 *
 * 自研实现，零第三方依赖（SPEC 第 7 节）。
 *
 * 文件布局（全部大端，SPEC §3「字段长度前缀统一大端」）：
 *
 *   [头部 97 字节] [规则块 RULES_LEN 字节] [密文载荷 PAYLOAD_LEN 字节] [整体 MAC 32 字节]
 *
 * 头部字段表：
 *   偏移  长度  字段            说明
 *   0     8     MAGIC           SPEC §3 的 8 个非打印字节
 *   8     1     VERSION         当前 0x01
 *   9     1     FLAGS           bit0=内容经压缩；bit1=有口令保护；其余保留必须为 0
 *   10    2     RESERVED        保留字节：必须为 0（非零即拒绝解析）。与国密 SM4 的 FK 无关
 *   12    4     TIMESTAMP       Unix 秒
 *   16    16    BOOT_NONCE      一次性引导随机数（nonce 唯一性的来源之一）
 *   32    4     RULES_LEN       规则块字节数
 *   36    4     CHUNK_SIZE      分块大小（SPEC §3：1048576）
 *   40    1     SEGMENTS        段数（SPEC §3：3）
 *   41    1     SPLIT_MODE      0 = 按字节交错
 *   42    3     SEGMENT_ORDER   三份的排列顺序（SPEC §3：2 0 1）
 *   45    32    SALT_RANDOM     随机盐（SPEC §3：32 字节）
 *   77    16    KEY_CHECK       SPEC §3：16 字节，用于不解密即校验密钥
 *   93    4     PAYLOAD_LEN     密文载荷字节数
 *
 * 设计取向（写进头部而不是写死在代码里）：段数/拆分方式/顺序/分块这类**结构性选择**都记在文件里，
 * 因此日后调整默认值不会让旧文件解不开；解密端一律以文件自述为准，不信任何隐式默认。
 *
 * MAC 放在文件**末尾**：整体 MAC 覆盖"它之前的全部字节"（encrypt-then-MAC），
 * 这样不必在计算时跳过中间某个字段，减少实现出错面。
 */
import {
  CHUNK_SIZE,
  ENDIAN,
  MAGIC,
  SALT_LEN,
  SEGMENTS,
  SEGMENT_ORDER,
  SPLIT_MODE,
  TIMESTAMP_LEN,
  BOOT_NONCE_LEN,
  KEY_CHECK_LEN,
  MAC_LEN,
  RULES_LEN_LEN,
  VERSION,
} from '../common/constants.js'

export const HEADER_LEN = 97
export const MAC_OFFSET_FROM_END = MAC_LEN

/** FLAGS 位定义（其余位必须为 0，否则视为格式错误）。 */
export const FLAG_COMPRESSED = 0b0000_0001
export const FLAG_PASSPHRASE = 0b0000_0010
const FLAG_KNOWN_MASK = FLAG_COMPRESSED | FLAG_PASSPHRASE

export const SPLIT_MODE_INTERLEAVE_BYTES = 0

/** 头部字段偏移表 —— 供测试与文档引用，避免各处硬编码数字。 */
export const OFFSETS = Object.freeze({
  MAGIC: 0,
  VERSION: 8,
  FLAGS: 9,
  RESERVED: 10,
  TIMESTAMP: 12,
  BOOT_NONCE: 16,
  RULES_LEN: 32,
  CHUNK_SIZE: 36,
  SEGMENTS: 40,
  SPLIT_MODE: 41,
  SEGMENT_ORDER: 42,
  SALT: 45,
  KEY_CHECK: 77,
  PAYLOAD_LEN: 93,
})

export class FormatError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.code = code
  }
}

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** 构造一个"默认参数"的头部对象（加密端从这里出发，再覆盖需要变的字段）。 */
export function defaultHeader(overrides = {}) {
  return {
    version: VERSION,
    flags: 0,
    timestamp: Math.floor(Date.now() / 1000),
    bootNonce: new Uint8Array(BOOT_NONCE_LEN),
    chunkSize: CHUNK_SIZE,
    segments: SEGMENTS,
    splitMode: SPLIT_MODE_INTERLEAVE_BYTES,
    segmentOrder: Uint8Array.from(SEGMENT_ORDER),
    salt: new Uint8Array(SALT_LEN),
    keyCheck: new Uint8Array(KEY_CHECK_LEN),
    rulesLen: 0,
    payloadLen: 0,
    ...overrides,
  }
}

/** 校验头部取值；任何越界/不认识的取值一律拒绝，不做"容错纠正"。 */
export function assertHeaderValid(header) {
  const fail = (code, message) => {
    throw new FormatError(code, message)
  }
  if (header.version !== VERSION) fail('VERSION_UNSUPPORTED', `不支持的版本：${header.version}`)
  if ((header.flags & ~FLAG_KNOWN_MASK) !== 0) fail('FLAGS_INVALID', '存在未知的标志位')
  if (header.chunkSize < 1) fail('CHUNK_SIZE_INVALID', '分块大小必须 ≥1')
  if (header.segments < 1 || header.segments > 255) fail('SEGMENTS_INVALID', `段数非法：${header.segments}`)
  if (header.splitMode !== SPLIT_MODE_INTERLEAVE_BYTES) fail('SPLIT_MODE_INVALID', `未知拆分方式：${header.splitMode}`)
  if (!(header.segmentOrder instanceof Uint8Array) || header.segmentOrder.length !== 3) {
    fail('SEGMENT_ORDER_INVALID', '段顺序必须是 3 字节')
  }
  const seen = new Set()
  for (const v of header.segmentOrder) {
    if (v >= 3 || seen.has(v)) fail('SEGMENT_ORDER_INVALID', '段顺序必须是 0/1/2 的一个排列')
    seen.add(v)
  }
  if (!(header.salt instanceof Uint8Array) || header.salt.length !== SALT_LEN) fail('SALT_INVALID', '盐长度错误')
  if (!(header.bootNonce instanceof Uint8Array) || header.bootNonce.length !== BOOT_NONCE_LEN) {
    fail('NONCE_INVALID', 'BOOT_NONCE 长度错误')
  }
  if (!(header.keyCheck instanceof Uint8Array) || header.keyCheck.length !== KEY_CHECK_LEN) {
    fail('KEY_CHECK_INVALID', 'KEY_CHECK 长度错误')
  }
  if (!Number.isInteger(header.rulesLen) || header.rulesLen < 0) fail('RULES_LEN_INVALID', '规则块长度非法')
  if (!Number.isInteger(header.payloadLen) || header.payloadLen < 0) fail('PAYLOAD_LEN_INVALID', '载荷长度非法')
  if (!Number.isInteger(header.timestamp) || header.timestamp < 0) fail('TIMESTAMP_INVALID', '时间戳非法')
  return header
}

/** 序列化头部（97 字节）。 */
export function serializeHeader(header) {
  assertHeaderValid(header)
  const out = new Uint8Array(HEADER_LEN)
  const dv = view(out)
  out.set(MAGIC, OFFSETS.MAGIC)
  out[OFFSETS.VERSION] = header.version
  out[OFFSETS.FLAGS] = header.flags
  dv.setUint16(OFFSETS.RESERVED, 0) // 保留字节：固定为 0（与 SM4 的 FK 无关，见文件头注释）
  dv.setUint32(OFFSETS.TIMESTAMP, header.timestamp)
  out.set(header.bootNonce, OFFSETS.BOOT_NONCE)
  dv.setUint32(OFFSETS.RULES_LEN, header.rulesLen)
  dv.setUint32(OFFSETS.CHUNK_SIZE, header.chunkSize)
  out[OFFSETS.SEGMENTS] = header.segments
  out[OFFSETS.SPLIT_MODE] = header.splitMode
  out.set(header.segmentOrder, OFFSETS.SEGMENT_ORDER)
  out.set(header.salt, OFFSETS.SALT)
  out.set(header.keyCheck, OFFSETS.KEY_CHECK)
  dv.setUint32(OFFSETS.PAYLOAD_LEN, header.payloadLen)
  return out
}

/** 解析头部：字节不足或魔数/版本不对时抛 FormatError。 */
export function parseHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LEN) {
    throw new FormatError('FILE_TRUNCATED', '文件小于头部长度')
  }
  const dv = view(bytes)
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[OFFSETS.MAGIC + i] !== MAGIC[i]) throw new FormatError('MAGIC_MISMATCH', '魔数不匹配')
  }
  const reserved = dv.getUint16(OFFSETS.RESERVED)
  if (reserved !== 0) throw new FormatError('RESERVED_FIELD_UNSUPPORTED', '保留字段非零，本版本无法解析')

  const header = defaultHeader({
    version: bytes[OFFSETS.VERSION],
    flags: bytes[OFFSETS.FLAGS],
    timestamp: dv.getUint32(OFFSETS.TIMESTAMP),
    bootNonce: bytes.slice(OFFSETS.BOOT_NONCE, OFFSETS.BOOT_NONCE + BOOT_NONCE_LEN),
    rulesLen: dv.getUint32(OFFSETS.RULES_LEN),
    chunkSize: dv.getUint32(OFFSETS.CHUNK_SIZE),
    segments: bytes[OFFSETS.SEGMENTS],
    splitMode: bytes[OFFSETS.SPLIT_MODE],
    segmentOrder: bytes.slice(OFFSETS.SEGMENT_ORDER, OFFSETS.SEGMENT_ORDER + 3),
    salt: bytes.slice(OFFSETS.SALT, OFFSETS.SALT + SALT_LEN),
    keyCheck: bytes.slice(OFFSETS.KEY_CHECK, OFFSETS.KEY_CHECK + KEY_CHECK_LEN),
    payloadLen: dv.getUint32(OFFSETS.PAYLOAD_LEN),
  })
  return assertHeaderValid(header)
}

/** 由头部推出各段在文件中的偏移，并校验文件总长度自洽。 */
export function fileLayout(header, totalLength) {
  const rulesStart = HEADER_LEN
  const payloadStart = rulesStart + header.rulesLen
  const macStart = payloadStart + header.payloadLen
  const expectedTotal = macStart + MAC_LEN
  if (totalLength !== undefined && totalLength !== expectedTotal) {
    throw new FormatError('FILE_LENGTH_MISMATCH', `文件长度 ${totalLength} 与头部声明不符（应为 ${expectedTotal}）`)
  }
  return { rulesStart, payloadStart, macStart, expectedTotal }
}

/** 组装完整文件：头部 + 规则块 + 载荷 + 末尾 MAC。 */
export function assembleFile({ header, rules, payload, mac }) {
  if (!(rules instanceof Uint8Array)) throw new FormatError('RULES_INVALID', '规则块必须是字节串')
  if (!(payload instanceof Uint8Array)) throw new FormatError('PAYLOAD_INVALID', '载荷必须是字节串')
  if (!(mac instanceof Uint8Array) || mac.length !== MAC_LEN) {
    throw new FormatError('MAC_INVALID', `MAC 必须是 ${MAC_LEN} 字节`)
  }
  const withLen = defaultHeader({ ...header, rulesLen: rules.length, payloadLen: payload.length })
  const head = serializeHeader(withLen)
  const out = new Uint8Array(head.length + rules.length + payload.length + MAC_LEN)
  let off = 0
  out.set(head, off)
  off += head.length
  out.set(rules, off)
  off += rules.length
  out.set(payload, off)
  off += payload.length
  out.set(mac, off)
  return { bytes: out, header: withLen }
}

/** 把完整文件拆成四段（供校验与解密使用）。 */
export function splitFile(bytes) {
  const header = parseHeader(bytes)
  const layout = fileLayout(header, bytes.length)
  return {
    header,
    layout,
    rules: bytes.slice(layout.rulesStart, layout.payloadStart),
    payload: bytes.slice(layout.payloadStart, layout.macStart),
    mac: bytes.slice(layout.macStart, layout.macStart + MAC_LEN),
    /** MAC 覆盖的字节 = 除末尾 MAC 自身以外的全部内容 */
    macCovered: bytes.slice(0, layout.macStart),
  }
}

export { ENDIAN, RULES_LEN_LEN, TIMESTAMP_LEN }
