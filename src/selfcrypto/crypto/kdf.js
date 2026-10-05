/**
 * 子密钥派生与 KEY_CHECK —— SPEC 第 5 节阶段二「接入 KEY_CHECK 验证逻辑」。
 *
 * 只使用 SPEC §7 允许的算法（HMAC-SHA256），不引入任何新原语：
 *   encKey    = HMAC(K, salt ‖ "xq/v1/enc")  取前 16 字节   → AES-128-CTR
 *   macKey    = HMAC(K, salt ‖ "xq/v1/mac")  32 字节        → 整体 MAC
 *   keyCheck  = HMAC(K, salt ‖ "xq/v1/check") 取前 16 字节  → 不解密即校验密钥
 *
 * 域分隔用固定标签（label）实现，避免同一把密钥在不同用途下产生相关性。
 */
import { concatBytes, takeBytes, utf8Encode } from '../common/bytes.js'
import { hmacSha256 } from './hmac.js'

export const KDF_LABELS = Object.freeze({
  enc: 'xq/v1/enc',
  mac: 'xq/v1/mac',
  check: 'xq/v1/check',
})

export const MASTER_KEY_LEN = 16
export const ENC_KEY_LEN = 16
export const MAC_KEY_LEN = 32

/** 由主密钥与盐派生三个子密钥（互不相同、互不相关）。 */
export function deriveSubkeys(masterKey, salt) {
  if (!(masterKey instanceof Uint8Array) || masterKey.length !== MASTER_KEY_LEN) {
    throw new RangeError(`主密钥必须是 ${MASTER_KEY_LEN} 字节`)
  }
  if (!(salt instanceof Uint8Array)) throw new TypeError('盐必须是字节串')

  const derive = (label) => hmacSha256(masterKey, concatBytes(salt, utf8Encode(label)))
  return {
    encKey: takeBytes(derive(KDF_LABELS.enc), ENC_KEY_LEN),
    macKey: takeBytes(derive(KDF_LABELS.mac), MAC_KEY_LEN),
    keyCheck: takeBytes(derive(KDF_LABELS.check), 16),
  }
}

/** 只算 KEY_CHECK（解密前校验用，避免解出多余子密钥）。 */
export function deriveKeyCheck(masterKey, salt) {
  return takeBytes(hmacSha256(masterKey, concatBytes(salt, utf8Encode(KDF_LABELS.check))), 16)
}
