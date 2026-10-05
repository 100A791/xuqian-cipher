/**
 * 加密声明（banner）—— 明文前导区。
 *
 * 设计（按用户要求：先加密内容，再把声明以明文写进文件最开头；解密时先去声明再解密容器）：
 *
 *   .XUQIAN 文件 = [明文声明前导区] ‖ [加密容器]
 *
 *   前导区布局（全部明文，不需要密钥即可读）：
 *     偏移 0   "XUQIAN"          6 字节，与容器同一个魔数
 *     偏移 6   0x02              1 字节标记：2 = 有明文声明前导区（容器自身 version 是 1）
 *     偏移 7   声明字节数          4 字节大端
 *     偏移 11  声明正文（UTF-8）    N 字节
 *     偏移 11+N 开始是加密容器
 *
 * 为什么这样设计：
 * - **明文可读**：收件人用任意文本编辑器打开文件，第一屏就是完整声明，无需密钥。
 * - **不可删去（密码学强制）**：容器头部 meta 里记录了声明的 SHA-256（`nh`）与字节数（`nl`），
 *   二者都参与 AAD。所以把前导区删掉、改字、换内容，都会让解密失败——不是"工具不给选项"，
 *   而是**真的解不开**。
 * - **解密顺序正确**：解密端先读前导区、校验声明哈希，再从 `11+N` 处开始解密容器。
 *
 * 向后兼容：更早版本把声明**前置在加密内容里**（`meta.nl` 表示内容开头的声明长度，`meta.no` 存文本）。
 * 那种文件没有前导区（偏移 6 是 1），解密时仍走旧的"解密后剥离"路径。两条路径按偏移 6 的标记区分。
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from './encoding.ts'
import { utf8ToBytes } from './zeroize.ts'
import type { XuqianMeta } from './container.ts'

/** 声明正文的字节上限（防止把文件头撑得过大）。 */
export const BANNER_MAX_BYTES = 4096

/** 前导区里偏移 6 的标记字节。容器自身的 version 为 1，故 2 可区分。 */
export const PREAMBLE_MARKER = 2
/** 前导区固定部分长度：魔数 6 + 标记 1 + 长度 4。 */
export const PREAMBLE_HEADER_LEN = 11
/** 容器魔数（与 container.ts 的 MAGIC 一致；此处内联避免循环依赖）。 */
const MAGIC = 'XUQIAN'
const MAGIC_BYTES = utf8ToBytes(MAGIC)

/** 默认声明（中文界面）。 */
export const DEFAULT_BANNER_ZH = [
  'XUQIAN 认证加密文件 ｜ 由 XUQIAN 加密站（许七安密匣）在本地浏览器生成，文件与密钥从未上传。',
  '以下内容是加密的：没有密钥无法读取，也无法伪造或选择性篡改；任何字节改动都会导致解密失败。',
  '这段声明是明文，写在密文的最开头；它被记入加密头部的哈希，删掉或改写它同样会导致解密失败。',
  '密钥不在本文件内，需由发送方另行提供；密钥丢失无法恢复。',
].join('\n')

/** 默认声明（英文界面）。 */
export const DEFAULT_BANNER_EN = [
  'XUQIAN authenticated-encrypted file | produced locally in-browser by XUQIAN Cipher Station; file and key were never uploaded.',
  'The content below is encrypted: unreadable without the key, and impossible to forge or selectively tamper with; any byte change makes decryption fail.',
  'This notice is plaintext at the very start of the file. Its hash is recorded in the encrypted header, so deleting or editing it also makes decryption fail.',
  'The key is not inside this file and must be provided separately by the sender. A lost key cannot be recovered.',
].join('\n')

export function defaultBanner(lang: 'zh' | 'en'): string {
  return lang === 'en' ? DEFAULT_BANNER_EN : DEFAULT_BANNER_ZH
}

/**
 * 规范化声明文本：去掉首尾空白；**留空则回退默认文本**（这样"不写声明"就不是一个可选项）。
 * 超长会抛错而不是静默截断，避免用户以为自己写的内容被完整写入了。
 */
export function normalizeBannerText(text: string | undefined, fallback: string): { text: string; bytes: Uint8Array } {
  const trimmed = (text ?? '').trim()
  const chosen = trimmed.length > 0 ? trimmed : fallback
  const bytes = utf8ToBytes(chosen)
  if (bytes.length > BANNER_MAX_BYTES) {
    throw new Error('BANNER_TOO_LONG')
  }
  return { text: chosen, bytes }
}

/** 声明正文的 SHA-256（大写 Hex）。写进容器头部并被 AAD 覆盖。 */
export function noticeHash(noticeBytes: Uint8Array): string {
  return bytesToHex(sha256(noticeBytes)).toUpperCase()
}

/** 构造明文前导区：魔数 + 标记 + 长度 + 声明正文。 */
export function buildPreamble(noticeBytes: Uint8Array): Uint8Array {
  if (noticeBytes.length === 0) throw new Error('BANNER_EMPTY')
  if (noticeBytes.length > BANNER_MAX_BYTES) throw new Error('BANNER_TOO_LONG')
  const out = new Uint8Array(PREAMBLE_HEADER_LEN + noticeBytes.length)
  out.set(MAGIC_BYTES, 0)
  out[6] = PREAMBLE_MARKER
  new DataView(out.buffer).setUint32(7, noticeBytes.length)
  out.set(noticeBytes, PREAMBLE_HEADER_LEN)
  return out
}

export interface ParsedPreamble {
  noticeText: string
  noticeBytes: Uint8Array
  /** 加密容器在文件中的起始偏移 */
  containerOffset: number
}

/**
 * 读取文件开头的明文前导区。
 * 返回 null 表示这不是"带明文声明"的文件（即旧格式容器，声明在加密内容里或没有声明）。
 */
export function readPreamble(file: Uint8Array): ParsedPreamble | null {
  if (file.length < PREAMBLE_HEADER_LEN) return null
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (file[i] !== MAGIC_BYTES[i]) return null
  if (file[6] !== PREAMBLE_MARKER) return null
  const noticeLen = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(7)
  if (noticeLen <= 0) throw new Error('BANNER_LENGTH_INVALID')
  if (noticeLen > BANNER_MAX_BYTES) throw new Error('BANNER_TOO_LONG')
  const end = PREAMBLE_HEADER_LEN + noticeLen
  if (file.length < end) throw new Error('BANNER_TRUNCATED')
  const noticeBytes = file.subarray(PREAMBLE_HEADER_LEN, end)
  return {
    noticeText: new TextDecoder().decode(noticeBytes),
    noticeBytes,
    containerOffset: end,
  }
}

/** 从加密头部取出声明校验信息（新格式）。 */
export function noticeExpectation(meta: XuqianMeta): { length: number; hash: string } | null {
  const hash = typeof meta.nh === 'string' ? meta.nh.toUpperCase() : null
  if (!hash) return null
  return { length: typeof meta.nl === 'number' ? meta.nl : 0, hash }
}

// ---------------------------------------------------------------------------
// 旧格式兼容：声明曾被前置在**加密内容内部**，解密后剥离
// ---------------------------------------------------------------------------

export interface StrippedPayload {
  content: Uint8Array
  bannerBytes: number
}

/**
 * 剥离"加密内容内部前置的声明"（仅旧格式文件需要）。
 * 长度来源：meta.nl（权威）；若无 nl 但有 no，则用 no 的 UTF-8 字节数推导。
 */
export function stripBanner(payload: Uint8Array, meta: XuqianMeta): StrippedPayload {
  const declaredText = typeof meta.no === 'string' && meta.no.length > 0 ? meta.no : null

  let declared = meta.nl
  if ((declared === undefined || declared === null) && declaredText !== null) {
    declared = utf8ToBytes(declaredText).length
  }
  if (declared === undefined || declared === null) {
    return { content: payload, bannerBytes: 0 }
  }
  if (!Number.isSafeInteger(declared) || declared <= 0) throw new Error('BANNER_LENGTH_INVALID')
  if (declared > payload.length) throw new Error('BANNER_TRUNCATED')

  if (declaredText !== null) {
    const expected = utf8ToBytes(declaredText)
    if (expected.length !== declared) throw new Error('BANNER_MISMATCH')
    for (let i = 0; i < declared; i++) {
      if (payload[i] !== expected[i]) throw new Error('BANNER_MISMATCH')
    }
  }
  return { content: payload.subarray(declared), bannerBytes: declared }
}

/** 最小字节汇接口（与 stream.ts 的 ByteSink 结构兼容，避免循环依赖）。 */
interface WritableSink {
  write(chunk: Uint8Array): void | Promise<void>
}

/** 流式剥离：把前 `skip` 字节丢掉，其余原样转发（旧格式大文件解密用）。 */
export function bannerSkippingSink(sink: WritableSink, skip: number): WritableSink {
  let remaining = Math.max(0, skip)
  return {
    async write(chunk) {
      if (remaining > 0) {
        if (chunk.length <= remaining) {
          remaining -= chunk.length
          return
        }
        const rest = chunk.subarray(remaining)
        remaining = 0
        await sink.write(rest)
        return
      }
      await sink.write(chunk)
    },
  }
}

/** 流式跳过开头 `skip` 字节（新格式：跳过明文前导区后再解容器）。 */
export function skippingSource(source: AsyncIterable<Uint8Array>, skip: number): AsyncIterable<Uint8Array> {
  if (skip <= 0) return source
  const inner = source
  return {
    async *[Symbol.asyncIterator]() {
      let remaining = skip
      for await (const chunk of inner) {
        if (remaining > 0) {
          if (chunk.length <= remaining) {
            remaining -= chunk.length
            continue
          }
          yield chunk.subarray(remaining)
          remaining = 0
          continue
        }
        yield chunk
      }
    },
  }
}
