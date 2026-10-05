/**
 * .XUQIANKEY 密钥文件（可选密码保护）。
 *
 * 明文形式（未设置密码）：
 * {
 *   "format": "XUQIANKEY", "version": 1, "protected": false,
 *   "keyHex": "...", "keyB64": "...", "fingerprint": "...",
 *   "layers": [...], "createdAt": 1700000000000, "note": "...", "checksum": "..."
 * }
 *
 * 密码保护形式：
 * {
 *   "format": "XUQIANKEY", "version": 1, "protected": true,
 *   "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "<b64>" },
 *   "cipher": "AES-256-GCM",
 *   "nonce": "<b64>", "sealed": "<b64>",   // sealed = AES-256-GCM(KFK, nonce, innerJson)
 *   "fingerprint": "..."                    // 指纹保留在明文头，便于用户确认是哪个密钥
 * }
 *
 * 安全边界：密码只用于保护"密钥文件"本身；主密钥仍是唯一解密凭证。
 * 网站不保存密码、不上传任何内容；密码错误与文件损坏统一提示。
 */
import { getAead, type AlgoId } from './aead.ts'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from './encoding.ts'
import { MasterKey, PBKDF2_ITERATIONS, pbkdf2Sha256, randomBytes, SALT_BYTES, sha256Bytes } from './keys.ts'
import { bytesToUtf8, copyBytes, utf8ToBytes, zeroize } from './zeroize.ts'

export const KEYFILE_FORMAT = 'XUQIANKEY'
export const KEYFILE_VERSION = 1
const KEYFILE_AAD = utf8ToBytes(KEYFILE_FORMAT)

export interface KeyFilePayload {
  keyHex: string
  keyB64: string
  fingerprint: string
  layers?: AlgoId[]
  createdAt?: number
  note?: string
  /** 加密时使用的分块大小（仅作提示，不影响解密） */
  chunkSize?: number
  gzip?: boolean
  compact?: boolean
  warning: string
}

export interface KeyFilePlain extends KeyFilePayload {
  format: string
  version: number
  protected: false
  checksum: string
}

export interface KeyFileProtected {
  format: string
  version: number
  protected: true
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string }
  cipher: 'AES-256-GCM'
  nonce: string
  sealed: string
  fingerprint: string
}

export type KeyFile = KeyFilePlain | KeyFileProtected

export const KEYFILE_WARNING = '此文件等同于你的 128 位主密钥。任何人拿到它都能解密你的 .XUQIAN 文件，请离线妥善保管。'

function checksumOf(payload: Pick<KeyFilePayload, 'keyHex' | 'fingerprint' | 'layers' | 'createdAt'>): string {
  const core = [payload.keyHex, payload.fingerprint, payload.layers?.join(',') ?? '', String(payload.createdAt ?? 0)].join('|')
  return bytesToHex(sha256Bytes(utf8ToBytes(core))).slice(0, 16).toUpperCase()
}

export function buildPlainKeyFile(payload: KeyFilePayload): KeyFilePlain {
  return {
    format: KEYFILE_FORMAT,
    version: KEYFILE_VERSION,
    protected: false,
    ...payload,
    warning: payload.warning || KEYFILE_WARNING,
    checksum: checksumOf(payload),
  }
}

export async function buildProtectedKeyFile(payload: KeyFilePayload, password: string): Promise<KeyFileProtected> {
  const pw = utf8ToBytes(password)
  const salt = randomBytes(SALT_BYTES)
  const kfk = await pbkdf2Sha256(pw, salt, PBKDF2_ITERATIONS, 32)
  const nonce = randomBytes(12)
  const inner = buildPlainKeyFile(payload)
  const plaintext = utf8ToBytes(JSON.stringify(inner))
  const sealed = await getAead('AES-256-GCM').seal(kfk, nonce, plaintext, KEYFILE_AAD)
  const out: KeyFileProtected = {
    format: KEYFILE_FORMAT,
    version: KEYFILE_VERSION,
    protected: true,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
    cipher: 'AES-256-GCM',
    nonce: bytesToBase64(nonce),
    sealed: bytesToBase64(sealed),
    fingerprint: payload.fingerprint,
  }
  zeroize(kfk, nonce, plaintext, pw)
  return out
}

/** 序列化为 .XUQIANKEY 文本内容。 */
export function serializeKeyFile(file: KeyFile): string {
  return JSON.stringify(file, null, 2) + '\n'
}

/** 解析密钥文件。受保护文件需要密码；密码错误与文件损坏统一报 KEYFILE_PASSWORD_WRONG。 */
export async function parseKeyFile(text: string, password?: string): Promise<KeyFilePayload> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('KEYFILE_INVALID')
  }
  const file = parsed as Partial<KeyFile>
  if (!file || typeof file !== 'object') throw new Error('KEYFILE_INVALID')
  if (file.format !== KEYFILE_FORMAT) throw new Error('KEYFILE_INVALID')
  if (file.version !== KEYFILE_VERSION) throw new Error('KEYFILE_VERSION_UNSUPPORTED')

  if (file.protected === true) {
    const pf = file as KeyFileProtected
    if (!password) throw new Error('KEYFILE_PASSWORD_REQUIRED')
    const pw = utf8ToBytes(password)
    const kfk = await pbkdf2Sha256(pw, base64ToBytes(pf.kdf.salt), pf.kdf.iterations, 32)
    const nonce = base64ToBytes(pf.nonce)
    let inner: KeyFilePlain
    try {
      const plaintext = await getAead('AES-256-GCM').open(kfk, nonce, base64ToBytes(pf.sealed), KEYFILE_AAD)
      inner = JSON.parse(bytesToUtf8(plaintext)) as KeyFilePlain
    } catch {
      zeroize(kfk, nonce, pw)
      throw new Error('KEYFILE_PASSWORD_WRONG')
    }
    zeroize(kfk, nonce, pw)
    verifyInner(inner)
    return inner
  }

  const plain = file as KeyFilePlain
  verifyInner(plain)
  return plain
}

function verifyInner(inner: KeyFilePlain | undefined): void {
  if (!inner || typeof inner.keyHex !== 'string') throw new Error('KEYFILE_INVALID')
  if (inner.checksum && inner.checksum !== checksumOf(inner)) throw new Error('KEYFILE_CHECKSUM_MISMATCH')
}

/** 从密钥文件负载恢复主密钥。 */
export function masterKeyFromPayload(payload: KeyFilePayload): MasterKey {
  const bytes = /^[0-9a-fA-F]{32}$/.test(payload.keyHex) ? hexToBytes(payload.keyHex) : base64ToBytes(payload.keyB64)
  try {
    return MasterKey.fromBytes(bytes)
  } finally {
    zeroize(bytes)
  }
}

/** 由主密钥字节构造密钥文件负载。 */
export async function payloadFromBytes(
  keyBytes: Uint8Array,
  extra: { layers?: AlgoId[]; note?: string; chunkSize?: number; gzip?: boolean } = {},
): Promise<KeyFilePayload> {
  const key = MasterKey.fromBytes(keyBytes)
  const fingerprint = await key.fingerprint()
  key.destroy()
  return {
    keyHex: bytesToHex(copyBytes(keyBytes)),
    keyB64: bytesToBase64(copyBytes(keyBytes)),
    fingerprint,
    layers: extra.layers,
    createdAt: Date.now(),
    note: extra.note,
    chunkSize: extra.chunkSize,
    gzip: extra.gzip,
    warning: KEYFILE_WARNING,
  }
}
