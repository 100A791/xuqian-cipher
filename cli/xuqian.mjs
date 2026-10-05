#!/usr/bin/env node
/**
 * XUQIAN CLI 启动器 —— 存在的唯一理由：**`.ts` 不能直接当 bin**。
 *
 * 背景：真正的实现是 `cli/xuqian.ts`（与网站共用 src/crypto/*）。但 `bin` 指向 `.ts` 时，
 * Node 20 只会抛一句 `Unknown file extension ".ts"` —— 用户看不懂，也不知道该怎么办。
 *
 * 这个启动器按 Node 版本分三条路：
 *   · ≥ 23.6          ：类型擦除默认开启，直接 `import()` 那个 .ts
 *   · 22.6 ~ 23.5     ：自动带 `--experimental-strip-types` 重启一次（用户无感）
 *   · < 22.6          ：明确说清需要什么版本、以及替代方案，然后以 1 退出
 *
 * 注意：它**不做任何加密相关的事**，只是把进程交给真正的实现。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, 'xuqian.ts')
const [major, minor] = process.versions.node.split('.').map(Number)
const args = process.argv.slice(2)

if (major > 23 || (major === 23 && minor >= 6)) {
  // 注意：动态 import 必须给 file:// URL。
  // Windows 上传绝对路径（带盘符 C:\…）会报 ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'。
  await import(pathToFileURL(target).href)
} else if (major === 22 && minor >= 6) {
  // 22.6~23.5：能力有，但默认没开 —— 自己带参数重启，别让用户记这些旗标
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', target, ...args],
    { stdio: 'inherit' },
  )
  process.exit(result.status ?? 1)
} else {
  process.stderr.write(
    [
      `XUQIAN CLI 需要 Node ≥ 22.6（它用 TypeScript 直接运行，靠 Node 的类型擦除）。`,
      `当前版本：${process.version}`,
      ``,
      `可选做法：`,
      `  1) 升级 Node 到 22.6+（推荐 24.x）`,
      `  2) 用 tsx 代跑：npx tsx "${target}" --help`,
      ``,
      `注意：网站的 ` + `pnpm dev` + ` 只需要 Node ≥ 20.19，不受这条限制影响。`,
      ``,
    ].join('\n'),
  )
  process.exit(1)
}
