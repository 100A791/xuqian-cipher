/**
 * 水印私有信息的加解密 —— SPEC 第 5 节阶段三「再写 watermark_crypto.js 实现水印加密解密」。
 * 零第三方依赖（SPEC §7）；只复用既定原语（HMAC-SHA256 / AES-CTR / 常数时间比较）。
 *
 * 打包格式（**决策 D15**）：
 *
 *   nonce(16) ‖ AES-128-CTR(WK 派生的 encKey, nonce, 明文) ‖ HMAC(macKey, nonce ‖ 密文)[0..32]
 *
 * 子密钥用 file/kdf.js 的同一套域分隔标签派生（`xq/v1/enc`、`xq/v1/mac`），
 * 但这里不吃盐——水印的 WK 本身就是一次性随机密钥，nonce 每次随机。
 *
 * 失败一律走 common/fail.js：对外只有统一文案 + 4~5 秒统一延迟（SPEC §5 阶段三「失败走统一失败和统一延迟」）。
 */
import { MAC_LEN } from '../common/constants.js'
import { concatBytes, copyBytes, takeBytes } from '../common/bytes.js'
import { randomBytes } from '../crypto/random.js'
import { hmacSha256 } from '../crypto/hmac.js'
import { aesCtr } from '../crypto/ctr.js'
import { timingSafeEqual } from '../crypto/compare.js'
import { deriveSubkeys, MASTER_KEY_LEN } from '../crypto/kdf.js'
import { fail } from '../common/fail.js'
import { assertBytes, assertExactLength } from '../common/validate.js'
import { FormatError } from '../file/format.js'

export const NONCE_LEN = 16
export const PACKED_OVERHEAD = NONCE_LEN + MAC_LEN

/** 生成一把水印密钥 WK（SPEC §4 模块 B 返回 keyWK）。 */
export function generateWatermarkKey() {
  return randomBytes(MASTER_KEY_LEN)
}

/**
 * 加密水印私有信息。
 * @param {Uint8Array} plainBytes
 * @param {Uint8Array} keyWK 16 字节
 * @param {{nonce?: Uint8Array}} [options] 测试用：固定 nonce
 */
export function encryptWatermarkPayload(plainBytes, keyWK, options = {}) {
  assertBytes(plainBytes, '水印私有信息')
  assertExactLength(keyWK, MASTER_KEY_LEN, '水印密钥 WK')
  const nonce = options.nonce ? copyBytes(assertExactLength(options.nonce, NONCE_LEN, 'nonce')) : randomBytes(NONCE_LEN)

  // 水印场景没有文件盐，用非零常量盐占位，保持与 file/kdf.js 相同的派生结构
  const salt = new Uint8Array(32)
  const { encKey, macKey } = deriveSubkeys(keyWK, salt)
  const ciphertext = aesCtr(encKey, nonce, plainBytes)
  const mac = takeBytes(hmacSha256(macKey, concatBytes(nonce, ciphertext)), MAC_LEN)
  return concatBytes(nonce, ciphertext, mac)
}

/** 只校验 WK 是否正确（不解密内容，用于「自检水印密钥」）。 */
export function checkWatermarkKey(packed, keyWK) {
  if (!(packed instanceof Uint8Array) || packed.length < PACKED_OVERHEAD) return false
  if (!(keyWK instanceof Uint8Array) || keyWK.length !== MASTER_KEY_LEN) return false
  const nonce = packed.subarray(0, NONCE_LEN)
  const ciphertext = packed.subarray(NONCE_LEN, packed.length - MAC_LEN)
  const mac = packed.subarray(packed.length - MAC_LEN)
  const salt = new Uint8Array(32)
  const { macKey } = deriveSubkeys(keyWK, salt)
  return timingSafeEqual(takeBytes(hmacSha256(macKey, concatBytes(nonce, ciphertext)), MAC_LEN), mac)
}

/**
 * 解密水印私有信息。任何失败（结构不对 / WK 不对 / 内容被改）都走统一失败。
 * @returns {Promise<Uint8Array>}
 */
export async function decryptWatermarkPayload(packed, keyWK) {
  if (!(packed instanceof Uint8Array) || packed.length < PACKED_OVERHEAD) {
    return fail('wm-packed-too-short')
  }
  if (!(keyWK instanceof Uint8Array) || keyWK.length !== MASTER_KEY_LEN) {
    return fail('wm-key-invalid')
  }
  const nonce = packed.subarray(0, NONCE_LEN)
  const ciphertext = packed.subarray(NONCE_LEN, packed.length - MAC_LEN)
  const mac = packed.subarray(packed.length - MAC_LEN)

  const salt = new Uint8Array(32)
  const { encKey, macKey } = deriveSubkeys(keyWK, salt)
  const expected = takeBytes(hmacSha256(macKey, concatBytes(nonce, ciphertext)), MAC_LEN)
  if (!timingSafeEqual(expected, mac)) {
    return fail('wm-mac-mismatch')
  }
  return aesCtr(encKey, nonce, ciphertext)
}

export { FormatError }
