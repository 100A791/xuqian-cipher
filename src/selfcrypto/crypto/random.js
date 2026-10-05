/**
 * 随机数 —— SPEC 第 4 节阶段零「写 random.js 封装 crypto.getRandomValues」。
 *
 * SPEC 第 7 节明令：**禁止自研随机数算法，必须用系统 CSPRNG**。
 * 因此本文件只做封装（取长度、填缓冲区），不实现任何随机算法本身。
 */

/**
 * WebCrypto 规定 `getRandomValues` 单次最多填充 65536 字节（64 KiB）。
 * 超过时抛的是 `QuotaExceededError` —— 名字容易被误读成"磁盘配额不足"，
 * 且不是本项目其它校验所用的 `RangeError`，排错时会走弯路。
 */
const GET_RANDOM_VALUES_MAX = 65536

/** 返回 length 字节的密码学安全随机数。 */
export function randomBytes(length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('randomBytes 长度非法')
  const out = new Uint8Array(length)
  // 必须分片：单次请求超过 65536 字节会被 WebCrypto 直接拒绝。
  // 分片与一次填充等价 —— CSPRNG 各段的输出互相独立，拼接不降低随机性。
  for (let offset = 0; offset < length; offset += GET_RANDOM_VALUES_MAX) {
    globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(offset + GET_RANDOM_VALUES_MAX, length)))
  }
  return out
}

export function randomUint32() {
  // 注意：不能用 new Uint32Array(randomBytes(4))[0] —— 用 TypedArray 作参数构造时是**逐元素复制**，
  // 会得到 4 个各自 0~255 的元素，[0] 只是第一个字节（即随机性退化到 8 位）。
  // 必须走 buffer 视图（或 DataView）才能把 4 个字节读成一个 32 位数。
  const bytes = randomBytes(4)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
}

/** 取 [min, max] 闭区间随机整数（使用 32 位随机源；不用于密钥材料）。 */
export function randomInt(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError('randomInt 区间非法')
  const span = max - min + 1
  // 区间宽于 32 位随机源时：既无法均匀采样，limit 还会算成 0（下面 value < 0 恒不成立 → 死循环）。
  // 因此必须显式拒绝，不能靠"调用方不会这么传"。
  if (span > 0x100000000) throw new RangeError('randomInt 区间宽于 32 位随机源，无法均匀采样')
  // 拒绝采样，避免取模偏置
  const limit = Math.floor(0x100000000 / span) * span
  for (;;) {
    const value = randomUint32()
    if (value < limit) return min + (value % span)
  }
}
