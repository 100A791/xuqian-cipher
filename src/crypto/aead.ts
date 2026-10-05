import { gcm } from '@noble/ciphers/aes.js'
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sm4GcmOpen, sm4GcmSeal } from './sm4.ts'
import { copyBytes } from './zeroize.ts'

export type AlgoId =
  | 'AES-128-GCM'
  | 'AES-256-GCM'
  | 'CHACHA20-POLY1305'
  | 'XCHACHA20-POLY1305'
  | 'SM4-GCM'

export interface AlgoSpec {
  id: AlgoId
  label: string
  /** 子密钥长度（字节） */
  keyLength: number
  /** nonce 长度（字节） */
  nonceLength: number
  /** 认证标签长度（字节） */
  tagLength: number
  /** 是否使用 WebCrypto 硬件加速 */
  accelerated: boolean
  /** 子密钥派生时混入的域分隔标签（与密钥长度绑定） */
  kdfTag: string
}

export const ALGO_SPECS: Record<AlgoId, AlgoSpec> = {
  'AES-128-GCM': {
    id: 'AES-128-GCM',
    label: 'AES-128-GCM',
    keyLength: 16,
    nonceLength: 12,
    tagLength: 16,
    accelerated: true,
    kdfTag: 'aes128gcm',
  },
  'AES-256-GCM': {
    id: 'AES-256-GCM',
    label: 'AES-256-GCM',
    keyLength: 32,
    nonceLength: 12,
    tagLength: 16,
    accelerated: true,
    kdfTag: 'aes256gcm',
  },
  'CHACHA20-POLY1305': {
    id: 'CHACHA20-POLY1305',
    label: 'ChaCha20-Poly1305',
    keyLength: 32,
    nonceLength: 12,
    tagLength: 16,
    accelerated: false,
    kdfTag: 'chacha20poly1305',
  },
  'XCHACHA20-POLY1305': {
    id: 'XCHACHA20-POLY1305',
    label: 'XChaCha20-Poly1305',
    keyLength: 32,
    nonceLength: 24,
    tagLength: 16,
    accelerated: false,
    kdfTag: 'xchacha20poly1305',
  },
  'SM4-GCM': {
    id: 'SM4-GCM',
    label: 'SM4-GCM (GB/T 32907)',
    keyLength: 16,
    nonceLength: 12,
    tagLength: 16,
    accelerated: false,
    kdfTag: 'sm4gcm',
  },
}

export const ALL_ALGO_IDS = Object.keys(ALGO_SPECS) as AlgoId[]

export function isAlgoId(value: unknown): value is AlgoId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALGO_SPECS, value)
}

export function getAlgoSpec(id: AlgoId): AlgoSpec {
  const spec = ALGO_SPECS[id]
  if (!spec) throw new Error('UNSUPPORTED_ALGORITHM')
  return spec
}

export interface Aead {
  /** 返回 ciphertext || tag */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  /** 输入 ciphertext || tag；认证失败必须抛错 */
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}

// ---------------------------------------------------------------------------
// WebCrypto 加速路径（AES-GCM）
// ---------------------------------------------------------------------------

const subtle: SubtleCrypto | undefined =
  typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined'
    ? globalThis.crypto.subtle
    : undefined

let webcryptoAesUsable: Promise<boolean> | null = null

function probeAesGcm(): Promise<boolean> {
  if (!subtle) return Promise.resolve(false)
  if (webcryptoAesUsable) return webcryptoAesUsable
  webcryptoAesUsable = (async () => {
    try {
      const key = await subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', false, ['encrypt', 'decrypt'])
      const nonce = new Uint8Array(12)
      const out = await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, new Uint8Array(0))
      return out.byteLength === 16
    } catch {
      return false
    }
  })()
  return webcryptoAesUsable
}

function webcryptoAes(spec: AlgoSpec): Aead {
  return {
    async seal(key, nonce, plaintext, aad) {
      const ck = await subtle!.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
      const buf = await subtle!.encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: spec.tagLength * 8, additionalData: aad },
        ck,
        plaintext,
      )
      return new Uint8Array(buf)
    },
    async open(key, nonce, sealed, aad) {
      const ck = await subtle!.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
      const buf = await subtle!.decrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: spec.tagLength * 8, additionalData: aad },
        ck,
        sealed,
      )
      return new Uint8Array(buf)
    },
  }
}

// ---------------------------------------------------------------------------
// 纯 JavaScript 后备路径
// ---------------------------------------------------------------------------

function nobleAead(
  construct: (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array) => {
    encrypt(p: Uint8Array): Uint8Array
    decrypt(c: Uint8Array): Uint8Array
  },
): Aead {
  return {
    async seal(key, nonce, plaintext, aad) {
      // 注意：noble 某些路径会原地修改输入缓冲区，因此必须传入独立副本，
      // 否则会破坏调用方持有的明文（分块/多层链式加密时后果严重）。
      return toBytes(construct(key, nonce, aad).encrypt(copyBytes(plaintext)))
    },
    async open(key, nonce, sealed, aad) {
      return toBytes(construct(key, nonce, aad).decrypt(copyBytes(sealed)))
    },
  }
}

function toBytes(value: Uint8Array): Uint8Array {
  // noble 在部分路径返回 Uint8Array<ArrayBufferLike>，统一复制成独立副本
  const out = new Uint8Array(value.length)
  out.set(value)
  return out
}

const nobleAes128: Aead = nobleAead((key, nonce, aad) => gcm(key, nonce, aad))
const nobleAes256: Aead = nobleAead((key, nonce, aad) => gcm(key, nonce, aad))
const nobleChaCha: Aead = nobleAead((key, nonce, aad) => chacha20poly1305(key, nonce, aad))
const nobleXChaCha: Aead = nobleAead((key, nonce, aad) => xchacha20poly1305(key, nonce, aad))

const sm4Aead: Aead = {
  async seal(key, nonce, plaintext, aad) {
    // 同样防御性复制：保证调用方传入的明文缓冲区不被就地改写
    return sm4GcmSeal(key, nonce, copyBytes(plaintext), aad)
  },
  async open(key, nonce, sealed, aad) {
    return sm4GcmOpen(key, nonce, sealed, aad)
  },
}

/** 统一错误：绝不区分"密钥错误"与"文件损坏"（防止 oracle 泄露）。 */
export class AuthError extends Error {
  constructor() {
    super('AUTH_FAILED')
    this.name = 'AuthError'
  }
}

/** AES 混合路径：优先 WebCrypto，失败则就地回退到纯 JS 实现（结果完全一致）。 */
function hybridAes(spec: AlgoSpec, fallback: Aead): Aead {
  return {
    async seal(key, nonce, plaintext, aad) {
      if (await probeAesGcm()) {
        try {
          return await webcryptoAes(spec).seal(key, nonce, plaintext, aad)
        } catch {
          /* 回退 */
        }
      }
      return fallback.seal(key, nonce, plaintext, aad)
    },
    async open(key, nonce, sealed, aad) {
      if (await probeAesGcm()) {
        try {
          return await webcryptoAes(spec).open(key, nonce, sealed, aad)
        } catch {
          /* 回退：可能是 WebCrypto 抛错，也可能是 tag 校验失败；交给 fallback 给出统一结论 */
        }
      }
      return fallback.open(key, nonce, sealed, aad)
    },
  }
}

/** 取得指定算法的 AEAD 实现（AES 优先走 WebCrypto）。 */
export function getAead(id: AlgoId): Aead {
  const spec = getAlgoSpec(id)
  switch (id) {
    case 'AES-128-GCM':
      return hybridAes(spec, nobleAes128)
    case 'AES-256-GCM':
      return hybridAes(spec, nobleAes256)
    case 'CHACHA20-POLY1305':
      return nobleChaCha
    case 'XCHACHA20-POLY1305':
      return nobleXChaCha
    case 'SM4-GCM':
      return sm4Aead
    default:
      throw new Error('UNSUPPORTED_ALGORITHM')
  }
}

/** 当前运行环境是否具备 WebCrypto AES 加速。 */
export async function hasAesAcceleration(): Promise<boolean> {
  return probeAesGcm()
}
