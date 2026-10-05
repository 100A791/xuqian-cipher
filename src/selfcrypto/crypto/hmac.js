/**
 * HMAC —— SPEC 第 5 节阶段一「再写 hmac.js，跑 RFC 4231 测试向量」。
 * PRF 固定为自研 SHA-256（RFC 4231 本身就是 HMAC-SHA256 的向量集，与 SPEC 的算法清单一致）。
 *
 * 自研实现，不引入任何第三方库（SPEC 第 7 节）。
 */
import { Sha256 } from './sha256.js'

const BLOCK_SIZE = 64 // SHA-256 的块长

/**
 * HMAC-SHA256。
 * @param {Uint8Array} key 任意长度密钥（长于块长时先哈希，符合 RFC 2104）
 * @param {Uint8Array} message
 * @returns {Uint8Array} 32 字节
 */
export function hmacSha256(key, message) {
  if (!(key instanceof Uint8Array) || !(message instanceof Uint8Array)) {
    throw new TypeError('hmacSha256 只接受 Uint8Array')
  }

  // 1) 密钥短于块长则右侧补零；长于块长则先做一次哈希
  let normalized = key
  if (normalized.length > BLOCK_SIZE) normalized = new Sha256().update(normalized).digest()
  const padded = new Uint8Array(BLOCK_SIZE)
  padded.set(normalized)

  // 2) ipad / opad
  const inner = new Uint8Array(BLOCK_SIZE)
  const outer = new Uint8Array(BLOCK_SIZE)
  for (let i = 0; i < BLOCK_SIZE; i++) {
    inner[i] = padded[i] ^ 0x36
    outer[i] = padded[i] ^ 0x5c
  }

  // 3) H((K^opad) || H((K^ipad) || message))
  const innerDigest = new Sha256().update(inner).update(message).digest()
  return new Sha256().update(outer).update(innerDigest).digest()
}

/** 一次性 HMAC-SHA256，返回小写十六进制。 */
export function hmacSha256Hex(key, message) {
  return Array.from(hmacSha256(key, message), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 常数时间校验 HMAC（SPEC §7：禁止用非常数时间比较 MAC）。 */
export function verifyHmac(key, message, expectedMac) {
  const actual = hmacSha256(key, message)
  if (!(expectedMac instanceof Uint8Array) || expectedMac.length !== actual.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expectedMac[i]
  return diff === 0
}
