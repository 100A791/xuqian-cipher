/**
 * 随机数 —— SPEC 第 4 节阶段零「写 random.js 封装 crypto.getRandomValues」。
 *
 * SPEC 第 7 节明令：**禁止自研随机数算法，必须用系统 CSPRNG**。
 * 因此本文件只做封装（取长度、填缓冲区），不实现任何随机算法本身。
 */

/** 返回 length 字节的密码学安全随机数。 */
export function randomBytes(length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('randomBytes 长度非法')
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

export function randomUint32() {
  return new Uint32Array(randomBytes(4))[0]
}

/** 取 [min, max] 闭区间随机整数（使用 32 位随机源；不用于密钥材料）。 */
export function randomInt(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError('randomInt 区间非法')
  const span = max - min + 1
  // 拒绝采样，避免取模偏置
  const limit = Math.floor(0x100000000 / span) * span
  for (;;) {
    const value = randomUint32()
    if (value < limit) return min + (value % span)
  }
}
