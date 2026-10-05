/**
 * HMAC-SHA256 向量测试 —— SPEC 第 5 节阶段一验收标准：「HMAC 全部向量通过」。
 * 被测 = src/selfcrypto/crypto/hmac.js（自研）；期望 = OpenSSL 生成的 RFC 4231 用例。
 * 运行：node tests/unit/test_hmac.js
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hmacSha256, hmacSha256Hex, verifyHmac } from '../../src/selfcrypto/crypto/hmac.js'
import { assertEqual, assertTrue, createRunner, hexToBytes, materialize } from './_helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(resolve(here, '../vectors/hmac_vectors.json'), 'utf8'))

const runner = createRunner('HMAC-SHA256（自研实现 vs RFC 4231 / OpenSSL）')
console.log(`向量来源：${vectors.generatedBy}`)

for (const testCase of vectors.cases) {
  await runner.test(testCase.name, () => {
    assertEqual(hmacSha256Hex(materialize(testCase.key), materialize(testCase.message)), testCase.expect, 'MAC')
  })
}

await runner.test('输出长度恒为 32 字节', () => {
  const mac = hmacSha256(hexToBytes('00'), new Uint8Array(0))
  assertEqual(mac.length, 32, '长度')
})

await runner.test('RFC 2104 补零语义：仅尾部差零字节的密钥是等价密钥（必须给出同一 MAC）', () => {
  // 这不是缺陷而是规范行为：短于块长的密钥右侧补零，
  // 因此 00 01 与 00 01 00 补到 64 字节后完全一致，MAC 必然相同。
  // 记录它是为了提醒：不能靠 HMAC 的密钥长度去区分两个"尾部差零"的密钥。
  const a = hmacSha256Hex(hexToBytes('0001'), hexToBytes('deadbeef'))
  const b = hmacSha256Hex(hexToBytes('000100'), hexToBytes('deadbeef'))
  assertEqual(a, b, '尾部差零字节的等价密钥')
})

await runner.test('真正不同的密钥给出不同 MAC', () => {
  const a = hmacSha256Hex(hexToBytes('0001'), hexToBytes('deadbeef'))
  const b = hmacSha256Hex(hexToBytes('0002'), hexToBytes('deadbeef'))
  assertTrue(a !== b, '不同密钥不应得到同一 MAC')
})

await runner.test('verifyHmac 正确识别匹配与不匹配', () => {
  const key = hexToBytes('00112233445566778899aabbccddeeff')
  const message = hexToBytes('cafebabe')
  const good = hmacSha256(key, message)
  assertTrue(verifyHmac(key, message, good), '正确 MAC 应通过')
  const bad = good.slice()
  bad[31] ^= 0x01
  assertTrue(!verifyHmac(key, message, bad), '被改动一位的 MAC 必须失败')
  assertTrue(!verifyHmac(key, message, good.slice(0, 31)), '长度不符必须失败')
})

await runner.test('非 Uint8Array 输入被拒绝', () => {
  let threw = false
  try {
    hmacSha256('字符串', new Uint8Array(1))
  } catch {
    threw = true
  }
  assertTrue(threw, '应当抛错')
})

runner.finish()
