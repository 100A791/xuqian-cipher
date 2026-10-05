/**
 * SM4 分组密码（GB/T 32907-2016）+ GCM 认证模式（NIST SP 800-38D 组合方式）。
 *
 * 背景说明（不允许自创密码学）：
 * SM4 本身是公开国家标准算法，S 盒与轮常量来自标准文本，不是"自创算法"。
 * GCM 的构造方式（CTR 加密 + GHASH 认证）完全遵循 NIST SP 800-38D，
 * 只是把底层分组密码换成 SM4（即国密 TLS 中使用的 SM4-GCM 套件）。
 * 本实现刻意写得直白易审计，不追求极致性能；默认场景推荐 AES-GCM / ChaCha20。
 */

const SBOX = new Uint8Array([
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
  0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
  0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
  0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
  0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
  0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
  0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
  0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
  0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
  0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
  0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
  0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
  0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
  0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
  0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
  0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
])

const FK = new Uint32Array([0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc])

const CK = new Uint32Array([
  0x00070e15, 0x1c232a31, 0x383f464d, 0x545b6269, 0x70777e85, 0x8c939aa1, 0xa8afb6bd, 0xc4cbd2d9,
  0xe0e7eef5, 0xfc030a11, 0x181f262d, 0x343b4249, 0x50575e65, 0x6c737a81, 0x888f969d, 0xa4abb2b9,
  0xc0c7ced5, 0xdce3eaf1, 0xf8ff060d, 0x141b2229, 0x30373e45, 0x4c535a61, 0x686f767d, 0x848b9299,
  0xa0a7aeb5, 0xbcc3cad1, 0xd8dfe6ed, 0xf4fb0209, 0x10171e25, 0x2c333a41, 0x484f565d, 0x646b7279,
])

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

function tau(a: number): number {
  return (
    ((SBOX[(a >>> 24) & 0xff] << 24) |
      (SBOX[(a >>> 16) & 0xff] << 16) |
      (SBOX[(a >>> 8) & 0xff] << 8) |
      SBOX[a & 0xff]) >>>
    0
  )
}

function tTransform(x: number): number {
  const b = tau(x)
  return (b ^ rotl32(b, 2) ^ rotl32(b, 10) ^ rotl32(b, 18) ^ rotl32(b, 24)) >>> 0
}

function keyTransform(x: number): number {
  const b = tau(x)
  return (b ^ rotl32(b, 13) ^ rotl32(b, 23)) >>> 0
}

export class Sm4 {
  readonly #rk = new Uint32Array(32)
  readonly blockSize = 16

  constructor(key: Uint8Array) {
    if (key.length !== 16) throw new Error('SM4 requires a 16-byte key')
    const k = new Uint32Array(4)
    for (let i = 0; i < 4; i++) {
      k[i] = ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0
      k[i] = (k[i] ^ FK[i]) >>> 0
    }
    for (let i = 0; i < 32; i++) {
      const x = (k[1] ^ k[2] ^ k[3] ^ CK[i]) >>> 0
      const t = keyTransform(x)
      const rk = (k[0] ^ t) >>> 0
      this.#rk[i] = rk
      k[0] = k[1]
      k[1] = k[2]
      k[2] = k[3]
      k[3] = rk
    }
  }

  /** 原地加密一个 16 字节分组（输入必须是块大小的倍数）。 */
  encryptBlock(src: Uint8Array, srcOff: number, dst: Uint8Array, dstOff: number): void {
    let x0 = ((src[srcOff] << 24) | (src[srcOff + 1] << 16) | (src[srcOff + 2] << 8) | src[srcOff + 3]) >>> 0
    let x1 = ((src[srcOff + 4] << 24) | (src[srcOff + 5] << 16) | (src[srcOff + 6] << 8) | src[srcOff + 7]) >>> 0
    let x2 = ((src[srcOff + 8] << 24) | (src[srcOff + 9] << 16) | (src[srcOff + 10] << 8) | src[srcOff + 11]) >>> 0
    let x3 = ((src[srcOff + 12] << 24) | (src[srcOff + 13] << 16) | (src[srcOff + 14] << 8) | src[srcOff + 15]) >>> 0
    for (let i = 0; i < 32; i++) {
      const t = tTransform((x1 ^ x2 ^ x3 ^ this.#rk[i]) >>> 0)
      const nx = (x0 ^ t) >>> 0
      x0 = x1
      x1 = x2
      x2 = x3
      x3 = nx
    }
    // 反序变换
    dst[dstOff] = x3 >>> 24
    dst[dstOff + 1] = (x3 >>> 16) & 0xff
    dst[dstOff + 2] = (x3 >>> 8) & 0xff
    dst[dstOff + 3] = x3 & 0xff
    dst[dstOff + 4] = x2 >>> 24
    dst[dstOff + 5] = (x2 >>> 16) & 0xff
    dst[dstOff + 6] = (x2 >>> 8) & 0xff
    dst[dstOff + 7] = x2 & 0xff
    dst[dstOff + 8] = x1 >>> 24
    dst[dstOff + 9] = (x1 >>> 16) & 0xff
    dst[dstOff + 10] = (x1 >>> 8) & 0xff
    dst[dstOff + 11] = x1 & 0xff
    dst[dstOff + 12] = x0 >>> 24
    dst[dstOff + 13] = (x0 >>> 16) & 0xff
    dst[dstOff + 14] = (x0 >>> 8) & 0xff
    dst[dstOff + 15] = x0 & 0xff
  }

  encryptBlocks(src: Uint8Array): Uint8Array {
    if (src.length === 0 || src.length % 16 !== 0) throw new Error('SM4 input must be a non-empty multiple of 16 bytes')
    const out = new Uint8Array(src.length)
    for (let off = 0; off < src.length; off += 16) this.encryptBlock(src, off, out, off)
    return out
  }
}

/** GF(2^128) 乘法，对应 GCM 规范中的 multiplication 操作。 */
function gfMul(X: Uint32Array, Y: Uint32Array): Uint32Array {
  const Z = new Uint32Array(4)
  const V = new Uint32Array(4)
  V.set(Y)
  for (let i = 0; i < 128; i++) {
    const bit = (X[i >>> 5] >>> (31 - (i & 31))) & 1
    if (bit) {
      Z[0] ^= V[0]
      Z[1] ^= V[1]
      Z[2] ^= V[2]
      Z[3] ^= V[3]
    }
    const lsb = V[3] & 1
    V[3] = ((V[3] >>> 1) | (V[2] << 31)) >>> 0
    V[2] = ((V[2] >>> 1) | (V[1] << 31)) >>> 0
    V[1] = ((V[1] >>> 1) | (V[0] << 31)) >>> 0
    V[0] = V[0] >>> 1
    if (lsb) V[0] ^= 0xe1000000
  }
  return Z
}

function bytesToBlock(bytes: Uint8Array, off: number): Uint32Array {
  const w = new Uint32Array(4)
  for (let i = 0; i < 4; i++) {
    w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0
  }
  return w
}

function blockToBytes(w: Uint32Array, out: Uint8Array, off: number): void {
  for (let i = 0; i < 4; i++) {
    out[off + i * 4] = w[i] >>> 24
    out[off + i * 4 + 1] = (w[i] >>> 16) & 0xff
    out[off + i * 4 + 2] = (w[i] >>> 8) & 0xff
    out[off + i * 4 + 3] = w[i] & 0xff
  }
}

function ghash(H: Uint32Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  let Y = new Uint32Array(4)

  const feed = (data: Uint8Array) => {
    for (let off = 0; off < data.length; off += 16) {
      const block = new Uint8Array(16)
      const take = Math.min(16, data.length - off)
      block.set(data.subarray(off, off + take))
      const X = bytesToBlock(block, 0)
      X[0] ^= Y[0]
      X[1] ^= Y[1]
      X[2] ^= Y[2]
      X[3] ^= Y[3]
      Y = gfMul(X, H)
    }
  }

  feed(aad)
  feed(ciphertext)

  const lenBlock = new Uint8Array(16)
  const aadBits = aad.length * 8
  const ctBits = ciphertext.length * 8
  const view = new DataView(lenBlock.buffer)
  view.setUint32(0, Math.floor(aadBits / 0x100000000))
  view.setUint32(4, aadBits >>> 0)
  view.setUint32(8, Math.floor(ctBits / 0x100000000))
  view.setUint32(12, ctBits >>> 0)
  const X = bytesToBlock(lenBlock, 0)
  X[0] ^= Y[0]
  X[1] ^= Y[1]
  X[2] ^= Y[2]
  X[3] ^= Y[3]
  Y = gfMul(X, H)

  const out = new Uint8Array(16)
  blockToBytes(Y, out, 0)
  return out
}

function inc32(counter: Uint8Array): void {
  for (let i = 15; i >= 12; i--) {
    counter[i] = (counter[i] + 1) & 0xff
    if (counter[i] !== 0) break
  }
}

function ctrCrypt(sm4: Sm4, iv: Uint8Array, input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  const counter = new Uint8Array(16)
  counter.set(iv)
  const keystream = new Uint8Array(16)
  for (let off = 0; off < input.length; off += 16) {
    sm4.encryptBlock(counter, 0, keystream, 0)
    const take = Math.min(16, input.length - off)
    for (let i = 0; i < take; i++) out[off + i] = input[off + i] ^ keystream[i]
    inc32(counter)
  }
  return out
}

/**
 * SM4-GCM 加密。返回 ciphertext||tag（与 WebCrypto AES-GCM 的输出布局一致）。
 * aad 通过 GCM 的附加认证数据参与 GHASH。
 */
export function sm4GcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  if (nonce.length !== 12) throw new Error('SM4-GCM requires a 12-byte nonce')
  const sm4 = new Sm4(key)
  const Hbytes = new Uint8Array(16)
  sm4.encryptBlock(new Uint8Array(16), 0, Hbytes, 0)
  const H = bytesToBlock(Hbytes, 0)

  const J0 = new Uint8Array(16)
  J0.set(nonce)
  J0[15] = 1
  const counter = new Uint8Array(16)
  counter.set(J0)
  inc32(counter)

  const ct = ctrCrypt(sm4, counter, plaintext)
  const S = ghash(H, aad, ct)

  const tagMask = new Uint8Array(16)
  sm4.encryptBlock(J0, 0, tagMask, 0)
  const tag = new Uint8Array(16)
  for (let i = 0; i < 16; i++) tag[i] = S[i] ^ tagMask[i]

  const out = new Uint8Array(ct.length + 16)
  out.set(ct, 0)
  out.set(tag, ct.length)
  return out
}

/** SM4-GCM 解密；tag 校验失败抛错（不区分具体原因）。 */
export function sm4GcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array {
  if (nonce.length !== 12) throw new Error('SM4-GCM requires a 12-byte nonce')
  if (sealed.length < 16) throw new Error('authentication failed')
  const ct = sealed.subarray(0, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)

  const sm4 = new Sm4(key)
  const Hbytes = new Uint8Array(16)
  sm4.encryptBlock(new Uint8Array(16), 0, Hbytes, 0)
  const H = bytesToBlock(Hbytes, 0)

  const J0 = new Uint8Array(16)
  J0.set(nonce)
  J0[15] = 1
  const S = ghash(H, aad, ct)
  const tagMask = new Uint8Array(16)
  sm4.encryptBlock(J0, 0, tagMask, 0)

  let diff = 0
  for (let i = 0; i < 16; i++) diff |= (S[i] ^ tagMask[i]) ^ tag[i]
  if (diff !== 0) throw new Error('authentication failed')

  const counter = new Uint8Array(16)
  counter.set(J0)
  inc32(counter)
  return ctrCrypt(sm4, counter, ct)
}
