/**
 * 自研加密路线：一次性跑完所有向量测试 —— SPEC 第 6 节阶段一验收标准的汇总入口。
 * 用 spawnSync 逐个跑（每个测试文件自带 runner 与退出码），最后汇总。
 *
 * 运行：node tests/unit/run-all.js  或  pnpm test:selfcrypto
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  ['SHA-256', 'test_sha256.js'],
  ['HMAC-SHA256', 'test_hmac.js'],
  ['PBKDF2-HMAC-SHA256', 'test_pbkdf2.js'],
  ['AES 单块', 'test_aes.js'],
  ['AES-CTR', 'test_ctr.js'],
  ['文件格式层', 'test_format.js'],
  ['文件加解密', 'test_file_crypto.js'],
  ['图片水印', 'test_watermark.js'],
  ['AI 检测', 'test_ai_detect.js'],
  ['本地存储与结构自检', 'test_storage.js'],
  ['大文件分块', 'test_large_file.js'],
  ['异常中断', 'test_interrupt.js'],
  ['统一失败延迟', 'test_uniform_delay.js'],
  ['大文件进度回调', 'test_progress.js'],
]

const results = []
for (const [label, file] of suites) {
  const run = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8' })
  if (run.error) {
    // 区分"子进程没起来"与"用例失败"：受限环境会直接返回 error（如 EBUSY），
    // 此时 stdout 为空，若不特判就会误报成"14 套全部失败"。
    results.push({ label, ok: false, spawnFailed: true })
    console.log(`ERROR ${label.padEnd(20)} 子进程启动失败：${run.error.code ?? run.error.message}`)
    continue
  }
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  // 只认严格的汇总行格式，别用"包含合计"去匹配 ——
  // 测试名里也可能出现"合计"（例如"权重合计为 1"），那样会抓错行。
  const summaryLine = output
    .split('\n')
    .filter((line) => /：合计 \d+ 项，通过 \d+ 项，失败 \d+ 项/.test(line))
    .pop()
  const summary = summaryLine?.trim() ?? '（无汇总行）'
  results.push({ label, ok: run.status === 0, summary })
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${summary}`)
}

const failed = results.filter((r) => !r.ok)
const spawnFailed = results.filter((r) => r.spawnFailed)
console.log(`\n自研路线验收：${results.length - failed.length}/${results.length} 套通过（算法 5 + 格式与加解密 2 + 水印 1 + AI 检测 1 + 存储与结构自检 1 + 阶段七四项 4）`)
if (failed.length > 0) {
  if (spawnFailed.length === results.length) {
    // 一套都没跑起来 → 环境问题，不是测试结果
    console.log('注意：全部套件都未能启动子进程（环境限制，例如沙箱返回 EBUSY），这不代表测试失败。')
    console.log('      请在可派生子进程的普通终端重跑：pnpm test:selfcrypto')
  } else {
    console.log('未通过：' + failed.map((r) => r.label).join('、'))
  }
  process.exitCode = 1
}
