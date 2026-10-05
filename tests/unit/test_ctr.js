/**
 * AES-CTR 向量测试 —— SPEC 第 5 节阶段一验收标准：「AES-CTR 全部向量通过」（SP 800-38A）。
 * 被测 = src/selfcrypto/crypto/ctr.js（自研）；期望 = OpenSSL 生成。
 * 运行：node tests/unit/test_ctr.js
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { aesCtr, counterFromNonce, incrementCounter } from '../../src/selfcrypto/crypto/ctr.js'
import { assertEqual, assertTrue, bytesToHex, createRunner, materialize } from './_helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(resolve(here, '../vectors/ctr_vectors.json'), 'utf8'))

const runner = createRunner('AES-CTR（自研实现 vs SP 800-38A / OpenSSL）')
console.log(`向量来源：${vectors.generatedBy}`)

for (const testCase of vectors.cases) {
  await runner.test(testCase.name, () => {
    const out = aesCtr(materialize(testCase.key), materialize(testCase.counter), materialize(testCase.plaintext))
    assertEqual(bytesToHex(out), testCase.expect, '密文')
  })
}

await runner.test('CTR 加解密同构：密文再跑一遍还原明文', () => {
  for (const testCase of vectors.cases) {
    const key = materialize(testCase.key)
    const counter = materialize(testCase.counter)
    const plaintext = materialize(testCase.plaintext)
    const ciphertext = aesCtr(key, counter, plaintext)
    const restored = aesCtr(key, counter, ciphertext)
    assertEqual(bytesToHex(restored), bytesToHex(plaintext), testCase.name)
  }
})

await runner.test('输出长度与输入相同（流式模式，不补齐）', () => {
  const key = materialize({ bytes: Array(16).fill(7) })
  const counter = materialize({ bytes: Array(16).fill(0) })
  for (const len of [0, 1, 15, 16, 17, 100]) {
    assertEqual(aesCtr(key, counter, new Uint8Array(len)).length, len, `长度 ${len}`)
  }
})

await runner.test('计数器自增为大端 128 位，并按字节序回绕', () => {
  const c = materialize({ bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff] })
  incrementCounter(c)
  assertEqual(bytesToHex(c), '00000000000000000000000000000100', '末字节 0xff → 进位')
  const all = materialize({ bytes: Array(16).fill(0xff) })
  incrementCounter(all)
  assertEqual(bytesToHex(all), '00000000000000000000000000000000', '全 ff → 回绕到全零')
})

await runner.test('不同计数器产出不同密钥流（同密钥不得复用计数器）', () => {
  const key = materialize({ bytes: Array(16).fill(3) })
  const plain = new Uint8Array(32).fill(0)
  const a = aesCtr(key, materialize({ bytes: Array(16).fill(0) }), plain)
  const b = aesCtr(key, materialize({ bytes: Array(16).fill(1) }), plain)
  assertTrue(bytesToHex(a) !== bytesToHex(b), '不同计数器不应给出相同密钥流')
})

await runner.test('参数非法时拒绝：计数器或 nonce 长度不是 16 字节', () => {
  const key = materialize({ bytes: Array(16).fill(1) })
  for (const len of [0, 8, 15, 17]) {
    let threw = false
    try {
      aesCtr(key, new Uint8Array(len), new Uint8Array(4))
    } catch {
      threw = true
    }
    assertTrue(threw, `计数器长度 ${len} 应当抛错`)

    let threw2 = false
    try {
      counterFromNonce(new Uint8Array(len))
    } catch {
      threw2 = true
    }
    assertTrue(threw2, `nonce 长度 ${len} 应当抛错`)
  }
})

await runner.test('counterFromNonce 返回副本（外部改动不影响内部）', () => {
  const nonce = new Uint8Array(16).fill(9)
  const counter = counterFromNonce(nonce)
  nonce[0] = 0
  assertEqual(counter[0], 9, '应当是副本')
})

await runner.test('加密不改写调用方的计数器与输入（否则会复用密钥流）', () => {
  // 踩过的坑：Buffer.prototype.slice 是视图，早期实现会让 incrementCounter 改到调用方的 nonce 上。
  const key = Buffer.from(Array(16).fill(0x11))
  const counter = Buffer.from(Array(16).fill(0x22))
  const data = Buffer.from(Array(48).fill(0x33))
  const counterBefore = bytesToHex(counter)
  const dataBefore = bytesToHex(data)
  aesCtr(key, counter, data)
  assertEqual(bytesToHex(counter), counterBefore, '计数器不应被改写')
  assertEqual(bytesToHex(data), dataBefore, '输入数据不应被改写')
})

await runner.test('同一计数器对象连续用两次，结果必须相同（不被内部自增污染）', () => {
  const key = new Uint8Array(16).fill(0x44)
  const counter = new Uint8Array(16).fill(0x55)
  const data = new Uint8Array(32).fill(0x66)
  const first = bytesToHex(aesCtr(key, counter, data))
  const second = bytesToHex(aesCtr(key, counter, data))
  assertEqual(second, first, '复用同一计数器对象应得到同一结果')
})

runner.finish()
