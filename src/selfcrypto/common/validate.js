/**
 * 输入校验 —— SPEC 第 2 节 common 目录（validate.js）。
 * 只做长度/类型/取值范围的机械校验；不做任何"容错猜测"，不明确即拒绝。
 */

export function isBytes(value) {
  return value instanceof Uint8Array
}

export function assertBytes(value, name) {
  if (!isBytes(value)) throw new TypeError(`${name} 必须是 Uint8Array`)
  return value
}

export function assertExactLength(value, length, name) {
  assertBytes(value, name)
  if (value.length !== length) throw new RangeError(`${name} 长度必须是 ${length}，实际 ${value.length}`)
  return value
}

export function assertEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new RangeError(`${name} 取值非法：${String(value)}`)
  return value
}

export function assertIntegerInRange(value, [min, max], name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} 必须是 ${min}~${max} 之间的整数，实际 ${String(value)}`)
  }
  return value
}
