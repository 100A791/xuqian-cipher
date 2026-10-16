/**
 * 文档数字守卫。
 *
 * 为什么需要它：本项目文档里散落着大量"实测数字"（截图张数、套件数、断言数……）。
 * 这些数字靠手写维护，已经漂移过至少两次——上一次是人工改对的，结果又漂了。
 * 手改是治不住的，所以改成断言：数字对不上就报错，而不是等人发现。
 *
 * 设计取舍：
 * - **只断言"廉价可推导"的数字**（数文件、数行、数匹配），不在这里跑 vitest / run-all.js。
 *   守卫要快（< 100ms），否则没人愿意让它进 test:all。
 * - **昂贵或跨文档的数字用"互相一致"代替硬编码**：例如"自研 N 项断言"不在本脚本里写死，
 *   而是要求所有文档提到它的地方取值相同。这样文档之间不会各说各话，
 *   也不必在断言数变化时同时改脚本。
 * - **锚点找不到 = 失败**，不是跳过。否则文案一改，守卫就静默失效了。
 * - 注意「口径」的区别：`docs/images/` 目录里共有 31 张 PNG，而 GUIDE 正文引用的是其中
 *   22 张（其余是脚本产出但未内嵌 + now-* 现状图）。两个数字都对，断言时必须分开口径，
 *   不要把它们当成同一个数——这正是上一次误判的根源。
 *
 * 用法：node scripts/check-counts.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

// ---------------------------------------------------------------- 实测口径

const pngs = readdirSync(join(root, 'docs', 'images')).filter((f) => f.endsWith('.png'))
const totalPng = pngs.length
const nowPng = pngs.filter((f) => f.startsWith('now-')).length
const scriptedPng = totalPng - nowPng

/** GUIDE 正文里真正内嵌的截图（去重）。注意这与"目录里有几张"是两个口径。 */
const guideRefs = new Set([...read('docs/GUIDE.md').matchAll(/images\/[A-Za-z0-9._-]+\.png/g)].map((m) => m[0]))
const linkedPng = guideRefs.size

const selfSuites = readdirSync(join(root, 'tests', 'unit')).filter((f) => /^test_.*\.js$/.test(f)).length

/**
 * Vitest 用例数：**静态计数** `src/**\/*.test.ts` 里的 `it(` / `test(` 调用。
 * 实测与 `vitest run` 的报告数字一致（92 = 92），所以不必为了守卫去跑一遍测试。
 *
 * 局限（写清楚以免日后踩坑）：若将来出现 `it.each([...])`（一次调用生成 N 个用例）
 * 或把 `it(` 写进注释，静态计数就会偏。到那时请改成解析 `vitest run` 的输出。
 */
const testFileNames = readdirSync(join(root, 'src'), { recursive: true })
  .map((p) => String(p).replace(/\\/g, '/'))
  .filter((p) => p.endsWith('.test.ts'))
const vitestCases = testFileNames.reduce(
  (sum, rel) => sum + (readFileSync(join(root, 'src', rel), 'utf8').match(/\bit\(|\btest\(/g)?.length ?? 0),
  0,
)
const vitestFiles = testFileNames.length

// ---------------------------------------------------------------- 断言工具

const failures = []

/**
 * 断言某文件里的一段文案中的数字与实测一致。
 * @param {{label: string, file: string, pattern: RegExp, expect: number[], hint?: string}} spec
 */
function claim({ label, file, pattern, expect, hint }) {
  const found = read(file).match(pattern)
  if (!found) {
    failures.push(
      `${label}｜锚点消失：${file} 里已找不到 ${pattern}\n    → 文案被改过了。请把本脚本的 pattern 同步更新，否则这条守卫会静默失效。`,
    )
    return
  }
  const got = found.slice(1).map((n) => Number.parseInt(n, 10))
  if (got.join('/') !== expect.join('/')) {
    failures.push(
      `${label}｜${file} 写的是 ${got.join(' / ')}，实测是 ${expect.join(' / ')}` + (hint ? `\n    → ${hint}` : ''),
    )
  }
}

// ---------------------------------------------------------------- 截图口径

claim({
  label: 'README 文档总览',
  file: 'README.md',
  pattern: /(\d+) 张真实截图（脚本产出 (\d+) \+ 现状图 (\d+)）/,
  expect: [totalPng, scriptedPng, nowPng],
})

claim({
  label: 'README 目录树注释',
  file: 'README.md',
  pattern: /操作手册截图（(\d+) 张/,
  expect: [totalPng],
  hint: '这一行统计的是 docs/images/ 目录里的 PNG 总数。',
})

claim({
  label: 'GUIDE 截图小结',
  file: 'docs/GUIDE.md',
  pattern: /共有 \*\*(\d+) 张\*\* PNG：脚本产出的 (\d+) 张（下表）\+ (\d+) 张/,
  expect: [totalPng, scriptedPng, nowPng],
})

claim({
  label: 'GUIDE 现状图小节标题',
  file: 'docs/GUIDE.md',
  pattern: /现状图（`now-\*`，(\d+) 张）/,
  expect: [nowPng],
})

claim({
  label: 'TESTING 冒烟第 2 条',
  file: 'docs/TESTING.md',
  pattern: /手册内 \*\*(\d+) 张截图\*\*链接全部有效/,
  expect: [linkedPng],
  hint: '这里统计的是 GUIDE 正文内嵌的截图数，不是目录里的 PNG 总数。',
})

claim({
  label: 'sync-docs 索引页文案',
  file: 'scripts/sync-docs.mjs',
  pattern: /含 (\d+) 张截图/,
  expect: [linkedPng],
})

// ---------------------------------------------------------------- Vitest 用例口径

claim({
  label: 'README 单元测试标题',
  file: 'README.md',
  pattern: /单元测试（(\d+) 项，Vitest）/,
  expect: [vitestCases],
  hint: `静态计数：src 下 ${vitestFiles} 个 .test.ts 里的 it(/test( 调用。`,
})

claim({
  label: 'TESTING 命令注释',
  file: 'docs/TESTING.md',
  pattern: /Vitest 单元测试（(\d+) 项）/,
  expect: [vitestCases],
})

claim({
  label: 'TESTING 单元测试小节标题',
  file: 'docs/TESTING.md',
  pattern: /（`src\/\*\*\/\*\.test\.ts`，(\d+) 项）/,
  expect: [vitestCases],
})

claim({
  label: 'PROJECT-REPORT 测试基线',
  file: 'docs/PROJECT-REPORT.md',
  pattern: /单元 \*\*(\d+)\*\*/,
  expect: [vitestCases],
})

// ---------------------------------------------------------------- 测试套件口径

claim({
  label: 'TESTING 自研套件数',
  file: 'docs/TESTING.md',
  pattern: /自研加密路线（`tests\/unit\/`，(\d+) 套/,
  expect: [selfSuites],
})

claim({
  label: 'SELFCRYPTO-REVIEW 套件数',
  file: 'docs/SELFCRYPTO-REVIEW.md',
  pattern: /套件数仍为 (\d+)）/,
  expect: [selfSuites],
})

claim({
  label: 'PROJECT-REPORT 套件数',
  file: 'docs/PROJECT-REPORT.md',
  pattern: /\*\*(\d+) 套 \d+ 项断言\*\*/,
  expect: [selfSuites],
})

/**
 * 跨文档一致性：所有"N 项断言"必须同值（不在此处硬编码，避免断言数一变就要改脚本）。
 * 故意**不含** `docs/WORKSPACE-AUDIT.md`：那是按轮次追加的历史报告，
 * 其中的数字是"当时实测"，会且应当与今天不同，不该被当成过期值来修。
 */
const assertionDocs = ['README.md', 'docs/PROJECT-REPORT.md', 'docs/TESTING.md', 'docs/SELFCRYPTO-REVIEW.md']
const assertionValues = new Map()
for (const file of assertionDocs) {
  for (const m of read(file).matchAll(/(\d+) 项断言/g)) {
    if (!assertionValues.has(m[1])) assertionValues.set(m[1], [])
    assertionValues.get(m[1]).push(file)
  }
}
if (assertionValues.size > 1) {
  const detail = [...assertionValues.entries()]
    .map(([v, files]) => `${v}（${[...new Set(files)].join(', ')}）`)
    .join(' vs ')
  failures.push(`自研断言数在文档间不一致：${detail}\n    → 请统一为实测值（跑 node tests/unit/run-all.js 取总数）。`)
}

// ------------------------------------------------- 结构性合计（人工最容易漏的一类）

/**
 * Vitest 分项账本：TESTING.md 的 2.x 小节逐文件写了用例数，
 * 要求「分项之和 == 总数」且「每个 .test.ts 都被列出」。
 * 新建测试文件却忘了写进文档，就是靠这条抓出来的。
 */
const testingDoc = read('docs/TESTING.md')
const listedCases = [...testingDoc.matchAll(/^### 2\.\d+ .*（`([A-Za-z0-9.\-]+\.test\.ts)`，(\d+) 项）/gm)]
const listedSum = listedCases.reduce((sum, m) => sum + Number.parseInt(m[2], 10), 0)
const listedNames = new Set(listedCases.map((m) => m[1]))
const actualNames = testFileNames.map((p) => p.split('/').pop())

const unlisted = actualNames.filter((n) => !listedNames.has(n))
if (unlisted.length > 0) {
  failures.push(
    `TESTING.md 的单元测试分项里没有列出：${unlisted.join(', ')}\n    → 新增测试文件后请在「## 二、单元测试」下补一节，否则文档与实测会脱节。`,
  )
}
if (listedSum !== vitestCases) {
  failures.push(
    `TESTING.md 单元测试分项合计是 ${listedSum}，实测总数是 ${vitestCases}\n    → 逐文件的小节数字与实际用例数对不上（各文件用 it(/test( 静态计数）。`,
  )
}

/**
 * 自研套件账本：TESTING.md 的套件表逐行写了项数，
 * 要求「行数 == tests/unit/test_*.js 数量」「项数之和 == 文档标注的断言总数」。
 */
const suiteRows = [...testingDoc.matchAll(/^\|\s*`(test_[a-z0-9_]+)`\s*\|\s*(\d+)\s*\|/gm)]
if (suiteRows.length !== selfSuites) {
  failures.push(`TESTING.md 自研套件表有 ${suiteRows.length} 行，tests/unit/ 下实际有 ${selfSuites} 个 test_*.js`)
}
const suiteSum = suiteRows.reduce((sum, m) => sum + Number.parseInt(m[2], 10), 0)
const claimedAssertions = assertionValues.size === 1 ? Number.parseInt([...assertionValues.keys()][0], 10) : null
if (claimedAssertions !== null && suiteSum !== claimedAssertions) {
  failures.push(
    `TESTING.md 自研套件表各套项数合计 ${suiteSum}，但文档标注的断言总数是 ${claimedAssertions}\n    → 两者必须相等（跑 node tests/unit/run-all.js 看每套的实际项数）。`,
  )
}

// ---------------------------------------------------------------- 报告

const info = [
  `docs/images/ PNG 总数      ${totalPng}（脚本产出 ${scriptedPng} + now-* ${nowPng}）`,
  `GUIDE 正文引用的截图数     ${linkedPng}`,
  `Vitest 用例数             ${vitestCases}（${vitestFiles} 个 .test.ts，静态计数）`,
  `自研测试套件数            ${selfSuites}（tests/unit/test_*.js）`,
  assertionValues.size === 1 ? `文档标注的自研断言数      ${[...assertionValues.keys()][0]}` : '',
].filter(Boolean)

if (failures.length > 0) {
  console.error('[check-counts] 数字对不上：\n')
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  console.error('[check-counts] 修文档或修本脚本，二者必须一致。')
  process.exit(1)
}

console.log('[check-counts] 全部通过。当前口径：')
for (const line of info) console.log(`  ${line}`)
