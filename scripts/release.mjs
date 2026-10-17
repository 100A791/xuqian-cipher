/**
 * 发布脚本：bump version → 提交 → 打 tag。
 *
 * 用法：
 *   node scripts/release.mjs            # patch（2.3.0 → 2.3.1）
 *   node scripts/release.mjs minor      # 2.3.0 → 2.4.0
 *   node scripts/release.mjs major      # 2.3.0 → 3.0.0
 *   node scripts/release.mjs 2.4.0      # 指定版本号
 *
 * 安全护栏：
 * - 工作树必须干净（version bump 之外不允许夹带其它改动）；
 * - CHANGELOG.md 必须包含 `[x.y.z]` 小节 —— 没有"为什么改"就不发版（本项目惯例）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

// ---- 前置检查 ---------------------------------------------------------------
const dirty = git('status', '--porcelain')
if (dirty.length > 0) {
  console.error('[release] 工作树不干净，先提交或还原：\n' + dirty)
  process.exit(1)
}

const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.version
const arg = process.argv[2] ?? 'patch'

let next
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg
} else {
  const [maj, min, pat] = current.split('.').map(Number)
  next = { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` }[arg]
}
if (!next || next === current) {
  console.error(`[release] 无法从 ${current} 计算目标版本（参数：${arg}）`)
  process.exit(1)
}

// ---- CHANGELOG 检查 ---------------------------------------------------------
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
if (!changelog.includes(`[${next}]`)) {
  console.error(`[release] CHANGELOG.md 里没有 [${next}] 小节。先写好"为什么改"，再发版。`)
  process.exit(1)
}

// ---- 写入并提交 -------------------------------------------------------------
pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

console.log(`[release] ${current} → ${next}`)
git('add', 'package.json')
git('commit', '-m', `release: v${next}`)
git('tag', `v${next}`)

console.log(`[release] 已提交并打 tag v${next}。`)
console.log('[release] 推送远端时记得带上 tag：git push --follow-tags')
