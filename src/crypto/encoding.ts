/** Hex / Base64 / UTF-8 编解码（不依赖 Node Buffer，浏览器与测试环境通用）。 */

const HEX_CHARS = '0123456789abcdef'

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    out += HEX_CHARS[b >>> 4] + HEX_CHARS[b & 0x0f]
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/[\s:]/g, '')
  if (clean.length === 0 || clean.length % 2 !== 0) throw new Error('INVALID_HEX')
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error('INVALID_HEX')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64_CHARS[(n >>> 18) & 63] + B64_CHARS[(n >>> 12) & 63] + B64_CHARS[(n >>> 6) & 63] + B64_CHARS[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64_CHARS[(n >>> 18) & 63] + B64_CHARS[(n >>> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64_CHARS[(n >>> 18) & 63] + B64_CHARS[(n >>> 12) & 63] + B64_CHARS[(n >>> 6) & 63] + '='
  }
  return out
}

const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i
  return table
})()

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.trim().replace(/[\s\r\n]/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (clean.length === 0) throw new Error('INVALID_BASE64')
  if (!/^[A-Za-z0-9+/]+$/.test(clean)) throw new Error('INVALID_BASE64')
  const outLen = Math.floor((clean.length * 6) / 8)
  const out = new Uint8Array(outLen)
  let acc = 0
  let bits = 0
  let pos = 0
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i)
    const val = code < 128 ? B64_LOOKUP[code] : -1
    if (val < 0) throw new Error('INVALID_BASE64')
    acc = (acc << 6) | val
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[pos++] = (acc >>> bits) & 0xff
    }
  }
  return out
}

/** 把多个字节块拼接为一个数组。 */
export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** 时间戳格式化（本地时间，仅用于 UI 显示）。 */
export function formatTS(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
