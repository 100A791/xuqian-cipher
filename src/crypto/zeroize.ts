/**
 * 敏感内存擦除工具。
 *
 * 说明与边界（必须如实告知用户，见 docs/SECURITY.md）：
 * - Uint8Array / ArrayBuffer 中的密钥字节可以被可靠覆写（本模块负责）。
 * - JavaScript 字符串是不可变值，无法被主动擦除；因此任何把密钥转成
 *   String 的地方（Hex / Base64 / 输入框回显）都只能依赖 GC，无法保证即时清除。
 *   本项目因此把"权威密钥"始终保存在 Worker 的 Uint8Array 里，
 *   仅在"一次性密钥弹窗"打开期间才生成字符串副本，并在关闭时立刻丢弃引用。
 */

/** 覆写并清零字节数组；容忍 null/undefined。 */
export function zeroize(...buffers: Array<Uint8Array | null | undefined>): void {
  for (const buf of buffers) {
    if (buf && buf.length > 0) buf.fill(0)
  }
}

/** 复制一份独立的字节副本（避免共享底层 buffer）。 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}

/** 把 Uint8Array 转成独立 ArrayBuffer（用于 postMessage transfer，同时避免 SAB 类型问题）。 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/** 常量时间比较，用于校验指纹、校验和、tag 等短字节串。 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * 尽力而为的"安全字符串"容器：仅用于密钥弹窗等极短生命周期场景。
 * 关闭弹窗时必须调用 destroy()，它会清空内部字节并丢弃字符串引用。
 */
export class SecureText {
  #bytes: Uint8Array
  #text: string | null = null
  #destroyed = false

  constructor(bytes: Uint8Array) {
    this.#bytes = copyBytes(bytes)
  }

  get destroyed(): boolean {
    return this.#destroyed
  }

  /** 惰性生成字符串视图。注意：生成的 String 无法被擦除。 */
  reveal(): string {
    if (this.#destroyed) throw new Error('SecureText already destroyed')
    if (this.#text === null) this.#text = bytesToUtf8(this.#bytes)
    return this.#text
  }

  destroy(): void {
    zeroize(this.#bytes)
    this.#bytes = new Uint8Array(0)
    this.#text = null
    this.#destroyed = true
  }
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

export function utf8ToBytes(text: string): Uint8Array {
  return utf8Encoder.encode(text)
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes)
}
