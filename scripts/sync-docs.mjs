/**
 * 把仓库里的 Markdown 文档与截图同步到 public/docs/，使其能通过开发服务器直接访问：
 *   http://127.0.0.1:5188/docs/GUIDE.md
 *   http://127.0.0.1:5188/docs/images/04-key-modal.png
 *
 * 为什么需要这一步：Vite 只服务项目根与 public/，仓库根的 README.md 和 docs/ 默认不可访问，
 * 于是文档里的链接在浏览器里会 404。
 *
 * 该脚本在 `pnpm dev` 与 `pnpm build` 之前自动执行（见 package.json）。
 * 同时会校验：
 *   1. 文档之间 / 文档到截图的相对链接是否全部指向真实存在的文件；
 *   2. 是否残留了非 ASCII 锚点（很多 Markdown 渲染器不支持中文锚点）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'public', 'docs')

const docFiles = [
  'README.md',
  'docs/GUIDE.md',
  'docs/FORMAT.md',
  'docs/SECURITY.md',
  'docs/TESTING.md',
  'docs/KEY-LIFECYCLE.md',
  'docs/PROJECT-REPORT.md',
  'docs/PERFORMANCE.md',
]

/** 校验：Markdown 中的相对链接目标必须存在；不得使用非 ASCII 锚点。 */
function validate() {
  const problems = []
  const markdown = readdirSync(resolve(root, 'docs'))
    .filter((f) => extname(f) === '.md')
    .map((f) => resolve(root, 'docs', f))
  markdown.push(resolve(root, 'README.md'))

  for (const file of markdown) {
    if (!existsSync(file)) {
      problems.push(`缺少文档: ${relative(root, file)}`)
      continue
    }
    const text = readFileSync(file, 'utf8')
    const baseDir = dirname(file)

    // 相对文件链接（跳过 http/https 与纯锚点）
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]
      if (/^(https?:|mailto:|#)/.test(target)) continue
      const [pathPart] = target.split('#')
      if (!pathPart) continue
      const resolved = resolve(baseDir, decodeURIComponent(pathPart))
      if (!existsSync(resolved)) {
        problems.push(`${relative(root, file)} → 链接目标不存在: ${target}`)
      }
    }

    // 非 ASCII 锚点（中文标题生成的锚点在多数渲染器里点不动）
    for (const match of text.matchAll(/\]\(#([^)]+)\)/g)) {
      const anchor = match[1]
      // eslint-disable-next-line no-control-regex
      if (/[^\x00-\x7F]/.test(anchor)) {
        problems.push(`${relative(root, file)} → 使用了非 ASCII 锚点: #${anchor}`)
      }
    }
  }
  return problems
}

const problems = validate()
if (problems.length > 0) {
  console.error('[sync-docs] 发现问题：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('[sync-docs] 存在失效链接或非 ASCII 锚点，已中止同步。')
  process.exit(1)
}

// 同步到 public/docs/（截图放在 public/docs/images/，因此文档里的 images/xxx.png 相对路径可直接生效）
//
// ⚠ 这里刻意**不用** rmSync(outDir, { recursive: true })。
// 那是"先删整棵树、再往里拷"：只要删除被中断（Windows 上目录被 dev server 占用、
// 或 safe-delete 一类的 shim 中止 trash），public/docs 就会只剩半截，而且失败发生在复制之前。
// 2026-10-17 实测踩过两次：一次 Node 22 + shim，一次 vite dev 正在运行。
// 现在改为**逐文件覆盖 + 清理本次没有产出的旧文件**：任何时刻目录里都保留着上一版完整副本。
mkdirSync(join(outDir, 'images'), { recursive: true })

/**
 * 读写式复制（而不是 cpSync）。
 *
 * 原因：Node 22 下本机注入了 `node-brokered-fs-shim`，它包装的 cpSync 在目标文件已存在时
 * 会先 unlink 再拷，而 unlink 会以 `errno 0 / The operation completed successfully` 失败。
 * 这里的目标都是我们自己生成的小文件（Markdown / PNG），readFileSync + writeFileSync 直接覆盖，
 * 既绕开 shim，也不会出现"先删后写"的中间态。
 */
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

const expected = new Set(['index.html'])
let copied = 0
for (const rel of docFiles) {
  const src = resolve(root, rel)
  if (!existsSync(src)) {
    console.warn(`[sync-docs] 跳过不存在的文档: ${rel}`)
    continue
  }
  // README 放在 public/docs/README.md，docs/*.md 保持同名
  const destRel = rel.replace(/^docs\//, '')
  copyFile(src, join(outDir, destRel))
  expected.add(destRel)
  copied++
}

const imagesDir = resolve(root, 'docs', 'images')
if (existsSync(imagesDir)) {
  for (const entry of readdirSync(imagesDir, { withFileTypes: true })) {
    const src = join(imagesDir, entry.name)
    const dest = join(outDir, 'images', entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else copyFile(src, dest)
    expected.add(`images/${entry.name}`)
  }
}

// 生成一个简单的索引页，方便在浏览器里点进各篇文档
const index = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>XUQIAN 文档索引</title>
<style>
  body { margin: 0; padding: 32px 20px; background: #05070d; color: #e8edf7;
         font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; letter-spacing: .04em; }
  p.lead { color: #9aa8c2; font-size: 13px; }
  ul { list-style: none; padding: 0; display: grid; gap: 10px; margin-top: 22px; }
  a { display: block; padding: 14px 16px; border: 1px solid rgba(120,145,190,.22);
      border-radius: 12px; text-decoration: none; color: #e8edf7; background: rgba(15,20,32,.9); }
  a:hover { border-color: #d8b26a; }
  a b { display: block; font-size: 14px; margin-bottom: 3px; }
  a span { font-size: 12px; color: #9aa8c2; }
</style>
</head>
<body>
<main>
  <h1>XUQIAN 文档索引</h1>
  <p class="lead">纯静态文档，可直接在浏览器打开（.md 由浏览器按纯文本显示，链接与截图路径均有效）。</p>
  <ul>
    <li><a href="./GUIDE.md"><b>分区操作手册（配图版）</b><span>加密 / 解密 / 文本 / 工具 四大分区逐步说明，含 22 张截图</span></a></li>
    <li><a href="./FORMAT.md"><b>.XUQIAN 与 .XUQIANKEY 格式规范</b><span>字节级字段表、AAD 构造、加解密流程</span></a></li>
    <li><a href="./SECURITY.md"><b>安全模型与风险提示</b><span>威胁模型、诚实披露、密码学实现说明</span></a></li>
    <li><a href="./TESTING.md"><b>测试用例与验收标准</b><span>单元测试 / 冒烟测试 / 验收 20 条逐条对照</span></a></li>
    <li><a href="./KEY-LIFECYCLE.md"><b>密钥一次性展示与销毁机制</b><span>实现详解 + 零残留验证方法</span></a></li>
    <li><a href="./README.md"><b>项目总览 README</b><span>快速开始、功能清单、部署清单</span></a></li>
  </ul>
</main>
</body>
</html>
`
writeFileSync(join(outDir, 'index.html'), index, 'utf8')

// 清理本次没有产出的旧文件（比如改名/删除的截图）。只删单个文件，不碰目录树。
function walkFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}
let pruned = 0
for (const rel of walkFiles(outDir)) {
  if (expected.has(rel)) continue
  try {
    unlinkSync(join(outDir, rel))
    pruned++
  } catch {
    /* 删不掉就留着，不影响本次同步 */
  }
}

// 顺带清掉空目录（同样只删空目录，不做递归删除）
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

console.log(
  `[sync-docs] 已同步 ${copied} 篇文档 + 截图到 public/docs/（链接校验通过${pruned > 0 ? `，清理 ${pruned} 个旧文件` : ''}）`,
)
