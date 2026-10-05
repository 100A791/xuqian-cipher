/**
 * 随机数封装测试 —— SPEC 第 4 节阶段零（random.js 只封装 CSPRNG）、第 7 节（禁止自研随机算法）。
 *
 * 本套件的存在理由：randomUint32() 曾经写成 `new Uint32Array(randomBytes(4))[0]`。
 * 用 TypedArray 作参数构造时是**逐元素复制**而不是 buffer 视图，于是得到 4 个各自 0~255 的元素，
 * [0] 只是第一个字节 —— 随机性从 32 位退化成 8 位。
 * 由于当时没有任何调用方（密钥材料都直接走 randomBytes），这个 bug 一直潜伏；
 * 直到统一失败延迟改用 randomInt 才被暴露。以下断言把它钉死，防止回归。
 */
import { createRunner, assertTrue, assertEqual } from './_helpers.js'
import { randomBytes, randomUint32, randomInt } from '../../src/selfcrypto/crypto/random.js'

const runner = createRunner('随机数封装（CSPRNG 包装 / 位数完整性 / 区间取值）')

await runner.test('randomBytes：长度为 0/1/16/32/1024 时都返回对应长度的 Uint8Array', () => {
  for (const n of [0, 1, 16, 32, 1024]) {
    const b = randomBytes(n)
    assertTrue(b instanceof Uint8Array, `长度 ${n} 应返回 Uint8Array`)
    assertEqual(b.length, n, `长度 ${n}`)
  }
})

await runner.test('randomBytes：非法长度被拒绝（负数 / 非整数）', () => {
  let threw = 0
  try { randomBytes(-1) } catch { threw++ }
  try { randomBytes(1.5) } catch { threw++ }
  assertEqual(threw, 2, '负数与非整数都应抛错')
})

await runner.test('randomBytes：两次调用结果不同（不是常量）', () => {
  const a = randomBytes(32)
  const b = randomBytes(32)
  assertTrue(a.some((v, i) => v !== b[i]), '两次 32 字节不应完全相同')
})

await runner.test('randomUint32：使用完整的 32 位（回归：曾退化成 8 位）', () => {
  const samples = []
  for (let i = 0; i < 256; i++) samples.push(randomUint32())
  assertTrue(samples.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff), '应落在 uint32 值域内')
  // 若只有 8 位随机性，则全部样本必然 < 256（256 次全命中的概率约 256!/256^256 ≈ 0）
  const max = Math.max(...samples)
  assertTrue(max >= 256, `最大值应超过 255（实际 ${max}）—— 说明只用了 1 个字节`)
  // 最高位被置位的概率是 1/2，256 次全都为 0 的概率是 2^-256，可视为必然出现
  assertTrue(samples.some((v) => v >= 0x80000000), '应当至少出现一个 ≥ 2^31 的样本（高位参与随机）')
})

await runner.test('randomInt：闭区间取值，边界都能取到', () => {
  for (const v of [randomInt(0, 0), randomInt(7, 7)]) assertTrue(Number.isInteger(v), '整数')
  assertEqual(randomInt(0, 0), 0, '[0,0] 只能是 0')
  const samples = []
  for (let i = 0; i < 400; i++) samples.push(randomInt(4000, 5000))
  const min = Math.min(...samples)
  const max = Math.max(...samples)
  assertTrue(min >= 4000 && max <= 5000, `全部应落在 [4000,5000]（实际 ${min}~${max}）`)
  assertTrue(max - min > 700, `覆盖范围应接近整个区间（实际跨度 ${max - min}）`)
})

await runner.test('randomInt：非法区间被拒绝（max < min / 非整数）', () => {
  let threw = 0
  try { randomInt(5, 1) } catch { threw++ }
  try { randomInt(0.5, 3) } catch { threw++ }
  assertEqual(threw, 2, '两种非法入参都应抛错')
})

await runner.test('randomInt：无取模偏置 —— 小跨度下各值频次大致均衡', () => {
  const span = 6
  const counts = new Array(span).fill(0)
  const n = 6000
  for (let i = 0; i < n; i++) counts[randomInt(0, span - 1)]++
  const expected = n / span
  const maxDeviation = Math.max(...counts.map((c) => Math.abs(c - expected)))
  // 拒绝采样下，6000 次抽样每个桶的偏差应远小于 20%（3σ ≈ 3×√(n·p·(1-p)) ≈ 87）
  assertTrue(maxDeviation < expected * 0.2, `频次偏差过大：${maxDeviation}（期望约 ${expected}）`)
})

await runner.test('randomBytes：超过 65536 字节也能取（回归：WebCrypto 单次上限）', () => {
  // WebCrypto 规定 getRandomValues 单次最多 65536 字节，超限会抛 QuotaExceededError
  // （名字还容易被误读成"磁盘配额不足"）。必须分片填充，否则任何 >64 KiB 的请求直接崩。
  const a = randomBytes(65537)
  const b = randomBytes(65537)
  assertEqual(a.length, 65537, '65537 字节长度')
  assertTrue(new Set(a).size > 100, '取值应散布（不是常量或局部填充）')
  assertTrue(a.some((v, i) => v !== b[i]), '两次大块请求不应完全相同')
  // 覆盖更多分片：1 MiB 也要可用
  assertEqual(randomBytes(1024 * 1024).length, 1024 * 1024, '1 MiB 长度')
})

await runner.test('randomInt：区间宽于 32 位随机源时被拒绝（回归：limit=0 会死循环）', () => {
  // span > 2^32 时 Math.floor(2^32 / span) === 0 → limit=0 → `value < 0` 永不成立 → 死循环。
  // 必须显式拒绝，不能依赖"调用方不会这么传"。
  let threw = false
  try {
    randomInt(0, 0x100000000)
  } catch {
    threw = true
  }
  assertTrue(threw, 'span 超过 2^32 必须抛错')
})

runner.finish()
