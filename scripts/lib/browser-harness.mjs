/**
 * 浏览器自动化测试共享基础设施（无第三方依赖）。
 *
 * 用本机 Edge/Chrome 的 headless 模式 + CDP 原始 WebSocket 驱动真实页面。
 * 供 scripts/smoke.mjs（端到端冒烟）与 scripts/interop-test.mjs（浏览器↔CLI 互操作）共用，
 * 避免两处重复维护同一套 CDP 管道。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

export function findBrowser() {
  for (const path of EDGE_PATHS) if (existsSync(path)) return path
  return null
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Cdp {
  #ws
  #id = 0
  #pending = new Map()

  static async attach(wsUrl) {
    const cdp = new Cdp()
    cdp.#ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener('open', () => resolve())
      cdp.#ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
    })
    cdp.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && cdp.#pending.has(msg.id)) {
        const { resolve, reject } = cdp.#pending.get(msg.id)
        cdp.#pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    return cdp
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 180000)
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`页面异常: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      /* ignore */
    }
  }
}

export async function waitFor(cdp, expression, timeoutMs = 30000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await cdp.eval(`return Boolean(${expression})`)) return true
    } catch {
      /* 页面尚未就绪 */
    }
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 记录 <a download> 的文件名，同时照常触发真实下载（下载目录由 CDP 指定）。 */
export const PATCH_DOWNLOADS = `
  if (!window.__xqDownloads) {
    window.__xqDownloads = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        window.__xqDownloads.push(this.download);
        try { origClick.apply(this, arguments); } catch (e) { /* ignore */ }
        return;
      }
      return origClick.apply(this, arguments);
    };
  }
  return true;
`

export async function uploadFile(cdp, filePath, inputSelector, nth = 0) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: inputSelector })
  const nodeId = nodeIds[nth]
  if (!nodeId) throw new Error(`找不到 input: ${inputSelector}[${nth}]`)
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath] })
}

export async function clickByText(cdp, texts, options = {}) {
  const list = JSON.stringify(texts)
  const exact = options.exact === true
  return cdp.eval(`
    const wanted = ${list};
    const buttons = Array.from(document.querySelectorAll(${JSON.stringify(options.selector ?? 'button')}));
    const found = buttons.find((el) => {
      const text = el.textContent.trim();
      return wanted.some((w) => (${exact} ? text === w : text.includes(w)));
    });
    if (!found) throw new Error('找不到按钮: ' + wanted.join(' / '));
    found.click();
    return true;
  `)
}

export async function setInput(cdp, selector, value) {
  await cdp.eval(`
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到输入框: ' + ${JSON.stringify(selector)});
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
}

/**
 * 若当前停在「开始页」（加密路线二选一），先选指定路线进入主界面。
 * 幂等：已选过路线时什么都不做。所有走 UI 的测试都靠它穿过开始页。
 */
export async function chooseModeIfNeeded(cdp, mode = 'simple') {
  const clicked = await cdp.eval(`
    const start = document.querySelector('[data-testid="start-screen"]');
    if (!start) return false;
    const card = document.querySelector(${JSON.stringify(`[data-testid="start-${mode}"]`)});
    const btn = card ? card.querySelector('button') : null;
    if (!btn) throw new Error('开始页存在但找不到 ' + ${JSON.stringify(mode)} + ' 卡片的按钮');
    btn.click();
    return true;
  `)
  if (clicked) await sleep(400)
  return clicked
}

export async function switchTab(cdp, needle) {
  await chooseModeIfNeeded(cdp, 'simple')
  await cdp.eval(`
    const tabs = Array.from(document.querySelectorAll('[role=tab]'));
    const tab = tabs.find((el) => el.textContent.includes(${JSON.stringify(needle)}));
    if (!tab) throw new Error('找不到标签页: ' + ${JSON.stringify(needle)});
    tab.click();
    return true;
  `)
  await sleep(300)
}

/** 等待下载文件真正落盘，返回路径（未落盘返回 null）。 */
export async function waitForDownload(downloadDir, name, timeoutMs = 20000) {
  const path = join(downloadDir, name)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return path
    await sleep(200)
  }
  return null
}

/**
 * 启动一个 headless 浏览器并连上页面，返回 { browser, cdp, workDir, profileDir, downloadDir, base }。
 * 调用方负责在 finally 里 await teardown()。
 */
export async function launchSession({ base, port = 9333, windowSize = '1280,900' }) {
  const browserPath = findBrowser()
  if (!browserPath) throw new Error('未找到 Edge/Chrome 浏览器可执行文件')

  const workDir = mkdtempSync(join(tmpdir(), 'xuqian-e2e-'))
  const profileDir = join(workDir, 'profile')
  const downloadDir = join(workDir, 'downloads')
  const fixtureDir = join(workDir, 'fixtures')
  for (const dir of [profileDir, downloadDir, fixtureDir]) mkdirSync(dir, { recursive: true })

  const browser = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${windowSize}`,
      '--disable-features=Translate,MediaRouter',
      base,
    ],
    { stdio: 'ignore' },
  )

  // 等 DevTools 端口就绪
  const deadline = Date.now() + 25000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      /* 重试 */
    }
    await sleep(250)
  }
  if (!ready) {
    browser.kill()
    throw new Error('DevTools 端口未就绪')
  }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page =
    targets.find((t) => t.type === 'page' && t.url.startsWith('http')) ?? targets.find((t) => t.type === 'page')
  if (!page) {
    browser.kill()
    throw new Error('找不到页面目标')
  }

  const cdp = await Cdp.attach(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
  await waitFor(
    cdp,
    `location.protocol.startsWith('http') && document.querySelector('#root')?.children.length > 0`,
    60000,
    '页面加载完成',
  )
  // 必须装上下载拦截：它记录 <a download> 的文件名，测试才能断言"到底下载了什么"
  await cdp.eval(PATCH_DOWNLOADS)
  await cdp.eval(`document.documentElement.dataset.test = '1'; return true;`)
  await cdp.eval(`window.__xqDownloads = []; return true;`)

  return {
    browser,
    cdp,
    workDir,
    profileDir,
    downloadDir,
    fixtureDir,
    teardown: async () => {
      cdp.close()
      browser.kill()
    },
    /** 刷新页面并重新挂载补丁（用于"换设备"场景）。 */
    reload: async () => {
      await cdp.send('Page.reload', { ignoreCache: true })
      await sleep(2500)
      await cdp.send('Runtime.enable').catch(() => {})
      await waitFor(cdp, `document.querySelector('#root')?.children.length > 0`, 40000, '刷新后挂载')
      await cdp.eval(PATCH_DOWNLOADS)
    },
  }
}

/** 简易断言收集器。 */
export function createChecker() {
  const results = []
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok, detail })
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    },
    summary(title) {
      const passed = results.filter((r) => r.ok).length
      console.log(`\n${title}：合计 ${results.length} 项，通过 ${passed} 项，失败 ${results.length - passed} 项`)
      if (passed !== results.length) {
        console.log('失败项：')
        for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name} (${r.detail})`)
        return false
      }
      return true
    },
  }
}
