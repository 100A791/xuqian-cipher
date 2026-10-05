/**
 * PBKDF2-HMAC-SHA256 向量测试 —— SPEC 第 5 节阶段一验收标准：「PBKDF2 全部向量通过」。
 * 被测 = src/selfcrypto/crypto/pbkdf2.js（自研）；期望 = OpenSSL 生成。
 * 运行：node tests/unit/test_pbkdf2.js
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pbkdf2Sha256 } from '../../src/selfcrypto/crypto/pbkdf2.js'
import { assertEqual, assertTrue, bytesToHex, createRunner, materialize } from './_helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(resolve(here, '../vectors/pbkdf2_vectors.json'), 'utf8'))

const runner = createRunner('PBKDF2-HMAC-SHA256（自研实现 vs OpenSSL）')
console.log(`向量来源：${vectors.generatedBy}`)
if (vectors.specConflict) console.log(`⚠ SPEC 冲突说明：${vectors.specConflict}`)

for (const testCase of vectors.cases) {
  await runner.test(testCase.name, () => {
    const out = pbkdf2Sha256(
      materialize(testCase.password),
      materialize(testCase.salt),
      testCase.iterations,
      testCase.dkLen,
    )
    assertEqual(bytesToHex(out), testCase.expect, '派生密钥')
  })
}

await runner.test('输出长度严格等于 dkLen', () => {
  for (const dkLen of [1, 31, 32, 33, 64, 65, 96]) {
    const out = pbkdf2Sha256(materialize({ utf8: 'p' }), materialize({ utf8: 's' }), 2, dkLen)
    assertEqual(out.length, dkLen, `dkLen=${dkLen}`)
  }
})

await runner.test('iterations 或 dkLen 非法时拒绝（不静默纠正）', () => {
  const p = materialize({ utf8: 'p' })
  const s = materialize({ utf8: 's' })
  for (const bad of [
    () => pbkdf2Sha256(p, s, 0, 32),
    () => pbkdf2Sha256(p, s, -1, 32),
    () => pbkdf2Sha256(p, s, 1.5, 32),
    () => pbkdf2Sha256(p, s, 2, 0),
    () => pbkdf2Sha256('x', s, 2, 32),
  ]) {
    let threw = false
    try {
      bad()
    } catch {
      threw = true
    }
    assertTrue(threw, '应当抛错')
  }
})

runner.finish()
