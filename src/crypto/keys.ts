import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { getAlgoSpec, type AlgoId } from './aead.ts'
import { copyBytes, toArrayBuffer, utf8ToBytes, zeroize } from './zeroize.ts'

export const MASTER_KEY_BYTES = 16 // 128 位
export const SALT_BYTES = 16
export const KEY_ID_BYTES = 8

export const KDF_INFO_ROOT = 'XUQIAN/v1/master'
export const KDF_INFO_SUBKEY = 'XUQIAN/v1/subkey'
export const KDF_INFO_NONCE = 'XUQIAN/v1/nonce'

/** 从 CSPRNG 取随机字节。 */
export function randomBytes(length: number): Uint8Array {
  if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('CSPRNG_UNAVAILABLE')
  }
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

export const sha256Bytes = (data: Uint8Array): Uint8Array => sha256(data)
export const sha512Bytes = (data: Uint8Array): Uint8Array => sha512(data)

async function digestSha256(data: Uint8Array): Promise<Uint8Array> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(data))
    return new Uint8Array(buf)
  }
  return sha256(data)
}

/**
 * 128 位主密钥容器。
 *
 * 安全设计：
 * - 内部权威表示始终是 Uint8Array，destroy() 会可靠覆写。
 * - 从不把密钥写进 localStorage / sessionStorage / IndexedDB / Cookie / URL。
 * - 不提供任何"找回"接口：destroy() 之后再调用任何导出方法都会抛错。
 */
export class MasterKey {
  #bytes: Uint8Array
  #destroyed = false

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  /** 生成全新的 128 位随机主密钥。 */
  static generate(): MasterKey {
    return new MasterKey(randomBytes(MASTER_KEY_BYTES))
  }

  /** 从用户输入 / .XUQIANKEY 导入。 */
  static fromBytes(bytes: Uint8Array): MasterKey {
    if (bytes.length !== MASTER_KEY_BYTES) throw new Error('INVALID_MASTER_KEY_LENGTH')
    return new MasterKey(copyBytes(bytes))
  }

  get destroyed(): boolean {
    return this.#destroyed
  }

  get length(): number {
    return MASTER_KEY_BYTES
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error('KEY_DESTROYED')
  }

  /** 返回内部字节的只读视图（用于派生，不产生副本泄漏）。 */
  view(): Uint8Array {
    this.#assertAlive()
    return this.#bytes
  }

  /** 显式取一份副本；调用方负责擦除。 */
  clone(): Uint8Array {
    this.#assertAlive()
    return copyBytes(this.#bytes)
  }

  /**
   * HKDF-SHA256 派生每层子密钥。
   * info 中绑定：层序号 + 算法 ID + 密钥长度，确保"换算法/换顺序"会得到不同子密钥。
   */
  deriveSubkey(algo: AlgoId, layerIndex: number, salt: Uint8Array): Uint8Array {
    this.#assertAlive()
    const spec = getAlgoSpec(algo)
    const info = utf8ToBytes(`${KDF_INFO_SUBKEY}|${layerIndex}|${algo}|${spec.keyLength}|${spec.kdfTag}`)
    return hkdf(sha256, this.#bytes, salt, info, spec.keyLength)
  }

  /**
   * 由"每层基础 nonce 种子"派生分块 nonce：
   * nonce_i = HKDF(IKM = nonceSalt, salt = 主密钥, info = "XUQIAN/v1/nonce|layer|chunk|len")
   * 主密钥仍然参与，保证 (子密钥, nonce) 组合在每个分块之间唯一，绝不重复。
   */
  deriveNonce(algo: AlgoId, layerIndex: number, chunkIndex: number, nonceSalt: Uint8Array): Uint8Array {
    this.#assertAlive()
    const spec = getAlgoSpec(algo)
    const info = utf8ToBytes(`${KDF_INFO_NONCE}|${layerIndex}|${chunkIndex}|${spec.nonceLength}`)
    return hkdf(sha256, nonceSalt, this.#bytes, info, spec.nonceLength)
  }

  /** 密钥指纹：SHA-256 前 8 字节的十六进制大写（用于用户确认密钥是否正确）。 */
  async fingerprint(): Promise<string> {
    this.#assertAlive()
    const digest = await digestSha256(this.#bytes)
    const fp = digest.subarray(0, KEY_ID_BYTES)
    const hex = Array.from(fp, (b) => b.toString(16).padStart(2, '0')).join('')
    zeroize(digest)
    return hex.toUpperCase()
  }

  /**
   * 销毁：覆写主密钥字节并标记失效。之后任何派生/导出都会抛错。
   * 这是"关闭弹窗后立即销毁"的执行点。
   */
  destroy(): void {
    zeroize(this.#bytes)
    this.#bytes = new Uint8Array(0)
    this.#destroyed = true
  }
}

/**
 * 用主密钥派生"密钥文件加密密钥"（KFK），用于密码保护 .XUQIANKEY。
 * PBKDF2-SHA256 由 WebCrypto 提供；无 WebCrypto 时退化为 noble 实现。
 */
export const PBKDF2_ITERATIONS = 600_000

export async function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const baseKey = await subtle.importKey('raw', toArrayBuffer(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
      baseKey,
      length * 8,
    )
    return new Uint8Array(bits)
  }
  // 后备：同步 PBKDF2（noble）
  const { pbkdf2 } = await import('@noble/hashes/pbkdf2.js')
  return pbkdf2(sha256, password, salt, { c: iterations, dkLen: length })
}

/** 计算 8 字节密钥指纹（同步版本，供 worker 内部使用）。 */
export function fingerprintOf(keyBytes: Uint8Array): Uint8Array {
  return sha256(keyBytes).subarray(0, KEY_ID_BYTES)
}
