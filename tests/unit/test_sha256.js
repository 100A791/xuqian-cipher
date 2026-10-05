/**
 * SHA-256 向量测试 —— SPEC 第 5 节阶段一验收标准：「SHA-256 全部向量通过」。
 *
 * 被测 = src/selfcrypto/crypto/sha256.js（自研）
 * 期望 = tests/vectors/sha256_vectors.json（由 OpenSSL 生成，两边相互独立）
 *
 * 运行：node tests/unit/test_sha256.js
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Sha256, sha256, sha256Hex } from '../../src/selfcrypto/crypto/sha256.js'
import { assertEqual, assertTrue, bytesToHex, createRunner, materialize } from './_helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(resolve(here, '../vectors/sha256_vectors.json'), 'utf8'))

const runner = createRunner('SHA-256（自研实现 vs OpenSSL 向量）')
console.log(`向量来源：${vectors.generatedBy}`)

for (const testCase of vectors.cases) {
  await runner.test(testCase.name, () => {
    const input = materialize(testCase.input)
    assertEqual(sha256Hex(input), testCase.expect, '摘要')
  })
}

await runner.test('分片 update 与一次 update 结果一致（跨块边界分片）', () => {
  const data = Buffer.alloc(500, 97)
  const whole = sha256Hex(data)
  for (const size of [1, 7, 63, 64, 65, 128, 499]) {
    const hasher = new Sha256()
    for (let off = 0; off < data.length; off += size) hasher.update(data.subarray(off, Math.min(off + size, data.length)))
    assertEqual(hasher.hexDigest(false), whole, `分片大小 ${size}`)
  }
})

await runner.test('digest() 可重复调用且返回副本（不会被后续调用污染）', () => {
  const hasher = new Sha256().update(Buffer.from('abc'))
  const first = hasher.digest()
  const second = hasher.digest()
  assertEqual(bytesToHex(first), bytesToHex(second), '两次 digest')
  first[0] ^= 0xff
  assertEqual(bytesToHex(hasher.digest()), bytesToHex(second), '外部改动不应影响内部状态')
})

await runner.test('结束后再 update 会报错（不静默吞掉）', () => {
  const hasher = new Sha256().update(Buffer.from('a'))
  hasher.digest()
  let threw = false
  try {
    hasher.update(Buffer.from('b'))
  } catch {
    threw = true
  }
  assertTrue(threw, '应当抛错')
})

await runner.test('非 Uint8Array 输入被拒绝', () => {
  let threw = false
  try {
    sha256('字符串不是字节')
  } catch {
    threw = true
  }
  assertTrue(threw, '应当抛错')
})

runner.finish()
