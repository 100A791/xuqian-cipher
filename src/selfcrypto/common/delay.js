/**
 * 统一延迟 —— SPEC 第 3 节（统一延迟 4 到 5 秒随机）、第 4 节阶段零、第 5 节阶段二。
 * 目的：让"密钥错"与"文件被改"两类失败在时间上不可区分。
 *
 * 随机源用 CSPRNG（复用 crypto/random.js 的 randomInt），以符合 SPEC §7「禁止自研随机算法」。
 * 注意：这里的延迟量本身不是密钥材料，但统一走系统随机源可避免出现"某处用了 Math.random"的例外。
 */
import { UNIFORM_DELAY_MS } from './constants.js'
import { randomInt } from '../crypto/random.js'

/**
 * 生效中的延迟区间。默认取 SPEC §3 的 4~5 秒；
 * **仅供测试**调用 setUniformDelayRange 缩短，生产代码不要动它。
 */
let activeRange = UNIFORM_DELAY_MS

/** 仅供测试：把统一延迟缩到指定区间（如 [0, 0]），避免测试等 5 秒。 */
export function setUniformDelayRange(range) {
  if (!Array.isArray(range) || range.length !== 2 || range[0] < 0 || range[1] < range[0]) {
    throw new RangeError('延迟区间非法')
  }
  activeRange = range
}

/** 恢复 SPEC §3 的默认区间。 */
export function resetUniformDelayRange() {
  activeRange = UNIFORM_DELAY_MS
}

/** 取当前区间内的随机毫秒数（闭区间，使用 CSPRNG）。 */
export function uniformDelayMs() {
  const [min, max] = activeRange
  return randomInt(min, max)
}

/** 等待统一延迟（默认 4~5 秒）。测试可传 { ms } 跳过，生产路径不要传。 */
export function uniformDelay({ ms } = {}) {
  const wait = typeof ms === 'number' ? ms : uniformDelayMs()
  return new Promise((resolve) => setTimeout(resolve, wait))
}

/**
 * 把「从 startedAt 到此刻的**总耗时**」补齐到统一目标（4~5 秒随机）。
 *
 * 与 uniformDelay 的区别很关键，不是风格差异：
 *   uniformDelay         只是**附加**一段延迟。
 *   padToUniformDuration 保证**总耗时**落入统一窗口。
 *
 * 为什么必须后者：失败路径的真实计算量随输入差异极大。"文件被篡改"必须先算完
 * 整个文件的 HMAC（1 GB 的纯 JS HMAC-SHA256 实测约 25 秒），而如果"密钥错"能在
 * 第一步就返回，那么"各加 4~5 秒"之后两条路径的总耗时仍相差几十秒 ——
 * 攻击者测总时长就能区分失败原因，统一延迟形同虚设。
 *
 * 前提：调用方已让两条失败路径的**计算量对称**（见 file/decrypt.js 把 MAC 校验提前）。
 * 本函数只负责把总时长钉进窗口；若真实计算量已超过窗口，则不再叠加等待
 * （此时两条路径都受同一计算量支配，总耗时自然接近）。
 *
 * @param {number} startedAt 流程起始时刻（Date.now()）
 */
export async function padToUniformDuration(startedAt) {
  const remaining = uniformDelayMs() - (Date.now() - startedAt)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}
