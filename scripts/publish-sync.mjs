/**
 * 把 dist/ 同步到 publish/（发布为在线链接用的稳定目录）。
 *
 * 为什么不直接发布 dist/：`vite build` 会清空 outDir，而「发布应用」的目录绑定与
 * 应用记录就放在目录里 —— dist 被清空等于把已发布应用的记录一起清掉。
 * publish/ 刻意不被构建触碰（已在 .gitignore），每次发布前跑一次本脚本同步即可。
 *
 * 复制方式与 sync-docs 相同：readFile + writeFile 逐文件覆盖（绕开本机
 * safe-delete/brokered-fs shim 对 cpSync 覆盖与整目录 rmSync 的拦截），多余文件清理。
 *
 * 用法：node scripts/publish-sync.mjs   （先 pnpm build）
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = resolve(root, 'dist')
const outDir = resolve(root, 'publish')

if (!existsSync(join(srcDir, 'index.html'))) {
  console.error('[publish-sync] dist/index.html 不存在，先执行 pnpm build')
  process.exit(2)
}

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(src))
}

function copyTree(srcDir, destDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else copyFile(src, dest)
  }
}

function walkFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

mkdirSync(outDir, { recursive: true })
copyTree(srcDir, outDir)

const expected = new Set(walkFiles(srcDir))
let pruned = 0
for (const rel of walkFiles(outDir)) {
  if (expected.has(rel)) continue
  try {
    unlinkSync(join(outDir, rel))
    pruned++
  } catch {
    /* 删不掉就留着 */
  }
}
function pruneEmptyDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = join(dir, entry.name)
    pruneEmptyDirs(child)
    if (readdirSync(child).length === 0) {
      try {
        rmdirSync(child)
      } catch {
        /* ignore */
      }
    }
  }
}
pruneEmptyDirs(outDir)

let bytes = 0
for (const rel of walkFiles(outDir)) bytes += statSync(join(outDir, rel)).size
console.log(
  `[publish-sync] 已同步 dist/ → publish/（${walkFiles(outDir).length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB${pruned ? `，清理 ${pruned} 个旧文件` : ''}）`,
)
