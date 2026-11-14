/**
 * 安装 git 提交前钩子。
 *
 * 为什么需要安装脚本：`.git/hooks/` 不随仓库版本化（`.git/` 本身不进版本库），
 * 所以钩子必须由仓库里的模板复制过去。
 *
 * 两个刻意的处理：
 * 1. **强制 LF 行尾**再写入钩子。Windows 上 `core.autocrlf=true` 会把模板检出成 CRLF，
 *    而 `sh` 脚本带 CRLF 会出现 `\r: command not found` 这类诡异报错。
 *    见 .gitattributes 里的 `scripts/hooks/* text eol=lf`。
 * 2. **没有 .git 目录时安静退出（返回 0）**，这样在 tarball / 只读环境里
 *    跑到这个脚本不会让安装流程失败。
 *
 * 用法：
 *   node scripts/install-hooks.mjs        # 安装/更新 pre-commit + pre-push
 *   删除：rm .git/hooks/pre-commit .git/hooks/pre-push
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 问 git 要 hooks 目录，兼容 worktree / 自定义 git-dir。 */
function hooksDir() {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim()
    return resolve(root, gitDir, 'hooks')
  } catch {
    return null
  }
}

const target = hooksDir()
if (!target) {
  console.log('[install-hooks] 当前目录不是 git 仓库（或未安装 git），跳过。')
  process.exit(0)
}

mkdirSync(target, { recursive: true })

/** 安装一个钩子模板（强制 LF），返回是否曾存在。 */
function installHook(name) {
  const source = join(root, 'scripts', 'hooks', name)
  if (!existsSync(source)) {
    console.error(`[install-hooks] 找不到钩子模板：${source}`)
    process.exitCode = 1
    return
  }
  // 关键：归一化为 LF。不要用 copyFileSync 直接搬——模板在 Windows 上可能是 CRLF。
  const content = readFileSync(source, 'utf8').replace(/\r\n/g, '\n')
  const dest = join(target, name)
  const existed = existsSync(dest)
  writeFileSync(dest, content, 'utf8')

  try {
    chmodSync(dest, 0o755)
  } catch {
    // Windows 上 chmod 基本是空操作，失败不影响 git 执行钩子
  }

  console.log(`[install-hooks] ${existed ? '已更新' : '已安装'}：${dest}`)
}

installHook('pre-commit')
installHook('pre-push')
console.log('[install-hooks] 跳过本次校验可用：git commit --no-verify / git push --no-verify')
