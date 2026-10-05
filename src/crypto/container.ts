/**
 * .XUQIAN v1 容器格式实现。
 *
 * 设计目标：
 * 1) 文件头明文可读（算法、层数、原文件信息、哈希），但绝不含任何密钥材料。
 * 2) 元数据（原始文件名 / 时间戳 / 哈希 / 备注）全部纳入 AAD 认证，篡改即解密失败。
 * 3) 分块处理：每块独立 nonce、独立认证，内存占用与文件大小解耦。
 * 4) 每层算法独立派生 HKDF 子密钥，解密必须严格逆序。
 *
 * 线格式（Wire Format）
 * ---------------------------------------------------------------------------
 *  偏移          长度        内容
 *  0             6           魔数 "XUQIAN"
 *  6             1           版本号 (v = 1)
 *  7             1           标志位 (bit1 = 明文在加密前经过 gzip)
 *  8             4           分块密文上限 chunkSize (uint32 BE)
 *  12            4           分块数量 chunkCount (uint32 BE)
 *  16            1           加密层数 layerCount (1..10)
 *  17            4           headerJson 长度 (uint32 BE)
 *  21            N           headerJson（UTF-8 JSON，含 layers/meta/crc）
 *  21+N          ...         块区（chunkCount 个块首尾相接）
 *
 * 单块布局（L 层，pj = 该块明文长度，T = 16）：
 *   headLen = pj + L×T        —— 第 L−1 层（最外层）的完整 AEAD 输出
 *   块总长  = pj + (2L−1)×T
 *
 *   [ 第 L−1 层输出: 密文(pj+(L−1)T) + tag_{L−1}(T) ][ tag_0 ][ tag_1 ] … [ tag_{L−2} ]
 *
 * 解密顺序（严格逆序）：
 *   1) 取块前 headLen−T 作为 payload，块 [headLen−T, headLen) 是第 L−1 层 tag → 解出第 L−2 层输出
 *   2) 第 k 层的 tag 位于块偏移 headLen + k×T（k = L−2 … 0）
 *   3) 第 k 层的输入 = 第 k 层输出的前 pj + k×T 字节
 * 最终解出 pj 字节明文。
 *
 * 为什么是这种布局：AEAD 每次加密都把 T 字节 tag 追加到输出末尾，第 k 层输入长度为
 * pj + k×T、输出为 pj + (k+1)×T，因此每一层的 tag 都"内嵌"在下一层输入的末尾。
 * 块内只额外保存第 0…L−2 层的 tag（各 T 字节），第 L−1 层的 tag 已经在 head 末尾。
 */
import { getAlgoSpec, isAlgoId, type AlgoId } from './aead.ts'
import { concatBytes, base64ToBytes } from './encoding.ts'
import { MasterKey, SALT_BYTES } from './keys.ts'
import { utf8ToBytes } from './zeroize.ts'
import { bufferSource, collectingSink, decryptStream, encryptStream } from './stream.ts'

export const MAGIC = 'XUQIAN'
export const MAGIC_BYTES = utf8ToBytes(MAGIC)
export const FORMAT_VERSION = 1
export const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024 // 64 MiB
export const MAX_LAYERS = 10
export const MIN_LAYERS = 1
export const EXT_ENCRYPTED = '.XUQIAN'
export const EXT_KEYFILE = '.XUQIANKEY'
export const TAG_BYTES = 16

export const HEADER_FLAG_GZIP = 2 // 明文在加密前做过 gzip

/** 固定头长度（到 layerCount 为止，不含 headerLen 与 headerJson）。 */
export const HEADER_FIXED_LEN = MAGIC_BYTES.length + 1 + 1 + 4 + 4 + 1
/** headerLen 字段所在固定偏移。 */
export const HEADER_LEN_OFFSET = HEADER_FIXED_LEN
/** 最小合法文件头长度。 */
export const HEADER_MIN_LEN = HEADER_FIXED_LEN + 4 + 1

/** 非机密元数据。会整体参与 AAD 认证，因此可自由扩展字段。 */
export interface XuqianMeta {
  /** 原始文件名（解密后还原） */
  n?: string
  /** 原始 MIME */
  m?: string
  /** 容器内明文字节数（分块布局依赖它，解密时用于精确还原边界） */
  s?: number
  /** 容器内明文 SHA-256（hex 大写） */
  h?: string
  /** 创建时间（epoch ms） */
  t?: number
  /** 内容类型：bytes | text */
  k?: 'bytes' | 'text'
  /** 原始（解压前）字节数，仅在启用 gzip 时与 s 不同 */
  os?: number
  /** 用户备注 */
  c?: string
  /** 明文声明的 UTF-8 字节数。
   *  新格式：明文前导区里声明的长度（供校验）；
   *  旧格式：加密内容开头前置声明的长度（供解密后剥离）。 */
  nl?: number
  /** 明文声明的 SHA-256（大写 Hex，仅新格式）。
   *  写在**加密**头部并参与 AAD → 改动或删除明文声明都会导致解密失败。 */
  nh?: string
  /** 加密声明文本（**仅旧格式**：声明曾前置在加密内容内部，此处存其原文） */
  no?: string
  /** 到期提醒时间（epoch ms，纯提示） */
  exp?: number
  /** 伪装扩展名提示（P2） */
  as?: string
}

export interface XuqianLayerHeader {
  /** 算法 ID */
  a: AlgoId
  /** 本层 HKDF salt（base64，16 字节） */
  s: string
  /** 本层分块 nonce 种子（base64，16 字节） */
  n: string
}

export interface XuqianHeader {
  v: number
  flags: number
  /** 分块密文上限 */
  cs: number
  /** 分块数量（1 表示未分块） */
  cc: number
  /** 加密层数 = layers.length */
  lc: number
  /** 层数组，顺序 = 加密顺序；解密必须逆序 */
  layers: XuqianLayerHeader[]
  meta: XuqianMeta
  /** 头部完整性校验（CRC32，覆盖除 crc 外的全部头部字段） */
  crc: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 头部规范化字节：用于 CRC 与 AAD。字段顺序固定、无空白。 */
function canonicalHeader(header: XuqianHeader): Uint8Array {
  return utf8ToBytes(
    JSON.stringify({
      v: header.v,
      flags: header.flags,
      cs: header.cs,
      cc: header.cc,
      lc: header.lc,
      layers: header.layers.map((l) => ({ a: l.a, s: l.s, n: l.n })),
      meta: header.meta,
    }),
  )
}

export function computeHeaderCrc(header: XuqianHeader): number {
  return crc32(canonicalHeader(header))
}

/** 算法 ID 的稳定字节编号（写入 AAD，顺序不可随意调整）。 */
const ALG_BYTE: Record<AlgoId, number> = {
  'AES-128-GCM': 0,
  'AES-256-GCM': 1,
  'CHACHA20-POLY1305': 2,
  'XCHACHA20-POLY1305': 3,
  'SM4-GCM': 4,
}

/**
 * AAD = magic || v || flags || cs(4) || cc(4) || lc || algBytes[lc] || headerLen(4) || canonicalHeader
 * canonicalHeader 含 meta，因此原始文件名/时间/哈希/备注全部被认证。
 */
export function buildAad(header: XuqianHeader, canonical: Uint8Array): Uint8Array {
  const fixedLen = MAGIC_BYTES.length + 1 + 1 + 4 + 4 + 1 + header.layers.length + 4
  const fixed = new Uint8Array(fixedLen)
  let off = 0
  fixed.set(MAGIC_BYTES, off)
  off += MAGIC_BYTES.length
  fixed[off++] = header.v
  fixed[off++] = header.flags
  const view = new DataView(fixed.buffer)
  view.setUint32(off, header.cs)
  off += 4
  view.setUint32(off, header.cc)
  off += 4
  fixed[off++] = header.lc
  for (const layer of header.layers) fixed[off++] = ALG_BYTE[layer.a] ?? 0xff
  view.setUint32(off, canonical.length)
  return concatBytes(fixed, canonical)
}

export function headerAad(header: XuqianHeader): Uint8Array {
  return buildAad(header, canonicalHeader(header))
}

/**
 * 序列化为完整文件头字节。
 *
 * 磁盘上的 JSON 采用「人可读」排布：缩进 2 空格、`meta` 提到最前、`meta.no`（加密声明）再最前。
 * 这样用任意文本编辑器打开 .XUQIAN，紧跟在 `XUQIAN` 魔数与 15 字节定长字段之后，
 * 就能直接读到完整的声明与元信息，而不是一大坨单行 JSON。
 *
 * 为什么这样排不影响兼容性（已用实验验证，见 docs/FORMAT.md §2.2）：
 * AAD 与 CRC 都由 `canonicalHeader()` 计算，而它是**重建**一个固定字段顺序的对象，
 * 其中 `layers` 也是重建的；因此磁盘上的空白排版与**顶层**键顺序都不进入认证。
 * 唯一例外是 `meta` 的**内部**键顺序会被原样序列化进 AAD —— 所以这里只调整顶层顺序，
 * 并只在「新建文件」时让 no/nl 排在 meta 最前（已存在的旧文件保持其原顺序，仍可正常解密）。
 */
export function serializeHeader(header: XuqianHeader): Uint8Array {
  const crc = computeHeaderCrc(header)
  // 磁盘排布：只把 meta 提到顶层最前（顶层顺序不参与 AAD/CRC，安全），
  // **meta 内部键顺序必须原样保留** —— 它按引用参与 canonicalHeader，
  // 一旦在磁盘上重排，解析回来的 canonical 就会与写入时不同，导致自身 CRC 校验失败。
  // 想让声明排在 meta 最前，应在上游构造 meta 时就把它放前面（见 worker / CLI）。
  const readable = {
    meta: header.meta ?? {},
    v: header.v,
    flags: header.flags,
    cs: header.cs,
    cc: header.cc,
    lc: header.lc,
    layers: header.layers,
    crc,
  }
  const json = utf8ToBytes(JSON.stringify(readable, null, 2))
  const out = new Uint8Array(HEADER_FIXED_LEN + 4 + json.length)
  let off = 0
  out.set(MAGIC_BYTES, off)
  off += MAGIC_BYTES.length
  out[off++] = header.v
  out[off++] = header.flags
  const view = new DataView(out.buffer)
  view.setUint32(off, header.cs)
  off += 4
  view.setUint32(off, header.cc)
  off += 4
  out[off++] = header.lc
  view.setUint32(off, json.length)
  off += 4
  out.set(json, off)
  return out
}

export class FormatError extends Error {
  constructor(message = 'FORMAT_INVALID') {
    super(message)
    this.name = 'FormatError'
  }
}

export class PasswordRequiredError extends Error {
  constructor() {
    super('PASSWORD_REQUIRED')
    this.name = 'PasswordRequiredError'
  }
}

/** 快速嗅探：字节流是否以 XUQIAN 魔数开头。 */
export function hasMagic(head: Uint8Array): boolean {
  if (head.length < MAGIC_BYTES.length) return false
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (head[i] !== MAGIC_BYTES[i]) return false
  return true
}

export interface ParsedHeader {
  header: XuqianHeader
  /** 头部总字节数（固定头 + headerLen + headerJson） */
  headerLength: number
}

/** 解析文件头。head 必须覆盖完整文件头。 */
export function parseHeader(head: Uint8Array): ParsedHeader {
  if (!hasMagic(head)) throw new FormatError('MAGIC_MISMATCH')
  if (head.length < HEADER_MIN_LEN) throw new FormatError('HEADER_TRUNCATED')
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  let off = MAGIC_BYTES.length
  const version = head[off++]
  const flags = head[off++]
  if (version !== FORMAT_VERSION) throw new FormatError('VERSION_UNSUPPORTED')
  const chunkSize = view.getUint32(off)
  off += 4
  const chunkCount = view.getUint32(off)
  off += 4
  const layerCount = head[off++]
  const jsonLen = view.getUint32(HEADER_LEN_OFFSET)
  off += 4
  const headerLength = HEADER_FIXED_LEN + 4 + jsonLen
  if (jsonLen <= 0 || headerLength > head.length) throw new FormatError('HEADER_TRUNCATED')
  const jsonBytes = head.subarray(off, off + jsonLen)
  let parsed: XuqianHeader
  try {
    parsed = JSON.parse(new TextDecoder().decode(jsonBytes)) as XuqianHeader
  } catch {
    throw new FormatError('HEADER_JSON_INVALID')
  }
  validateHeader(parsed, { version, flags, chunkSize, chunkCount, layerCount })
  if (computeHeaderCrc(parsed) !== parsed.crc) throw new FormatError('HEADER_CRC_MISMATCH')
  return { header: parsed, headerLength }
}

function validateHeader(
  h: XuqianHeader,
  fixed: { version: number; flags: number; chunkSize: number; chunkCount: number; layerCount: number },
): void {
  if (!h || typeof h !== 'object') throw new FormatError('HEADER_INVALID')
  if (h.v !== fixed.version || h.flags !== fixed.flags) throw new FormatError('HEADER_INVALID')
  if (h.cs !== fixed.chunkSize || h.cc !== fixed.chunkCount || h.lc !== fixed.layerCount) throw new FormatError('HEADER_INVALID')
  if (!Array.isArray(h.layers) || h.layers.length !== h.lc) throw new FormatError('HEADER_INVALID')
  if (h.lc < MIN_LAYERS || h.lc > MAX_LAYERS) throw new FormatError('LAYER_COUNT_INVALID')
  if (!Number.isSafeInteger(h.cc) || h.cc < 1) throw new FormatError('CHUNK_COUNT_INVALID')
  if (!Number.isSafeInteger(h.cs) || h.cs < 1) throw new FormatError('CHUNK_SIZE_INVALID')
  for (const layer of h.layers) {
    if (!isAlgoId(layer.a)) throw new FormatError('UNSUPPORTED_ALGORITHM')
    if (base64ToBytes(layer.s).length !== SALT_BYTES) throw new FormatError('SALT_INVALID')
    if (base64ToBytes(layer.n).length !== SALT_BYTES) throw new FormatError('NONCE_SEED_INVALID')
  }
  if (!h.meta || typeof h.meta !== 'object') throw new FormatError('HEADER_INVALID')
  if (!Number.isSafeInteger(h.meta.s) || (h.meta.s as number) < 0) throw new FormatError('META_SIZE_INVALID')
}

/** 每块需要为所有层保存的 tag 总字节数。 */
export function tagBytesForLayers(layers: XuqianLayerHeader[]): number {
  let total = 0
  for (const l of layers) total += getAlgoSpec(l.a).tagLength
  return total
}

/** 单块内密文主体长度 = 明文长度 + (层数−1)×16。 */
export function bodyCipherLenOf(plainLen: number, layerCount: number): number {
  return plainLen + (layerCount - 1) * TAG_BYTES
}

/**
 * 每块在文件中占用的字节数（L 层，pj = 该块明文长度，T = 16）。
 *
 * 块内布局：
 *   [ 第 L−1 层完整 AEAD 输出：headLen = pj + (L−1)T 的密文 + T 的 tag ]
 *   [ tag_0 ] [ tag_1 ] ... [ tag_{L−2} ]
 * 合计 = pj + (2L−1)×T。
 */
export function blockTotalOf(plainLen: number, layerCount: number): number {
  return plainLen + (2 * layerCount - 1) * TAG_BYTES
}

/** 块内"最后一层输出"的长度（密文 + 其 tag）。 */
export function headLenOf(plainLen: number, layerCount: number): number {
  return plainLen + layerCount * TAG_BYTES
}

/** 每块可承载的明文长度（= 密文上限 − 所有层 tag）。 */
export function plainChunkSizeOf(chunkSize: number, layerCount: number): number {
  return chunkSize - layerCount * TAG_BYTES
}

/**
 * 由明文总长度推算分块布局；加密端与解密端共用，保证边界严格一致。
 */
export function planChunks(
  plaintextLength: number,
  chunkSize: number,
  layerCount: number,
): ChunkPlan {
  const layers = Math.max(1, layerCount)
  const plainChunkSize = plainChunkSizeOf(chunkSize, layers)
  if (plainChunkSize < 1) throw new FormatError('CHUNK_SIZE_INVALID')
  const plainSizes: number[] = []
  if (plaintextLength === 0) {
    plainSizes.push(0)
  } else {
    for (let off = 0; off < plaintextLength; off += plainChunkSize) {
      plainSizes.push(Math.min(plainChunkSize, plaintextLength - off))
    }
  }
  return {
    chunkCount: plainSizes.length,
    plainSizes,
    bodyCipherLengths: plainSizes.map((s) => bodyCipherLenOf(s, layers)),
    blockTotals: plainSizes.map((s) => blockTotalOf(s, layers)),
  }
}

/**
 * 块区总长度（= 文件总长 − 头部）。
 * 文件总长 = 头部 + Σ blockTotals。
 */
export function bodyLengthOf(fileSize: number, header: XuqianHeader, headerLength: number): number {
  const pure = fileSize - headerLength - header.cc * header.layers.length * TAG_BYTES
  if (pure < 0) throw new FormatError('BODY_TRUNCATED')
  return pure
}

/** 分块规划结果。 */
export interface ChunkPlan {
  chunkCount: number
  plainSizes: number[]
  bodyCipherLengths: number[]
  blockTotals: number[]
}

// ---------------------------------------------------------------------------
// 加解密引擎
// ---------------------------------------------------------------------------

export interface EngineOptions {
  layers: AlgoId[]
  chunkSize?: number
  gzip?: boolean
  meta?: XuqianMeta
  onProgress?: (doneBytes: number, totalBytes: number, phase: 'encrypt' | 'decrypt') => void
  /** 随机字节源（默认 CSPRNG；测试可注入确定性序列以获得可复现的密文） */
  randomFn?: (length: number) => Uint8Array
}

export interface EncryptResult {
  pieces: Uint8Array[]
  /** 容器内明文字节数 */
  totalBytes: number
  header: XuqianHeader
  /** 容器内明文的 SHA-256（hex 大写） */
  sourceHash: string
  outputSize: number
}

/**
 * 内存适配器：把整份明文交给流式引擎，并把输出块收集回内存。
 *
 * 真正的实现见 src/crypto/stream.ts。这样做的好处是"只有一份加密实现"，
 * 浏览器内存路径、浏览器流式落盘路径、命令行工具全部共用同一套字节，
 * 因此三种途径产出的 .XUQIAN 一定可以互解。
 */
export async function encryptContainer(
  plaintext: Uint8Array,
  masterKey: MasterKey,
  options: EngineOptions,
): Promise<EncryptResult> {
  const collected = collectingSink()
  const result = await encryptStream(bufferSource([plaintext]), collected.sink, masterKey, {
    layers: options.layers,
    plaintextLength: plaintext.length,
    chunkSize: options.chunkSize,
    gzip: options.gzip,
    meta: options.meta,
    onProgress: options.onProgress
      ? (done, total) => options.onProgress?.(done, total, 'encrypt')
      : undefined,
    randomFn: options.randomFn,
    // 保持旧语义：哈希永远取自实际内容，忽略调用方传入的 meta.h
    forceHashScan: true,
  })
  return {
    pieces: collected.parts,
    totalBytes: plaintext.length,
    header: result.header,
    sourceHash: result.sourceHash,
    outputSize: result.outputSize,
  }
}

/**
 * 内存适配器：解密整份 .XUQIAN 字节。
 * 任何认证失败统一为 AUTH_FAILED，不泄露具体层与原因。
 */
export async function decryptContainer(
  fileBytes: Uint8Array,
  masterKey: MasterKey,
  onProgress?: (done: number, total: number) => void,
): Promise<{ plaintext: Uint8Array; header: XuqianHeader }> {
  const collected = collectingSink()
  const result = await decryptStream(bufferSource([fileBytes]), collected.sink, masterKey, onProgress)
  return { plaintext: concatBytes(...collected.parts), header: result.header }
}

/** 从头部读取原文件哈希（可能不存在）。 */
export function metaHash(header: XuqianHeader): string | undefined {
  const h = header.meta?.h
  return typeof h === 'string' && h.length > 0 ? h : undefined
}

/** 把文件头转成人类可读的键值列表（供 UI 显示）。 */
export function describeHeader(header: XuqianHeader): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [
    { key: 'format', value: `XUQIAN v${header.v}` },
    { key: 'layers', value: String(header.lc) },
    { key: 'algorithms', value: header.layers.map((l) => l.a).join(' → ') },
    { key: 'chunks', value: `${header.cc} × ${header.cs} B` },
    { key: 'flags', value: header.flags & HEADER_FLAG_GZIP ? 'gzip' : '-' },
    { key: 'headerCrc', value: `0x${header.crc.toString(16).padStart(8, '0')}` },
  ]
  const meta = header.meta ?? {}
  if (meta.n) rows.push({ key: 'originalName', value: meta.n })
  if (meta.m) rows.push({ key: 'originalMime', value: meta.m })
  if (typeof meta.s === 'number') rows.push({ key: 'originalSize', value: `${meta.s} B` })
  if (meta.h) rows.push({ key: 'sha256', value: meta.h })
  if (typeof meta.t === 'number') rows.push({ key: 'createdAt', value: new Date(meta.t).toISOString() })
  if (meta.k) rows.push({ key: 'contentKind', value: meta.k })
  if (typeof meta.exp === 'number') rows.push({ key: 'expiresAt', value: new Date(meta.exp).toISOString() })
  if (typeof meta.nl === 'number' && meta.nl > 0) {
    rows.push({ key: 'noticeBytes', value: `${meta.nl} B（解密时自动剥离）` })
  }
  if (typeof meta.no === 'string' && meta.no.length > 0) {
    // 声明本身是明文可读的（也在密文内容开头），收件人不用密钥就能在这里看到
    rows.push({ key: 'notice', value: meta.no })
  }
  return rows
}

/** 输出文件名：原文件名 + .XUQIAN（已带后缀则不重复添加）。 */
export function encryptedFileName(originalName: string): string {
  const base = originalName.replace(/\\/g, '/').split('/').pop() || 'file'
  if (base.toUpperCase().endsWith(EXT_ENCRYPTED)) return base
  return base + EXT_ENCRYPTED
}

/** 还原原始文件名。 */
export function originalFileName(encryptedName: string, header?: XuqianHeader): string {
  if (header?.meta?.n) return header.meta.n
  const base = encryptedName.replace(/\\/g, '/').split('/').pop() || 'file'
  if (base.toUpperCase().endsWith(EXT_ENCRYPTED)) return base.slice(0, -EXT_ENCRYPTED.length)
  return base + '.decrypted'
}

/** 头部 JSON（供 UI 展示"可见但无密钥"的文件头）。 */
export function headerToJson(header: XuqianHeader): string {
  return JSON.stringify(header, null, 2)
}
