/**
 * 加密 Worker：主线程与密钥的唯一交互通道。
 *
 * 为什么用 Worker（对应验收标准 15–19）：
 * - 主密钥的权威副本只存在于此 Worker 的 Uint8Array 中，主线程永远拿不到长期持有的密钥对象。
 * - 关闭密钥弹窗时主线程发送 `key-destroy`，Worker 覆写字节并释放引用；此后任何取用都会失败。
 * - 刷新或关闭页面会销毁整个 Worker 及其内存，密钥不可能恢复。
 *
 * 安全边界（如实告知）：JavaScript 字符串无法擦除，因此 Hex/Base64 文本副本在弹窗关闭后
 * 只能依赖 GC 回收。本设计把"权威密钥"与"展示文本"分离，尽量缩短不可控副本的生存期。
 */
import { decryptContainer, encryptContainer, type XuqianMeta } from '../crypto/container.ts'
import { bufferSource, keyCheck } from '../crypto/stream.ts'
import {
  buildPreamble,
  defaultBanner,
  normalizeBannerText,
  noticeExpectation,
  noticeHash,
  readPreamble,
  stripBanner,
} from '../crypto/banner.ts'
import type { AlgoId } from '../crypto/aead.ts'
import { MasterKey } from '../crypto/keys.ts'
import { base64ToBytes, bytesToBase64, bytesToHex, concatBytes, hexToBytes } from '../crypto/encoding.ts'
import { zeroize } from '../crypto/zeroize.ts'
import { deflate, inflate } from 'pako'

export interface KeyView {
  hex: string
  base64: string
  fingerprint: string
  bytes: number
}

export type WorkerRequest =
  | { id: number; op: 'key-generate' }
  | { id: number; op: 'key-destroy' }
  | { id: number; op: 'key-view' }
  | { id: number; op: 'key-import'; hex?: string; base64?: string }
  | {
      id: number
      op: 'encrypt'
      bytes: ArrayBuffer
      name: string
      mime?: string
      layers: AlgoId[]
      chunkSize?: number
      gzip?: boolean
      /** 是否加密标识性元数据（原文件名 / MIME / 备注…） */
      encryptMeta?: boolean
      /** 时间戳附加盐（域分离，不提升安全性） */
      timestampSalt?: boolean
      note?: string
      /** 加密声明文本；留空则回退默认声明（声明不可去除） */
      notice?: string
      /** 用于挑选默认声明的语言 */
      lang?: 'zh' | 'en'
      expiresAt?: number
      kind?: 'bytes' | 'text'
    }
  | { id: number; op: 'decrypt'; bytes: ArrayBuffer; verifyHash?: boolean }
  | { id: number; op: 'key-check'; bytes: ArrayBuffer; verifyHash?: boolean }
  | { id: number; op: 'hash'; bytes: ArrayBuffer; algorithms: Array<'SHA-256' | 'SHA-512'> }

export type WorkerResponse =
  | { id: number; op: 'key-generate'; ok: true; fingerprint: string }
  | { id: number; op: 'key-import'; ok: true; fingerprint: string }
  | { id: number; op: 'key-destroy'; ok: true; destroyed: true }
  | { id: number; op: 'key-view'; ok: true; view: KeyView }
  | {
      id: number
      op: 'encrypt'
      ok: true
      bytes: ArrayBuffer
      header: string
      outputSize: number
      fingerprint: string
      sourceHash: string
      storedBytes: number
    }
  | {
      id: number
      op: 'decrypt'
      ok: true
      bytes: ArrayBuffer
      name: string
      mime?: string
      header: string
      kind: 'bytes' | 'text'
      hashMatched: boolean | null
      /** 明文声明的字节数（新格式＝前导区声明长度；旧格式＝解密后剥离掉的字节数） */
      bannerBytes: number
      /** 新格式：从明文前导区读到的声明正文（不经密钥即可读）；旧格式为 null */
      noticeText: string | null
      originalSize?: number
      expiresAt?: number
    }
  | { id: number; op: 'hash'; ok: true; digests: Record<string, string> }
  | {
      id: number
      op: 'key-check'
      ok: true
      matched: boolean
      layers: AlgoId[]
      plaintextLength: number
      declaredHash?: string
      hashVerified: boolean
      /** 当前 Worker 中这把密钥的指纹（供用户与文件头/密钥文件核对） */
      fingerprint: string
      header: string
    }
  | { id: number; op: 'error'; ok: false; error: string }

interface ParsedMetaShape {
  n?: string
  m?: string
  h?: string
  k?: 'bytes' | 'text'
  os?: number
  exp?: number
  nl?: number
  /** 明文声明的 SHA-256（新格式）；存在即表示"文件应带明文前导区" */
  nh?: string
  /** 旧格式：加密内容内部的声明原文 */
  no?: string
}

let masterKey: MasterKey | null = null

function requireKey(): MasterKey {
  if (!masterKey || masterKey.destroyed) throw new Error('KEY_NOT_AVAILABLE')
  return masterKey
}

function destroyKey(): void {
  if (masterKey) {
    masterKey.destroy()
    masterKey = null
  }
}

async function viewOf(key: MasterKey): Promise<KeyView> {
  const bytes = key.clone()
  try {
    return {
      hex: bytesToHex(bytes),
      base64: bytesToBase64(bytes),
      fingerprint: await key.fingerprint(),
      bytes: bytes.length,
    }
  } finally {
    zeroize(bytes)
  }
}

/** 统一错误：绝不区分"密钥错误"与"文件损坏"。 */
function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  switch (message) {
    case 'AUTH_FAILED':
      return 'AUTH_FAILED'
    case 'KEY_NOT_AVAILABLE':
    case 'KEY_DESTROYED':
      return 'KEY_NOT_AVAILABLE'
    case 'LAYER_COUNT_INVALID':
    case 'UNSUPPORTED_ALGORITHM':
    case 'INVALID_MASTER_KEY_LENGTH':
    case 'INVALID_HEX':
    case 'INVALID_BASE64':
    case 'CSPRNG_UNAVAILABLE':
      return message
    default:
      if (/^(HEADER_|MAGIC_|BODY_|TAG_|CHUNK_|FORMAT_|PLAINTEXT_|META_|SALT_|NONCE_)/.test(message))
        return 'FORMAT_INVALID'
      return 'UNKNOWN'
  }
}

async function digestFor(algo: 'SHA-256' | 'SHA-512', bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const buf = await globalThis.crypto.subtle.digest(algo, source)
  return bytesToHex(new Uint8Array(buf)).toUpperCase()
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  switch (request.op) {
    case 'key-generate': {
      destroyKey()
      masterKey = MasterKey.generate()
      return { id: request.id, op: 'key-generate', ok: true, fingerprint: await masterKey.fingerprint() }
    }

    case 'key-import': {
      destroyKey()
      const bytes = request.hex ? hexToBytes(request.hex) : base64ToBytes(request.base64 ?? '')
      try {
        masterKey = MasterKey.fromBytes(bytes)
      } finally {
        zeroize(bytes)
      }
      return { id: request.id, op: 'key-import', ok: true, fingerprint: await masterKey.fingerprint() }
    }

    case 'key-view': {
      return { id: request.id, op: 'key-view', ok: true, view: await viewOf(requireKey()) }
    }

    case 'key-destroy': {
      destroyKey()
      return { id: request.id, op: 'key-destroy', ok: true, destroyed: true }
    }

    case 'encrypt': {
      const key = requireKey()
      const payload = new Uint8Array(request.bytes)
      const originalSize = payload.length
      const gzipped = request.gzip === true
      const compressed = gzipped ? deflate(payload) : payload
      // 加密声明：**明文**写在文件最开头（前导区），其长度与 SHA-256 写进加密头部参与 AAD。
      // 顺序是"先加密内容、再把声明以明文加到文件前面"；解密时先校验并跳过前导区，再解容器。
      const banner = normalizeBannerText(request.notice, defaultBanner(request.lang ?? 'zh'))
      const meta: XuqianMeta = {
        // 声明信息排在最前：磁盘头部 JSON 中 meta 又位于顶层最前，便于人工查看。
        // 注意 meta 的键顺序会原样进入 AAD/CRC，改动顺序等于换格式，勿随意调整。
        nl: banner.bytes.length,
        nh: noticeHash(banner.bytes),
        n: request.name,
        m: request.mime,
        k: request.kind ?? 'bytes',
        t: Date.now(),
        c: request.note,
        exp: request.expiresAt,
        os: gzipped ? originalSize : undefined,
      }
      const result = await encryptContainer(compressed, key, {
        layers: request.layers,
        chunkSize: request.chunkSize,
        gzip: gzipped,
        meta,
        encryptMeta: request.encryptMeta === true,
        timestampSalt: request.timestampSalt === true,
      })
      // 容器 → 前面再拼上明文前导区
      const file = concatBytes(buildPreamble(banner.bytes), concatBytes(...result.pieces))
      const storedBytes = compressed.length
      if (compressed !== payload) zeroize(compressed)
      zeroize(payload)
      return {
        id: request.id,
        op: 'encrypt',
        ok: true,
        bytes: toArrayBuffer(file),
        header: JSON.stringify(result.header),
        outputSize: result.outputSize,
        fingerprint: await key.fingerprint(),
        sourceHash: result.sourceHash,
        storedBytes,
      }
    }

    case 'decrypt': {
      const key = requireKey()
      const fileBytes = new Uint8Array(request.bytes)

      // 第一步（解密之前）：读明文前导区，校验它有没有被改动或删掉。
      // 这是"先去掉明文再解密"的正确顺序。
      let noticeText: string | null = null
      let noticeBytes = 0
      let legacyBannerBytes = 0
      const preamble = readPreamble(fileBytes)
      const container = preamble ? fileBytes.subarray(preamble.containerOffset) : fileBytes

      const { plaintext, header } = await decryptContainer(container, key)
      const meta = (header.meta ?? {}) as ParsedMetaShape

      if (preamble) {
        // 头部记录了声明长度与哈希（都参与 AAD），据此确认明文声明未被替换
        const expected = noticeExpectation(meta)
        if (!expected) throw new Error('NOTICE_MISSING')
        if (preamble.noticeBytes.length !== expected.length) throw new Error('NOTICE_MISMATCH')
        if (noticeHash(preamble.noticeBytes) !== expected.hash) throw new Error('NOTICE_MISMATCH')
        noticeText = preamble.noticeText
        noticeBytes = preamble.noticeBytes.length
      } else if (typeof meta.nh === 'string' && meta.nh.length > 0) {
        // 头部声明"本文件应有明文声明"，但文件里读不到 → 声明区被删掉了
        throw new Error('NOTICE_MISSING')
      } else {
        // 旧格式：声明曾前置在**加密内容**里，解密后再剥离
        legacyBannerBytes = stripBanner(plaintext, meta).bannerBytes
      }

      // 哈希校验：meta.h 记录的是容器明文的哈希（新格式＝纯内容；旧格式＝声明+内容）
      let hashMatched: boolean | null = null
      if (request.verifyHash !== false && typeof meta.h === 'string' && meta.h.length > 0) {
        hashMatched = (await digestFor('SHA-256', plaintext)) === meta.h.toUpperCase()
      }

      const body = preamble ? plaintext : stripBanner(plaintext, meta).content
      const wasGzip = (header.flags & 2) !== 0
      const output = wasGzip ? inflate(body) : body
      if (wasGzip) zeroize(plaintext)

      return {
        id: request.id,
        op: 'decrypt',
        ok: true,
        bytes: toArrayBuffer(output),
        name: meta.n ?? 'restored.bin',
        mime: meta.m,
        header: JSON.stringify(header),
        kind: meta.k ?? 'bytes',
        hashMatched,
        bannerBytes: preamble ? noticeBytes : legacyBannerBytes,
        noticeText,
        originalSize: meta.os,
        expiresAt: meta.exp,
      }
    }

    case 'key-check': {
      const key = requireKey()
      const fileBytes = new Uint8Array(request.bytes)
      const result = await keyCheck(key, bufferSource([fileBytes]), { verifyHash: request.verifyHash })
      return {
        id: request.id,
        op: 'key-check',
        ok: true,
        matched: result.matched,
        layers: result.layers,
        plaintextLength: result.plaintextLength,
        declaredHash: result.declaredHash,
        hashVerified: result.hashVerified,
        fingerprint: await key.fingerprint(),
        header: JSON.stringify({
          v: 1,
          lc: result.layers.length,
          layers: result.layers.map((a) => ({ a })),
          meta: { s: result.plaintextLength, h: result.declaredHash },
        }),
      }
    }

    case 'hash': {
      const bytes = new Uint8Array(request.bytes)
      const digests: Record<string, string> = {}
      for (const algo of request.algorithms) digests[algo] = await digestFor(algo, bytes)
      return { id: request.id, op: 'hash', ok: true, digests }
    }

    default:
      throw new Error('UNKNOWN_OP')
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    self.postMessage(await handle(request))
  } catch (error) {
    self.postMessage({ id: request.id, op: 'error', ok: false, error: normalizeError(error) } satisfies WorkerResponse)
  }
}

// 页面刷新/关闭时整个 Worker 会被销毁，内存随进程回收
self.addEventListener('beforeunload', () => destroyKey())

export {}
