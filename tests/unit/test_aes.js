/**
 * AES 单块向量测试 —— SPEC 第 5 节阶段一验收标准：「AES 全部向量通过」（FIPS 197）。
 * 被测 = src/selfcrypto/crypto/aes.js（自研）；期望 = OpenSSL 生成。
 * 运行：node tests/unit/test_aes.js
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SBOX, encryptBlock, expandKey } from '../../src/selfcrypto/crypto/aes.js'
import { assertEqual, assertTrue, bytesToHex, createRunner, materialize } from './_helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(resolve(here, '../vectors/aes_vectors.json'), 'utf8'))

const runner = createRunner('AES 单块（自研实现 vs FIPS 197 / OpenSSL）')
console.log(`向量来源：${vectors.generatedBy}`)

for (const testCase of vectors.cases) {
  await runner.test(testCase.name, () => {
    const out = encryptBlock(materialize(testCase.plaintext), materialize(testCase.key))
    assertEqual(bytesToHex(out), testCase.expect, '密文')
  })
}

await runner.test('S-box 由数学定义生成，抽检已知值', () => {
  // 抽检几个教科书上公认的 S-box 取值（生成错误时这些点会立刻暴露）
  const checkpoints = [
    [0x00, 0x63],
    [0x01, 0x7c],
    [0x53, 0xed],
    [0x10, 0xca],
    [0xff, 0x16],
    [0x80, 0xcd],
  ]
  for (const [input, expected] of checkpoints) {
    assertEqual(SBOX[input], expected, `SBOX[0x${input.toString(16)}]`)
  }
  assertEqual(new Set(SBOX).size, 256, 'S-box 必须是 256 个互不相同的值（双射）')
})

await runner.test('密钥长度非法时拒绝（不是 16/24/32 字节）', () => {
  for (const len of [0, 8, 15, 17, 23, 25, 31, 33]) {
    let threw = false
    try {
      expandKey(new Uint8Array(len))
    } catch {
      threw = true
    }
    assertTrue(threw, `长度 ${len} 应当抛错`)
  }
})

await runner.test('分组长度非法时拒绝', () => {
  const key = new Uint8Array(16)
  for (const len of [0, 15, 17, 32]) {
    let threw = false
    try {
      encryptBlock(new Uint8Array(len), key)
    } catch {
      threw = true
    }
    assertTrue(threw, `分组长度 ${len} 应当抛错`)
  }
})

await runner.test('轮密钥可复用：同一调度加密两块结果与分别扩展一致', () => {
  const key = materialize({ bytes: Array.from({ length: 16 }, (_, i) => i) })
  const schedule = expandKey(key)
  const a = encryptBlock(materialize({ bytes: Array.from({ length: 16 }, () => 0x11) }), schedule)
  const b = encryptBlock(materialize({ bytes: Array.from({ length: 16 }, () => 0x22) }), key)
  const b2 = encryptBlock(materialize({ bytes: Array.from({ length: 16 }, () => 0x22) }), schedule)
  assertEqual(bytesToHex(b), bytesToHex(b2), '复用调度结果')
  assertTrue(bytesToHex(a) !== bytesToHex(b), '不同明文应给出不同密文')
})

await runner.test('不依赖 slice() 语义：Buffer 与纯 Uint8Array 输入结果必须一致', () => {
  const raw = Array.from({ length: 16 }, (_, i) => i * 7 + 1)
  const keyRaw = Array.from({ length: 16 }, (_, i) => 0xa0 + i)
  const viaBytes = encryptBlock(new Uint8Array(raw), new Uint8Array(keyRaw))
  const viaBuffer = encryptBlock(Buffer.from(raw), Buffer.from(keyRaw))
  assertEqual(bytesToHex(viaBuffer), bytesToHex(viaBytes), 'Buffer 与 Uint8Array 结果')
})

await runner.test('加密不改写调用方的明文与密钥（无就地副作用）', () => {
  // 踩过的坑：Buffer.prototype.slice 是视图，早期实现会就地改写调用方缓冲区。
  const plaintext = Buffer.from(Array.from({ length: 16 }, (_, i) => i))
  const key = Buffer.from(Array.from({ length: 16 }, (_, i) => 0xff - i))
  const plainBefore = bytesToHex(plaintext)
  const keyBefore = bytesToHex(key)
  encryptBlock(plaintext, key)
  assertEqual(bytesToHex(plaintext), plainBefore, '明文不应被改写')
  assertEqual(bytesToHex(key), keyBefore, '密钥不应被改写')
})

runner.finish()
