/**
 * 自研路线的解密 —— SPEC 第 5 节阶段二「再写 decrypt.js 实现反向流程」。
 * 零第三方依赖（SPEC §7）。
 *
 * 顺序上刻意与加密严格对称，并把 SPEC 的红线放在最前面：
 *   §7「禁止 MAC 未验证就解密」 → 先校验整体 MAC，**通过了才动密文**
 *   §7「禁止用非常数时间比较 MAC」 → 所有比对走 crypto/compare.js
 *   §7「禁止提示解密失败的具体原因」「禁止在失败时输出部分明文」
 *        → 一切失败都走 common/fail.js：对外只有统一文案 + 4~5 秒统一延迟，
 *          内部原因只进诊断钩子（默认关闭、绝不写密钥或明文）
 *
 * 关于「统一延迟」成立的两个前提（缺一即失效，详见文件内注释）：
 *   ① 两条失败路径的**计算量必须对称** —— 因此 MAC 校验排在 KEY_CHECK 之前，
 *      让「密钥错」与「文件被改」都要先算完整文件的 MAC；
 *   ② 延迟必须按**总耗时**补齐（`fail(..., { startedAt })`），而不是事后附加 ——
 *      否则大文件的 MAC 耗时（1 GB 实测约 25 秒）会直接淹没 4~5 秒的窗口。
 */
import { MAC_LEN } from '../common/constants.js'
import { concatBytes } from '../common/bytes.js'
import { timingSafeEqual } from '../crypto/compare.js'
import { hmacSha256 } from '../crypto/hmac.js'
import { deriveKeyCheck, deriveSubkeys, MASTER_KEY_LEN } from '../crypto/kdf.js'
import { fail } from '../common/fail.js'
import { assertExactLength } from '../common/validate.js'
import { FLAG_FULL_NONCE_COUNTER, FormatError, serializeHeader, splitFile } from './format.js'
import { decodeKv, decodeMetadata } from './metadata.js'
import { encryptPayload, interleaveJoin, unreorderShares } from './encrypt.js'

/**
 * 只校验密钥、不解密内容（供界面的「自检密钥」交互使用）。
 *
 * 注意：这里**不抛统一失败、也不走 4~5 秒延迟** —— 它本身就是一个
 * "问是否匹配"的查询接口，不是失败路径，故不受统一延迟约束。
 *
 * ⚠ 定位说明（已知并接受的安全取舍）：KEY_CHECK 是明文写在文件头偏移 77 的
 * 16 字节，因此**只拿到 97 字节文件头**的攻击者也能对任意密钥候选自行算出
 * 该值来判断对错 —— 无需文件主体，也无需触碰本函数。
 * 也就是说 KEY_CHECK 实质是一个「明文的密钥验证预言机」：
 *   · 对随机 128 位主密钥：无影响（不可能穷举）；
 *   · 若将来接入口令模式（PBKDF2）：它会把攻击者单次尝试的成本从"完整解密"
 *     降到"一次 HMAC"—— 那时真正的防线只剩 PBKDF2 的迭代次数。
 * 保留它的理由是用户体验（密钥错时立刻告知，而不必等一次完整 MAC）。
 *
 * 解密主路径（decryptFile）**不依赖**它做判断：那里先验整体 MAC，
 * 使两条失败路径的计算量对称 —— 详见 decryptFile 内的注释。
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
  // 失败路径的等时化基准点（见下方"为什么必须先验 MAC"）
  const startedAt = Date.now()

  // 结构性问题（魔数/版本/长度自洽）同样走统一失败出口，避免泄漏"卡在哪一步"
  let parts
  try {
    parts = splitFile(cipherBytes)
  } catch (error) {
    return fail(`format:${error instanceof FormatError ? error.code : 'unknown'}`, { startedAt })
  }
  const { header, rules, payload, mac } = parts

  // ① 校验整体 MAC —— 未通过绝不进入解密。
  //
  //    顺序上**必须先验整体 MAC、再验 KEY_CHECK**，这不是风格偏好：
  //      · 「密钥错」若能在第一步就返回，耗时只有一次 HMAC（微秒级）；
  //      · 「文件被改」则必须算完整个文件的 HMAC（1 GB 的纯 JS HMAC-SHA256 实测约 25 秒）。
  //    两条失败路径的耗时差几十秒，事后再"各加 4~5 秒延迟"根本无法掩盖 ——
  //    攻击者测总时长即可区分失败原因。让两条路径都先走完整 MAC 计算，
  //    再配合 fail(..., { startedAt }) 把总耗时补齐，才真正不可区分。
  onProgress?.({ phase: 'mac', done: 0, total: 1 })
  const { encKey, macKey, keyCheck } = deriveSubkeys(masterKey, header.salt)
  const expectedMac = hmacSha256(
    macKey,
    concatBytes(macHeaderBytes(header, rules.length, payload.length), rules, payload),
  )
  if (!timingSafeEqual(expectedMac.subarray(0, MAC_LEN), mac)) {
    return fail('mac-mismatch', { startedAt })
  }

  // ② 校验 KEY_CHECK（SPEC §5 阶段二要求保留此校验）。
  //    能走到这里说明 MAC 已通过；而 MAC 与 KEY_CHECK 由同一把主密钥派生保护，
  //    故本步在正常情况下不可能失败 —— 保留它是纵深防御，
  //    也不再构成"快速失败"的旁路（两条失败路径都要先算完整 MAC）。
  onProgress?.({ phase: 'keycheck', done: 0, total: 1 })
  if (!timingSafeEqual(keyCheck, header.keyCheck)) {
    return fail('key-check-mismatch', { startedAt })
  }

  // ③ MAC 通过后才还原段顺序并分块解密
  onProgress?.({ phase: 'split', done: 0, total: 1 })
  const shares = unreorderShares(payload, header.segments, header.segmentOrder)
  const ciphertext = interleaveJoin(shares)
  // 计数器构造方式由文件头决定：新文件用完整 128 位 nonce，v1 旧文件用 64 位写法。
  // 一律以文件自述为准，不猜默认值。
  const fullNonce = (header.flags & FLAG_FULL_NONCE_COUNTER) !== 0
  const plaintext = encryptPayload(ciphertext, encKey, header.bootNonce, onProgress, fullNonce)

  // ④ 拆出元数据与内容
  const metaLen = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0)
  if (metaLen > plaintext.length - 4) {
    // 能走到这里说明 MAC 已通过 → 只可能是实现缺陷而非攻击，但仍按统一失败处理
    return fail('meta-length-invalid', { startedAt })
  }
  let metadata
  try {
    metadata = decodeMetadata(plaintext.subarray(4, 4 + metaLen))
  } catch (error) {
    return fail(`meta-decode:${error instanceof FormatError ? error.code : 'unknown'}`, { startedAt })
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
