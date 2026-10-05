/**
 * 常数时间比较 —— SPEC 第 4 节阶段零、第 2 节 crypto 目录（compare.js）。
 *
 * SPEC 第 7 节明令：**禁止用非常数时间比较 MAC**。
 * 因此 MAC / KEY_CHECK 的比对必须走这里，不能用 === 或 Buffer.equals。
 */

/**
 * 常数时间比较两个字节串是否相等。
 * 长度不同也走完整循环（先记下长度差异，不做提前返回），避免通过耗时泄漏长度。
 */
export function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) throw new TypeError('timingSafeEqual 只接受 Uint8Array')
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

/** 常数时间判断"不等于"（语义糖，便于失败路径书写）。 */
export function timingSafeNotEqual(a, b) {
  return !timingSafeEqual(a, b)
}
