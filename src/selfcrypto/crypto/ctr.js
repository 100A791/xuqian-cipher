/**
 * AES-CTR —— SPEC 第 5 节阶段一「再写 ctr.js，跑 NIST SP 800-38A 测试向量」。
 * 自研实现，不引入任何第三方库（SPEC 第 7 节）。
 *
 * 注意 CTR 是流式模式：加密与解密是**同一个操作**（明文/密文异或同一段密钥流）。
 * SPEC §7 禁止 nonce 复用 —— 因此调用方必须保证同一个 (密钥, 初始计数器) 只用一次，
 * 本模块不做任何"自动换 nonce"的隐式行为，避免掩盖调用方的错误。
 */
import { encryptBlock, expandKey } from './aes.js'

/** 128 位大端计数器自增（SP 800-38A §B.1）。 */
export function incrementCounter(counter) {
  for (let i = 15; i >= 0; i--) {
    counter[i] = (counter[i] + 1) & 0xff
    if (counter[i] !== 0) break
  }
  return counter
}

/**
 * AES-CTR 变换（加密与解密同构）。
 * @param {Uint8Array|{roundKeys:Uint8Array,rounds:number}} key 原始密钥或已扩展密钥
 * @param {Uint8Array} initialCounter 16 字节初始计数器（必须唯一）
 * @param {Uint8Array} data 明文或密文
 * @returns {Uint8Array} 与 data 等长的输出
 */
export function aesCtr(key, initialCounter, data) {
  if (!(initialCounter instanceof Uint8Array) || initialCounter.length !== 16) {
    throw new RangeError('CTR 初始计数器必须是 16 字节')
  }
  if (!(data instanceof Uint8Array)) throw new TypeError('aesCtr 的 data 必须是 Uint8Array')

  const schedule = key && key.roundKeys ? key : expandKey(key)
  // 显式复制：Node Buffer.prototype.slice 是视图，用 slice() 会让 incrementCounter
  // 改到调用方传进来的 nonce / 计数器上（同一个 nonce 会被下一个 chunk 复用 → 密钥流重用）。
  const counter = new Uint8Array(initialCounter)
  const out = new Uint8Array(data.length)

  for (let offset = 0; offset < data.length; offset += 16) {
    const keyStream = encryptBlock(counter, schedule)
    const n = Math.min(16, data.length - offset)
    for (let i = 0; i < n; i++) out[offset + i] = data[offset + i] ^ keyStream[i]
    incrementCounter(counter)
  }
  return out
}

/**
 * 由 16 字节 nonce 构造初始计数器。
 * 本函数只做「原样使用」，不做任何域分隔——计数器唯一性由调用方（格式层）负责，
 * 这样才不会把"nonce 复用"这种致命错误藏在工具函数里。
 */
export function counterFromNonce(nonce) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 16) throw new RangeError('nonce 必须是 16 字节')
  return new Uint8Array(nonce)
}
