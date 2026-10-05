/**
 * PBKDF2 —— SPEC 第 5 节阶段一「再写 pbkdf2.js」。
 * PRF 固定为自研 HMAC-SHA256（SPEC §7：禁止自研 SHA-256/HMAC/PBKDF2/AES/CTR 之外的加密算法）。
 * 默认迭代次数见 common/constants.js 的 ITER（SPEC §3：600000）。
 *
 * ⚠ 与 SPEC 的一处冲突（已上报，等确认）：
 *   SPEC §5 写的是「跑 RFC 6070 测试向量」，但 **RFC 6070 是 PBKDF2-HMAC-SHA1** 的向量集；
 *   要用它就得实现 SHA-1，而 SHA-1 不在 SPEC §7 允许自研的算法清单里。
 *   因此本项目改用 **PBKDF2-HMAC-SHA256** 的向量（由 OpenSSL 独立生成，见 tools/gen_vectors.js）。
 */
import { ITER } from '../common/constants.js'
import { hmacSha256 } from './hmac.js'

/**
 * PBKDF2-HMAC-SHA256。
 * @param {Uint8Array} password
 * @param {Uint8Array} salt
 * @param {number} iterations 迭代次数（≥1）
 * @param {number} dkLen 期望输出字节数
 * @returns {Uint8Array}
 */
export function pbkdf2Sha256(password, salt, iterations, dkLen) {
  if (!(password instanceof Uint8Array) || !(salt instanceof Uint8Array)) {
    throw new TypeError('pbkdf2Sha256 的 password / salt 必须是 Uint8Array')
  }
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError('iterations 必须是 ≥1 的整数')
  if (!Number.isInteger(dkLen) || dkLen < 1) throw new RangeError('dkLen 必须是 ≥1 的整数')
  if (dkLen > 0xffffffff * 32) throw new RangeError('dkLen 过大')

  const hLen = 32
  const blockCount = Math.ceil(dkLen / hLen)
  const out = new Uint8Array(blockCount * hLen)

  for (let block = 1; block <= blockCount; block++) {
    // U1 = PRF(P, S || INT_32_BE(block))
    const saltBlock = new Uint8Array(salt.length + 4)
    saltBlock.set(salt, 0)
    new DataView(saltBlock.buffer).setUint32(salt.length, block)

    let u = hmacSha256(password, saltBlock)
    const acc = u.slice()
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(password, u)
      for (let j = 0; j < hLen; j++) acc[j] ^= u[j]
    }
    out.set(acc, (block - 1) * hLen)
  }

  return out.slice(0, dkLen)
}

/** 以默认迭代次数（SPEC §3：600000）派生。 */
export function pbkdf2Default(password, salt, dkLen) {
  return pbkdf2Sha256(password, salt, ITER, dkLen)
}
