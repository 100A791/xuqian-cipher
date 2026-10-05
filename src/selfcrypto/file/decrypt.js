/**
 * 自研路线的解密 —— SPEC 第 5 节阶段二「再写 decrypt.js 实现反向流程」。
 * 零第三方依赖（SPEC §7）。
 *
 * 顺序上刻意与加密严格对称，并把三条 SPEC 红线放在最前面：
 *   §7「禁止 MAC 未验证就解密」 → 先校验整体 MAC，**通过了才动密文**
 *   §7「禁止用非常数时间比较 MAC」 → 所有比对走 crypto/compare.js
 *   §7「禁止提示解密失败的具体原因」「禁止在失败时输出部分明文」
 *        → 一切失败都走 common/fail.js：对外只有统一文案 + 4~5 秒统一延迟，
 *          内部原因只进诊断钩子（默认关闭、绝不写密钥或明文）
 */
import { MAC_LEN } from '../common/constants.js'
import { concatBytes } from '../common/bytes.js'
import { timingSafeEqual } from '../crypto/compare.js'
import { hmacSha256 } from '../crypto/hmac.js'
import { deriveKeyCheck, deriveSubkeys, MASTER_KEY_LEN } from '../crypto/kdf.js'
import { fail } from '../common/fail.js'
import { assertExactLength } from '../common/validate.js'
import { FormatError, serializeHeader, splitFile } from './format.js'
import { decodeKv, decodeMetadata } from './metadata.js'
import { encryptPayload, interleaveJoin, unreorderShares } from './encrypt.js'

/**
 * 只校验密钥、不解密内容（供「自检密钥」这类交互使用）。
 * 注意：这里**不抛统一失败**，因为它本身就是一个"问是否匹配"的查询接口。
 */
export function checkKey(cipherBytes, masterKey) {
  assertExactLength(masterKey, MASTER_KEY_LEN, '主密钥')
  const { header } = splitFile(cipherBytes)
  return timingSafeEqual(deriveKeyCheck(masterKey, header.salt), header.keyCheck)
}

/** 重新序列化头部（MAC 计算需要"规则块长度/载荷长度已写入"的那份字节）。 */
function macHeaderBytes(header, rulesLen, payloadLen) {
  return serializeHeader({ ...header, rulesLen, payloadLen })
}

/**
 * 解密文件。
 * @param {Uint8Array} cipherBytes 完整文件字节
 * @param {Uint8Array} masterKey 16 字节主密钥
 * @param {{onProgress?: (progress: {phase: string, done: number, total: number}) => void}} [options]
 *        SPEC §4 只规定了两个参数，第三个是**可选**扩展（决策 D31），不传时行为与原来完全一致。
 * @returns {Promise<{
 *   plainBytes: Uint8Array,
 *   metadata: Map<string, any>,
 *   header: {version: number, flags: number, timestamp: number, bootNonce: Uint8Array, chunkSize: number,
 *            segments: number, splitMode: number, segmentOrder: Uint8Array, salt: Uint8Array,
 *            keyCheck: Uint8Array, rulesLen: number, payloadLen: number},
 *   ruleEntries: Array<any>,
 * }>}
 * @throws 统一失败（无原因、含 4~5 秒延迟）
 */
export async function decryptFile(cipherBytes, masterKey, options = {}) {
  assertExactLength(masterKey, MASTER_KEY_LEN, '主密钥')
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : undefined

  // 结构性问题（魔数/版本/长度自洽）同样走统一失败出口，避免泄漏"卡在哪一步"
  let parts
  try {
    parts = splitFile(cipherBytes)
  } catch (error) {
    return fail(`format:${error instanceof FormatError ? error.code : 'unknown'}`)
  }
  const { header, rules, payload, mac } = parts

  // ① 校验密钥（KEY_CHECK）
  onProgress?.({ phase: 'keycheck', done: 0, total: 1 })
  if (!timingSafeEqual(deriveKeyCheck(masterKey, header.salt), header.keyCheck)) {
    return fail('key-check-mismatch')
  }

  // ② 校验整体 MAC —— 未通过绝不进入解密
  onProgress?.({ phase: 'mac', done: 0, total: 1 })
  const { encKey, macKey } = deriveSubkeys(masterKey, header.salt)
  const expectedMac = hmacSha256(
    macKey,
    concatBytes(macHeaderBytes(header, rules.length, payload.length), rules, payload),
  )
  if (!timingSafeEqual(expectedMac.subarray(0, MAC_LEN), mac)) {
    return fail('mac-mismatch')
  }

  // ③ MAC 通过后才还原段顺序并分块解密
  onProgress?.({ phase: 'split', done: 0, total: 1 })
  const shares = unreorderShares(payload, header.segments, header.segmentOrder)
  const ciphertext = interleaveJoin(shares)
  const plaintext = encryptPayload(ciphertext, encKey, header.bootNonce, onProgress)

  // ④ 拆出元数据与内容
  const metaLen = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0)
  if (metaLen > plaintext.length - 4) {
    // 能走到这里说明 MAC 已通过 → 只可能是实现缺陷而非攻击，但仍按统一失败处理
    return fail('meta-length-invalid')
  }
  let metadata
  try {
    metadata = decodeMetadata(plaintext.subarray(4, 4 + metaLen))
  } catch (error) {
    return fail(`meta-decode:${error instanceof FormatError ? error.code : 'unknown'}`)
  }
  const plainBytes = new Uint8Array(plaintext.length - 4 - metaLen)
  plainBytes.set(plaintext.subarray(4 + metaLen))

  // 规则块：语义由上层（水印/解密流程）解释，这里只把条目取出来；坏块不阻断解密
  let ruleEntries = []
  if (rules.length > 0) {
    try {
      ruleEntries = decodeKv(rules)
    } catch {
      ruleEntries = []
    }
  }
  return { plainBytes, metadata, header, ruleEntries }
}
