/**
 * 统一失败延迟测试 —— SPEC 第 5 节阶段七「跑统一失败延迟测试」。
 * SPEC §6 阶段二验收：「失败延迟 4 到 5 秒」。
 * 运行：node tests/unit/test_uniform_delay.js
 *
 * 这个文件会**真的等 4~5 秒**（两次真实失败），因为"延迟到底存不存在"只能实测；
 * 其余用例通过 setUniformDelayRange 覆盖成 0 来跑，避免整套测试被拖慢。
 */
import { encryptFile } from '../../src/selfcrypto/file/encrypt.js'
import { decryptFile } from '../../src/selfcrypto/file/decrypt.js'
import { UNIFORM_DELAY_MS } from '../../src/selfcrypto/common/constants.js'
import { resetUniformDelayRange, setUniformDelayRange, uniformDelayMs } from '../../src/selfcrypto/common/delay.js'
import { setInternalDiagnostics } from '../../src/selfcrypto/common/fail.js'
import { assertEqual, assertTrue, createRunner } from './_helpers.js'

const runner = createRunner('统一失败延迟（4~5 秒）')

const data = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 29 + seed * 17) & 0xff)
const key = data(16, 3)
const content = data(600, 4)
const { cipherBytes } = encryptFile(content, [['name', 'x.bin']], { masterKey: key })

setInternalDiagnostics(() => {})
resetUniformDelayRange()

await runner.test('SPEC §3 常量：默认延迟区间就是 4000~5000 毫秒', () => {
  assertEqual(UNIFORM_DELAY_MS[0], 4000, '下界')
  assertEqual(UNIFORM_DELAY_MS[1], 5000, '上界')
})

await runner.test('uniformDelayMs：抽样 400 次，全部落在区间内且有分布（不是固定值）', () => {
  const samples = []
  for (let i = 0; i < 400; i++) samples.push(uniformDelayMs())
  const below = samples.filter((v) => v < 4000).length
  const above = samples.filter((v) => v > 5000).length
  assertEqual(below, 0, `有 ${below} 次低于 4000ms`)
  assertEqual(above, 0, `有 ${above} 次高于 5000ms`)

  // 区间是 4000~5000 共 1001 个整数；抽样 400 次的"不同值个数"理论期望约 330
  // （生日问题：1001×(1−e^(−400/1001)) ≈ 330）。所以这里不能要求 distinct≈400。
  const distinct = new Set(samples).size
  assertTrue(distinct > 200, `取值应分散（不能是少数几个常数），实际 distinct=${distinct}`)
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  assertTrue(max - min > 700, `覆盖范围应接近整个区间，实际跨度 ${max - min}`)

  const mean = samples.reduce((s, v) => s + v, 0) / samples.length
  assertTrue(mean > 4300 && mean < 4700, `均值应接近 4500，实际 ${mean.toFixed(1)}`)
})

await runner.test('真实失败：错误密钥的耗时落在 4~5 秒（实测，不是读常量）', async () => {
  const started = Date.now()
  let message = ''
  try {
    await decryptFile(cipherBytes, data(16, 88))
  } catch (error) {
    message = error.message
  }
  const elapsed = Date.now() - started
  assertEqual(message, '解密失败', '文案')
  // 上下留一点调度余量，但必须明显超过 3.5 秒、明显低于 7 秒
  assertTrue(elapsed >= 3900, `耗时应 ≥3900ms，实际 ${elapsed}ms`)
  assertTrue(elapsed <= 6000, `耗时应 ≤6000ms，实际 ${elapsed}ms`)
  console.log(`      错误密钥失败耗时 ${elapsed}ms`)
})

await runner.test('真实失败：文件被篡改的耗时同样落在 4~5 秒（两种原因耗时不可区分）', async () => {
  const tampered = new Uint8Array(cipherBytes)
  tampered[tampered.length - 40] ^= 0x01
  const started = Date.now()
  let message = ''
  try {
    await decryptFile(tampered, key)
  } catch (error) {
    message = error.message
  }
  const elapsed = Date.now() - started
  assertEqual(message, '解密失败', '文案')
  assertTrue(elapsed >= 3900 && elapsed <= 6000, `耗时应在 3.9~6 秒，实际 ${elapsed}ms`)
  console.log(`      篡改文件失败耗时 ${elapsed}ms`)
})

await runner.test('测试钩子生效：把区间覆盖成 0 后失败立刻返回（便于其它测试跑得快）', async () => {
  setUniformDelayRange([0, 0])
  const started = Date.now()
  try {
    await decryptFile(cipherBytes, data(16, 77))
  } catch {
    /* 预期失败 */
  }
  const elapsed = Date.now() - started
  assertTrue(elapsed < 300, `覆盖后应立刻失败，实际 ${elapsed}ms`)
  resetUniformDelayRange()
})

await runner.test('非内核失败（如未选文件）不走延迟：延迟只属于密码学失败路径', async () => {
  // 用 16 字节以外的密钥会触发参数校验错误（TypeError/RangeError），不是统一失败
  setUniformDelayRange([0, 0])
  let isUniform = true
  try {
    await decryptFile(cipherBytes, new Uint8Array(8))
  } catch (error) {
    isUniform = error.code === 'XQ_UNIFORM_FAIL'
  }
  assertEqual(isUniform, false, '密钥长度非法属调用错误，不应算作统一失败')
  resetUniformDelayRange()
})

await runner.test('KEY_CHECK 在 MAC 之前：错误密钥不会进入解密（顺序正确）', async () => {
  // 通过内部诊断原因确认：错误密钥的失败原因是 key-check，而不是 mac
  const reasons = []
  setInternalDiagnostics((reason) => reasons.push(reason))
  setUniformDelayRange([0, 0])
  try {
    await decryptFile(cipherBytes, data(16, 66))
  } catch {
    /* 预期 */
  }
  assertEqual(reasons[0], 'key-check-mismatch', `应先撞 KEY_CHECK，实际 ${JSON.stringify(reasons)}`)
  resetUniformDelayRange()
  setInternalDiagnostics(() => {})
})

runner.finish()
