/**
 * 字节工具 —— 自研路线内部共用。
 *
 * 为什么单独放一个文件：SPEC §2 的 common 目录列了 fail/delay/validate/constants，
 * 但三个以上模块都要拼接与复制字节，与其各处重写，不如集中一处（也避免"复制实现随时间分叉"）。
 *
 * 注意：**一律用 `new Uint8Array(x)` 复制，不要用 `x.slice()`**。
 * Node 的 `Buffer.prototype.slice` 其实是 subarray（共享内存的视图），
 * 用它"复制"会变成别名，进而就地改写调用方的缓冲区（AES 那边已经踩过一次）。
 *
 * 唯一的例外是**刻意的零拷贝**：需要引用大块数据（如整份载荷）而不复制时，
 * 明确写 `subarray()` —— 让"这是视图"这个意图落在代码上。
 * 关键在于：**不要用 `.slice()` 去表达"我想要一份副本"**（在 Buffer 上它不是副本）。
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const utf8Encode = (text) => encoder.encode(text)

/** 严格 UTF-8 解码：非法字节抛错而不是替换成 U+FFFD。 */
export function utf8Decode(bytes) {
  return decoder.decode(bytes)
}

/** 复制一份（保证与入参不共享内存）。 */
export function copyBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('copyBytes 只接受 Uint8Array')
  return new Uint8Array(bytes)
}

/** 顺序拼接若干字节串。 */
export function concatBytes(...parts) {
  let total = 0
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) throw new TypeError('concatBytes 只接受 Uint8Array')
    total += part.length
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const part of parts) {
    out.set(part, off)
    off += part.length
  }
  return out
}

/** 取前 n 字节的**副本**（不用 slice，语义与内存行为都更明确）。 */
export function takeBytes(bytes, n) {
  if (n > bytes.length) throw new RangeError('takeBytes 超出长度')
  const out = new Uint8Array(n)
  out.set(bytes.subarray(0, n))
  return out
}

/** 大端写入 u64（用于计数器拼接）。 */
export function writeUint64BE(value) {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
  return out
}
