/**
 * 异常中断测试 —— SPEC 第 5 节阶段七「跑异常中断测试」。
 * 运行：node tests/unit/test_interrupt.js
 *
 * 判据（同时对应 SPEC §7 两条红线）：
 *   · 「禁止在失败时输出部分明文」→ 任何异常输入都必须**抛错**，绝不能返回半个明文；
 *   · 「禁止提示解密失败的具体原因」→ 无论断在哪一环，对外都是同一句「解密失败」。
 *
 * 覆盖：任意位置截断（横扫）、空文件、只剩头部、追加垃圾、全零、头部长度被篡改。
 */
import { encryptFile } from '../../src/selfcrypto/file/encrypt.js'
import { decryptFile } from '../../src/selfcrypto/file/decrypt.js'
import { HEADER_LEN, MAC_OFFSET_FROM_END } from '../../src/selfcrypto/file/format.js'
import { setInternalDiagnostics } from '../../src/selfcrypto/common/fail.js'
import { setUniformDelayRange } from '../../src/selfcrypto/common/delay.js'
import { assertEqual, assertTrue, createRunner } from './_helpers.js'

const runner = createRunner('异常中断（截断 / 追加 / 篡改 / 空文件）')
setUniformDelayRange([0, 0])

const reasons = []
setInternalDiagnostics((reason) => reasons.push(reason))

const data = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed * 13) & 0xff)
const key = data(16, 5)

/** 造一个合法密文，并用固定规则块长度便于按偏移截断。 */
const content = data(3000, 9)
const { cipherBytes } = encryptFile(content, [['name', 'x.bin'], ['mime', 'text/plain']], { masterKey: key })
const total = cipherBytes.length

/** 尝试解密，返回 { threw, message, code, returned }。 */
async function attempt(bytes) {
  try {
    const result = await decryptFile(bytes, key)
    return { threw: false, returned: result }
  } catch (error) {
    return { threw: true, message: error?.message, code: error?.code, returned: null }
  }
}

await runner.test('任意位置截断都必须统一失败，且绝不返回部分明文', async () => {
  // 横扫：头内 / 规则块 / 载荷头 / 载荷中 / 缺一字节 MAC，各取若干点
  const cutPoints = [
    0, 1, 2, 8, 9, 16, 32, HEADER_LEN - 1, HEADER_LEN, HEADER_LEN + 4,
    120, 500, 1500, 2500, total - 64, total - 33, total - 32, total - 1,
  ]
  const failures = []
  for (const cut of cutPoints) {
    if (cut >= total) continue
    const outcome = await attempt(cipherBytes.slice(0, cut))
    if (!outcome.threw) failures.push(`在 ${cut} 字节处截断却成功返回了`)
    else if (outcome.message !== '解密失败') failures.push(`截断至 ${cut} 字节时文案不对：${outcome.message}`)
    else if (outcome.code !== 'XQ_UNIFORM_FAIL') failures.push(`截断至 ${cut} 字节时错误码不对：${outcome.code}`)
  }
  assertEqual(failures.length, 0, failures.join('；'))
  assertTrue(cutPoints.length >= 15, `覆盖点应足够多，实际 ${cutPoints.length}`)
})

await runner.test('截断后的返回值为 null（确实没有把半个明文漏出来）', async () => {
  const results = []
  for (const cut of [HEADER_LEN + 10, 1000, total - 40]) {
    results.push(await attempt(cipherBytes.slice(0, cut)))
  }
  assertTrue(results.every((r) => r.returned === null), '任何截断都不应返回结果对象')
  assertTrue(results.every((r) => r.threw === true), '都应抛错')
})

await runner.test('空文件 / 单字节 / 只剩 MAC 长度 → 统一失败', async () => {
  for (const [label, bytes] of [
    ['空文件', new Uint8Array(0)],
    ['单字节', Uint8Array.of(0x44)],
    ['只有魔数', Uint8Array.from([0xda, 0x7a, 0x9f, 0x3c, 0x00, 0xff, 0x1b, 0x8e])],
    ['只剩 32 字节 MAC', cipherBytes.slice(total - 32)],
  ]) {
    const outcome = await attempt(bytes)
    assertEqual(outcome.threw, true, `${label} 应抛错`)
    assertEqual(outcome.message, '解密失败', `${label} 的文案`)
  }
})

await runner.test('追加垃圾字节 → 统一失败（长度自洽性检查必须拦住）', async () => {
  const appended = new Uint8Array(total + 16)
  appended.set(cipherBytes)
  appended.fill(0xaa, total)
  const outcome = await attempt(appended)
  assertEqual(outcome.threw, true, '追加垃圾后应抛错')
  assertEqual(outcome.message, '解密失败', '文案')
})

await runner.test('同样长度的全零 / 全随机文件 → 统一失败（不会撞出"看起来能解"的结果）', async () => {
  const zeros = new Uint8Array(total)
  const random = data(total, 77)
  for (const [label, bytes] of [
    ['全零', zeros],
    ['全随机', random],
  ]) {
    const outcome = await attempt(bytes)
    assertEqual(outcome.threw, true, `${label} 应抛错`)
    assertEqual(outcome.message, '解密失败', `${label} 的文案`)
  }
})

await runner.test('头部声明被篡改（长度/规则块长度）→ 统一失败，而不是按错误边界乱读', async () => {
  const cases = [
    ['载荷长度 +1', (b) => { new DataView(b.buffer).setUint32(93, new DataView(b.buffer).getUint32(93) + 1) }],
    ['载荷长度归零', (b) => { new DataView(b.buffer).setUint32(93, 0) }],
    ['规则块长度 +8', (b) => { new DataView(b.buffer).setUint32(32, new DataView(b.buffer).getUint32(32) + 8) }],
    ['段数改成 1', (b) => { b[40] = 1 }],
    ['拆分方式改成 9', (b) => { b[41] = 9 }],
    ['版本号改成 2', (b) => { b[8] = 2 }],
    ['保留字段写 1', (b) => { new DataView(b.buffer).setUint16(10, 1) }],
  ]
  const failures = []
  for (const [label, mutate] of cases) {
    const tampered = new Uint8Array(cipherBytes)
    mutate(tampered)
    const outcome = await attempt(tampered)
    if (!outcome.threw) failures.push(`${label} 竟然解密成功`)
    else if (outcome.message !== '解密失败') failures.push(`${label} 文案不对：${outcome.message}`)
  }
  assertEqual(failures.length, 0, failures.join('；'))
})

await runner.test('不同中断原因 → 对外文案完全一致，内部原因仅作诊断（可诊断、不外泄）', async () => {
  reasons.length = 0
  const outcomes = []
  // ① 截断（结构问题）② 篡改载荷（MAC 问题）③ 错误密钥（现在同样归入 MAC 问题）
  outcomes.push(await attempt(cipherBytes.slice(0, 500)))
  const tampered = new Uint8Array(cipherBytes)
  tampered[tampered.length - MAC_OFFSET_FROM_END - 1] ^= 0x01
  outcomes.push(await attempt(tampered))
  try {
    await decryptFile(cipherBytes, data(16, 99))
  } catch (error) {
    outcomes.push({ threw: true, message: error.message, code: error.code })
  }

  const messages = new Set(outcomes.map((o) => o.message))
  assertEqual(messages.size, 1, `对外文案必须只有一种，实际：${[...messages].join(' / ')}`)
  assertEqual([...messages][0], '解密失败', '文案内容')
  assertTrue(reasons.length >= 3, `内部原因应有 3 条以上，实际 ${reasons.length}: ${JSON.stringify(reasons)}`)
  // 注意：**篡改与错误密钥现在都落入 mac-mismatch** —— 这是等时化的预期后果
  // （MAC 校验排在 KEY_CHECK 之前，两条失败路径都必须先付出完整 MAC 的代价）。
  // 因此这里只要求「结构问题」与「密码学问题」可区分，不再要求三种互不相同。
  assertTrue(reasons.includes('mac-mismatch'), `应至少有一条 mac-mismatch，实际 ${JSON.stringify(reasons)}`)
  assertTrue(reasons.some((r) => r.startsWith('format:')), `应能区分出结构问题，实际 ${JSON.stringify(reasons)}`)
  assertTrue(new Set(reasons).size >= 2, `内部原因至少应能区分两类，实际 ${JSON.stringify(reasons)}`)
  // 内部原因绝不能出现在对外文案里
  for (const reason of reasons) {
    assertTrue(![...messages][0].includes(reason), `内部原因「${reason}」不得出现在对外文案里`)
  }
})

await runner.test('合法文件仍然能正常解密（负例没有把正例一起打死）', async () => {
  const outcome = await attempt(cipherBytes)
  assertEqual(outcome.threw, false, '合法文件应解密成功')
  assertEqual(outcome.returned.plainBytes.length, content.length, '还原长度')
})

runner.finish()
