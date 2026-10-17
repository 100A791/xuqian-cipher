/**
 * 浏览器测试的「端口卫生」与收尾工具（无第三方依赖）。
 *
 * 为什么单独抽出来：2026-10-17 复检确认，`等待超时: 页面加载完成` 的根因不是套件顺序，
 * 而是**调试端口被别的浏览器占着**（实测是 IDE 内置的 headless 预览，profile 名 `wbcdp_*`）。
 * 原来的 `waitForDevtools()` 只判断 `/json/version` 是否 200，于是会安静地连到别人的
 * `about:blank` 上，再等 60 秒超时。这里补两件事：
 *
 *   1. `assertPortFree()`：启动前先问一句「这个端口已经有人应答吗？」有人就**直接报错退出**，
 *      而不是连上去。错误信息里给可用的环境变量名，方便换端口。
 *   2. `closeBrowser()`：用 CDP `Browser.close` 真正关掉浏览器，**等端口释放后**再删临时
 *      profile。`browser.kill()` 在 Windows 只杀启动器，浏览器本体仍在；原实现紧接着删掉
 *      profile，会让下一次运行更容易命中陈旧实例。
 */
import { existsSync } from 'node:fs'

const BROWSER_CANDIDATES = [
  process.env.XQ_BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/** 按优先级找一个可用的 Chromium 内核浏览器；`XQ_BROWSER_PATH` 可覆盖。 */
export function findBrowser() {
  for (const path of BROWSER_CANDIDATES) {
    if (path && existsSync(path)) return path
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 探测某个端口上是否已有 DevTools 端点；有则返回 `/json/version` 的内容。 */
export async function probeDevtools(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * 启动浏览器**之前**确认端口是空的。
 *
 * 注意：这里刻意不做"帮你把占用者杀掉"——占用者很可能是用户/IDE 正在用的浏览器。
 * 拿不准的时候什么都不杀，只把问题说清楚。
 */
export async function assertPortFree(port, envVar = 'XQ_PORT') {
  const info = await probeDevtools(port)
  if (!info) return
  const browser = info.Browser ?? '未知浏览器'
  throw new Error(
    `调试端口 ${port} 已被占用（${browser}）。` +
      `这通常是 IDE 的预览浏览器或上一次测试的残留实例，本脚本不会复用它，也不会去杀它。` +
      `请换一个端口重跑，例如：${envVar}=${port + 100} node <script>`,
  )
}

/** 等端口释放；返回是否在超时前释放。 */
export async function waitPortReleased(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probeDevtools(port))) return true
    await sleep(200)
  }
  return false
}

/**
 * 真正关掉浏览器：先 CDP `Browser.close`，再降级到 `browser.kill()`（只杀启动器），
 * 最后等端口释放。返回端口是否已释放。
 */
export async function closeBrowser(cdp, browser, port) {
  if (cdp) {
    try {
      await Promise.race([
        cdp.send('Browser.close'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Browser.close 超时')), 5000)),
      ])
    } catch {
      /* 浏览器可能已经退出，或这条命令本来就不被支持 */
    }
    try {
      cdp.close()
    } catch {
      /* ignore */
    }
  }
  try {
    browser?.kill()
  } catch {
    /* ignore */
  }
  const released = await waitPortReleased(port)
  if (!released) {
    console.warn(`[devtools] 端口 ${port} 在 20s 内仍未释放；可能还有残留浏览器进程（未做无差别清理）`)
  }
  return released
}
