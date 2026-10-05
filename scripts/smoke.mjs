/**
 * 端到端冒烟测试（无需额外依赖）。
 *
 * 用本机 Edge/Chrome 的 headless 模式 + CDP 驱动真实页面，覆盖：
 *   1. 页面挂载、四个主 Tab、品牌标题
 *   2. 文本加密 → 密钥弹窗（红色警告 / 32 位 Hex / 24 位 Base64 / 指纹 / 默认选中）
 *   3. 未复制未下载时关闭 → 必须二次确认；取消后密钥仍在
 *   4. 确认关闭 → 密钥销毁，localStorage / sessionStorage / Cookie / URL / IndexedDB 无残留
 *   5. 刷新页面 → 密钥不存在
 *   6. 错误密钥 → 统一提示；正确密钥 → 解密成功且 SHA-256 校验一致
 *   7. 真实文件（内存 / 空文件 / 多层）加密 → 下载 → 解密 → 字节级还原
 *   8. 主题切换、移动端视口无横向溢出
 *   9. 自研路线五个入口的真实链路（真上传文件加密、统一失败提示、真 PNG 嵌入水印、
 *      AI 报告、跨刷新 IndexedDB 持久化、整库备份、Web Worker 进度）
 *  10. **无障碍审计**：开始页 + 简单路线 4 页 + 自研路线 6 页，共 11 处
 *      （html lang / 图片 alt / 控件可访问名 / 正 tabindex / 标题层级 / progressbar 的 ARIA 自洽；
 *        **不覆盖颜色对比度**——需要渲染样式计算，容易假阳性，故不做，也不用"通过"暗示它没问题）
 *
 * 启动前会先清掉遗留的浏览器进程：被中断的运行会留下实例，导致下一次连到旧页面并静默挂死。
 *
 * 用法：node scripts/smoke.mjs [baseUrl]
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5188/'
const PORT = 9333
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function findBrowser() {
  for (const path of EDGE_PATHS) if (existsSync(path)) return path
  return null
}

/**
 * 启动前清掉**我们自己遗留的测试实例**。
 *
 * 为什么必须有：脚本被中断（或被强杀）时进程树可能活下来，累积的实例会占着 DevTools 端口，
 * 让下一次运行**连到旧实例**、拿到过期状态，症状是莫名其妙的 `CDP 超时: Runtime.evaluate`
 * 静默挂死（本机实测踩过两次：一次 12 个进程、一次 33 个）。
 *
 * ⚠⚠ **曾经出过的事故，不要再犯**：这里最早的写法是 `taskkill /F /IM msedge.exe` ——
 * 那是**按进程名无差别杀**，会把用户正在用的 Edge 窗口一起关掉。事后查证：用户当时确实
 * 开着 9 个 msedge 进程。**为了跑个测试去毁掉别人的浏览会话是不可接受的。**
 *
 * 现在的双重锁（两个条件**同时**满足才杀）：
 *   ① 命令行含 `--headless`（排除普通浏览窗口）
 *   ② 命令行含 `xuqian-smoke`（排除别人的 headless 实例 —— 我们的临时 profile 一定是这个名字）
 * 拿不准的时候什么都不杀：宁可这次测试因为旧实例失败，也不误伤用户的浏览器。
 */
const OUR_PROFILE_MARKER = 'xuqian-smoke'

function killStrayBrowsers() {
  const script = [
    "$targets = @(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine -match '--headless' -and $_.CommandLine -match '" + OUR_PROFILE_MARKER + "' });",
    'if ($targets.Count -gt 0) {',
    '  $targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };',
    '  Write-Output ("killed " + $targets.Count)',
    '}',
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  const out = (result.stdout ?? '').trim()
  if (out.startsWith('killed')) console.log(`[smoke] 已清理自己遗留的测试实例（${out.slice(7)} 个，只匹配 --headless + ${OUR_PROFILE_MARKER}）`)
}

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('DevTools 端口未就绪')
}

class Cdp {
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
      }, 120000)
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

async function waitFor(cdp, expression, timeoutMs = 30000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`return Boolean(${expression})`)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待超时: ${label}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 记录 <a download> 的文件名，同时**照常触发真实下载**（下载目录由 CDP 指定）。 */
const PATCH_DOWNLOADS = `
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

/** 通过 CDP 的 file chooser 拦截，把一个真实文件放入页面里第一个 file input。 */
async function uploadFile(cdp, filePath, inputSelector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: inputSelector })
  if (!nodeId) throw new Error(`找不到 input: ${inputSelector}`)
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [filePath] })
}

async function clickByText(cdp, texts, options = {}) {
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

async function setTextArea(cdp, selector, value) {
  await cdp.eval(`
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到输入框: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
}

/**
 * 开始页（加密路线二选一）会挡住主界面：若它在，就先选「简单加密」。
 * 幂等——已进过主界面时什么都不做。本文件刻意不依赖 browser-harness，故自带此逻辑。
 */
async function enterSimpleMode(cdp) {
  const clicked = await cdp.eval(`
    const start = document.querySelector('[data-testid="start-screen"]');
    if (!start) return false;
    const card = document.querySelector('[data-testid="start-simple"]');
    const btn = card ? card.querySelector('button') : null;
    if (!btn) throw new Error('开始页存在但找不到「简单加密」的进入按钮');
    btn.click();
    return true;
  `)
  if (clicked) await sleep(400)
  return clicked
}

/**
 * 无障碍审计（在当前页面上跑）—— 自己实现，不引第三方 axe。
 * 覆盖：html lang / 图片 alt / 控件可访问名 / 正 tabindex / 标题层级 / progressbar 的 ARIA 自洽。
 * **不覆盖**：颜色对比度（需要渲染样式计算，容易假阳性，故不做，也不用"通过"来暗示它没问题）。
 */
const A11Y_AUDIT = `
  return (() => {
    const violations = [];
    const doc = document;
    if (!doc.documentElement.getAttribute('lang')) violations.push('html 缺少 lang 属性');
    for (const img of doc.querySelectorAll('img')) {
      if (!img.hasAttribute('alt')) violations.push('img 缺少 alt：' + String(img.getAttribute('src') || '').slice(0, 50));
    }
    const nameOf = (el) => {
      const labelledBy = el.getAttribute('aria-labelledby');
      const aria = el.getAttribute('aria-label') || (labelledBy && doc.getElementById(labelledBy) ? doc.getElementById(labelledBy).textContent : '');
      if (aria && aria.trim()) return aria.trim();
      if (el.getAttribute('title')) return el.getAttribute('title');
      if ((el.textContent || '').trim()) return el.textContent.trim();
      if (el.id) {
        const lab = doc.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]');
        if (lab && lab.textContent.trim()) return lab.textContent.trim();
      }
      const wrap = el.closest('label');
      if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
      return '';
    };
    for (const el of doc.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]')) {
      if (!nameOf(el)) {
        violations.push('控件无可访问名：<' + el.tagName.toLowerCase() + '> ' + String(el.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 60));
      }
    }
    for (const el of doc.querySelectorAll('[tabindex]')) {
      if (Number(el.getAttribute('tabindex')) > 0) violations.push('存在正 tabindex：' + el.tagName.toLowerCase());
    }
    let prev = 0;
    for (const h of doc.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const level = Number(h.tagName[1]);
      if (prev && level > prev + 1) violations.push('标题层级跳跃：h' + prev + ' → h' + level);
      prev = level;
    }
    for (const bar of doc.querySelectorAll('[role=progressbar]')) {
      const now = Number(bar.getAttribute('aria-valuenow'));
      const min = Number(bar.getAttribute('aria-valuemin') ?? 0);
      const max = Number(bar.getAttribute('aria-valuemax') ?? 100);
      if (!(now >= min && now <= max)) violations.push('progressbar 的 aria-valuenow 越界：' + now);
    }
    return {
      count: violations.length,
      sample: violations.slice(0, 5),
      controls: doc.querySelectorAll('button, a[href], input, select, textarea').length,
    };
  })()
`

/** 在当前页面跑一次无障碍审计并登记结果。 */
async function auditA11y(cdp, label) {
  const result = await cdp.eval(A11Y_AUDIT)
  check(`无障碍审计（${label}）`, result.count === 0, result.count === 0 ? `检查了 ${result.controls} 个控件` : result.sample.join(' ｜ '))
  return result
}

async function switchTab(cdp, needle) {
  await enterSimpleMode(cdp)
  await cdp.eval(`
    const tabs = Array.from(document.querySelectorAll('[role=tab]'));
    const tab = tabs.find((el) => el.textContent.includes(${JSON.stringify(needle)}));
    if (!tab) throw new Error('找不到标签页: ' + ${JSON.stringify(needle)});
    tab.click();
    return true;
  `)
  await sleep(250)
}

const browserPath = findBrowser()
if (!browserPath) {
  console.error('未找到 Edge/Chrome，跳过冒烟测试')
  process.exit(2)
}

// 开跑前先清场：遗留实例会让这次运行连到旧页面，表现成静默挂死（见 killStrayBrowsers 注释）
killStrayBrowsers()

const workDir = mkdtempSync(join(tmpdir(), 'xuqian-smoke-'))
const profileDir = join(workDir, 'profile')
const downloadDir = join(workDir, 'downloads')
const fixtureDir = join(workDir, 'fixtures')
for (const dir of [profileDir, downloadDir, fixtureDir]) {
  writeFileSync(join(workDir, '.keep'), '')
  rmSync(join(workDir, '.keep'), { force: true })
}
const { mkdirSync, readdirSync } = await import('node:fs')
for (const dir of [profileDir, downloadDir, fixtureDir]) mkdirSync(dir, { recursive: true })

/** 列出目录内容，便于诊断"下载没落盘 / 文件名不对"这类问题。 */
function listDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 读 .XUQIAN 的（加密）容器头部 JSON —— 不需要密钥。
 * 先跳过开头的**明文声明前导区**（魔数 6 + 标记 1 + 长度 4 + 正文 N），再按容器布局解析：
 * 容器布局 = magic(6) + version(1) + flags(1) + cs(4) + cc(4) + lc(1) + headerLen(4) + JSON
 */
function readHeaderJson(filePath) {
  const buf = readFileSync(filePath)
  let base = 0
  if (buf.length >= 11 && buf.subarray(0, 6).toString('latin1') === 'XUQIAN' && buf[6] === 2) {
    base = 11 + buf.readUInt32BE(7)
  }
  const jsonLen = buf.readUInt32BE(base + 17)
  return JSON.parse(buf.subarray(base + 21, base + 21 + jsonLen).toString('utf8'))
}

/** 读文件开头的明文声明前导区（不需要密钥）。 */
function readPreambleOf(filePath) {
  const buf = readFileSync(filePath)
  if (buf.length < 11 || buf.subarray(0, 6).toString('latin1') !== 'XUQIAN' || buf[6] !== 2) return null
  const len = buf.readUInt32BE(7)
  return { noticeText: buf.subarray(11, 11 + len).toString('utf8'), noticeBytes: len }
}

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1280,900',
    BASE,
  ],
  { stdio: 'ignore' },
)
console.log(`启动浏览器：${browserPath}`)

let cdp
let exitCode = 0
try {
  const version = await waitForDevtools()
  console.log(`浏览器: ${version.Browser}`)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http')) ?? targets.find((t) => t.type === 'page')
  if (!page) throw new Error('找不到页面目标')

  cdp = await Cdp.attach(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('DOM.enable')
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })

  // 必须先等页面真正加载完（否则可能仍在 about:blank，相对 URL 无法解析）
  await waitFor(cdp, `location.protocol.startsWith('http') && document.querySelector('#root')?.children.length > 0`, 60000, '页面加载完成')
  // 关闭动画/过渡，保证自动化断言期间布局稳定
  await cdp.eval(`document.documentElement.dataset.test = '1'; return true;`)

  // ------------------------------------------------------------------
  // 0. 文档链接可达性（回归：docs/ 曾经根本没被服务，浏览器打开 404）
  // ------------------------------------------------------------------
  const docsProbe = await cdp.eval(`
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    const urls = [
      'docs/index.html',
      'docs/GUIDE.md',
      'docs/FORMAT.md',
      'docs/SECURITY.md',
      'docs/TESTING.md',
      'docs/KEY-LIFECYCLE.md',
      'docs/README.md',
    ];
    const results = [];
    for (const rel of urls) {
      const url = base + rel;
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const text = res.ok ? await res.text() : '';
        results.push({ url: rel, status: res.status, length: text.length });
      } catch (error) {
        results.push({ url: rel, status: 0, error: String(error) });
      }
    }
    // 顺带验证手册里的每张截图都能取到
    let imageFailures = [];
    try {
      const guide = await (await fetch(base + 'docs/GUIDE.md', { cache: 'no-store' })).text();
      const names = Array.from(new Set(Array.from(guide.matchAll(/images\\/([A-Za-z0-9_.-]+\\.png)/g)).map((m) => m[1])));
      for (const name of names) {
        const res = await fetch(base + 'docs/images/' + name, { cache: 'no-store' });
        if (!res.ok) imageFailures.push(name + ':' + res.status);
      }
      return { results, imageCount: names.length, imageFailures };
    } catch (error) {
      return { results, imageCount: -1, imageFailures: [String(error)] };
    }
  `)
  const badDocs = docsProbe.results.filter((r) => r.status !== 200 || r.length < 200)
  check(
    '文档页面全部可访问（7 篇）',
    badDocs.length === 0,
    badDocs.length === 0 ? `${docsProbe.results.length} 篇均 200` : JSON.stringify(badDocs),
  )
  check(
    '手册内 22 张截图链接全部有效',
    docsProbe.imageCount > 0 && docsProbe.imageFailures.length === 0,
    `检查了 ${docsProbe.imageCount} 张，失败 ${docsProbe.imageFailures.length} 张`,
  )
  // ------------------------------------------------------------------
  // 开始页：加密路线二选一（简单加密 / 自研加密）
  // ------------------------------------------------------------------
  await waitFor(cdp, `document.querySelector('#root')?.children.length > 0`, 30000, 'React 挂载')
  const startProbe = await cdp.eval(`
    const start = document.querySelector('[data-testid="start-screen"]');
    const simple = document.querySelector('[data-testid="start-simple"]');
    const self = document.querySelector('[data-testid="start-self"]');
    return {
      hasStart: !!start,
      hasSimple: !!simple,
      hasSelf: !!self,
      selfText: self ? self.innerText.replace(/\\s+/g, ' ') : '',
      simpleText: simple ? simple.innerText.replace(/\\s+/g, ' ') : '',
    };
  `)
  check('开始页展示两条加密路线（简单加密 / 自研加密）', startProbe.hasStart && startProbe.hasSimple && startProbe.hasSelf)
  check(
    '开始页对两条路线都给出了说明',
    /简单加密/.test(startProbe.simpleText) && /成熟/.test(startProbe.simpleText) && /自研加密/.test(startProbe.selfText) && /第三方/.test(startProbe.selfText),
    startProbe.simpleText.slice(0, 40),
  )
  check(
    '自研加密卡片如实标注「格式已可用、与简单加密互不通用」',
    /已经可用/.test(startProbe.selfText) && /互不通用/.test(startProbe.selfText),
    startProbe.selfText.slice(-80),
  )

  // 选「自研加密」→ 进入自研路线主页。用精确选择器，不靠点第几个按钮。
  await cdp.eval(`
    const btn = document.querySelector('[data-testid="start-self"] button');
    if (!btn) throw new Error('找不到自研加密卡片的进入按钮');
    btn.click();
    return true;
  `)
  await sleep(600)

  const selfHome = await cdp.eval(`
    const keys = ['file', 'decrypt', 'watermark', 'ai', 'status'];
    return {
      hasHome: !!document.querySelector('[data-testid="sc-home"]'),
      entries: keys.filter((k) => document.querySelector('[data-testid="sc-entry-' + k + '"]')),
      opens: keys.filter((k) => document.querySelector('[data-testid="sc-open-' + k + '"]')),
    };
  `)
  check(
    '自研路线主页有五个入口（验收：主界面五个入口）',
    selfHome.hasHome === true && selfHome.entries.length === 5 && selfHome.opens.length === 5,
    JSON.stringify(selfHome),
  )

  // 逐页进入：每页都要有自己该有的元素（验收：每个页面独立可用）
  const selfPages = [
    ['file', 'sc-file-input'],
    ['decrypt', 'sc-decrypt-input'],
    ['watermark', 'sc-wm-input'],
    ['ai', 'sc-ai-input'],
    ['status', null],
  ]
  for (const [key, testId] of selfPages) {
    await cdp.eval(`
      const open = document.querySelector('[data-testid="sc-open-${key}"]');
      if (!open) {
        const nav = document.querySelector('[data-testid="sc-nav-${key}"]');
        if (!nav) throw new Error('找不到入口: ${key}');
        nav.click();
      } else {
        open.click();
      }
      return true;
    `)
    await sleep(350)
    const probe = await cdp.eval(`
      return {
        shell: !!document.querySelector('[data-testid="sc-shell"]'),
        target: ${testId ? `!!document.querySelector('[data-testid="${testId}"]')` : 'true'},
      };
    `)
    check(`自研路线「${key}」页可独立打开且元素齐备`, probe.shell === true && probe.target === true, JSON.stringify(probe))
  }

  // ---- 真实链路 1：加密页真的加密一个文件，并给出 32 位十六进制密钥 ----
  const selfPlain = join(workDir, 'self-plain.bin')
  writeFileSync(selfPlain, Buffer.from('XUQIAN-SELF-SMOKE-0123456789'.repeat(40)))
  await cdp.eval(`document.querySelector('[data-testid="sc-nav-file"]').click(); return true;`)
  await sleep(300)
  await uploadFile(cdp, selfPlain, '[data-testid="sc-file-input"]')
  await sleep(300)
  await cdp.eval(`document.querySelector('[data-testid="sc-file-run"]').click(); return true;`)
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-file-result"]')`, 20000, '自研加密结果')
  const selfEnc = await cdp.eval(`
    const node = document.querySelector('[data-testid="sc-file-result"]');
    return node ? node.innerText.replace(/\\s+/g, ' ') : '';
  `)
  const selfKeyMatch = /[0-9a-f]{32}/.exec(selfEnc)
  check('自研加密页真实加密文件并给出 128 位密钥', selfKeyMatch !== null, selfEnc.slice(0, 90))
  check('自研加密页提示密钥不可取回', /取回|抄下/.test(selfEnc), selfEnc.slice(0, 60))

  // 大文件速度如实提示：实测约 1.8–2 MB/s，超过 2MB 就应先告知（选文件即提示，不必真的加密）
  const bigFile = join(workDir, 'self-big.bin')
  writeFileSync(bigFile, Buffer.alloc(3 * 1024 * 1024, 7))
  await uploadFile(cdp, bigFile, '[data-testid="sc-file-input"]')
  await sleep(400)
  const slowWarn = await cdp.eval(`
    const node = document.querySelector('[data-testid="sc-file-slow-warn"]');
    return node ? node.innerText.replace(/\\s+/g, ' ') : '';
  `)
  check('选大文件时如实提示速度（约 1.8–2 MB/s + 预计秒数）', /1\.8–2 MB\/s/.test(slowWarn) && /~\d+ s/.test(slowWarn), slowWarn.slice(0, 90))

  // ---- G11：大文件加密走 Worker —— 用"定时器在加密期间还能触发"证明主线程没被阻塞 ----
  await cdp.eval(`
    window.__xqProgress = [];
    window.__xqNoteSeen = false;
    window.__xqTimer = setInterval(() => {
      const el = document.querySelector('[role=progressbar]');
      if (el) window.__xqProgress.push(Number(el.getAttribute('aria-valuenow')));
      if (document.body.innerText.includes('后台线程')) window.__xqNoteSeen = true;
    }, 250);
    return true;
  `)
  // 顺带量一下**浏览器里的真实吞吐**：界面上给用户的"预计耗时"就该用这个数，而不是 Node 的数
  const encStarted = Date.now()
  await cdp.eval(`document.querySelector('[data-testid="sc-file-run"]').click(); return true;`)
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-file-result"]')`, 90000, '3MB 文件加密结果')
  const browserEncryptMs = Date.now() - encStarted
  const browserMbps = 3 / (browserEncryptMs / 1000)
  check(
    '浏览器实测 3MB 文件加密吞吐（界面 ETA 依据）',
    browserMbps > 0.5,
    `${browserMbps.toFixed(2)} MB/s（${browserEncryptMs} ms / 3 MB）`,
  )
  const g11 = await cdp.eval(`
    clearInterval(window.__xqTimer);
    const values = window.__xqProgress;
    let monotonic = true;
    for (let i = 1; i < values.length; i++) if (values[i] < values[i - 1]) monotonic = false;
    return {
      samples: values.length,
      distinct: [...new Set(values)].length,
      max: values.length ? Math.max(...values) : 0,
      monotonic,
      noteSeen: window.__xqNoteSeen,
    };
  `)
  check(
    'G11：大文件加密期间主线程没被阻塞（进度值在过程中被反复读到）',
    g11.samples >= 3 && g11.distinct >= 2,
    JSON.stringify(g11),
  )
  // 注意：进度条在 busy 结束时就被卸载，所以"在界面上看到 100%"本身是不稳的断言。
  // 这里只断言界面真能验证的部分：多次采样、值在推进、单调不回退。
  // "最后一次 done === total"由内核层单测（test_progress）负责，那才是准确的位置。
  check(
    'G11：进度单调不回退，且确实在推进（界面层）',
    g11.monotonic === true && g11.max >= 30,
    JSON.stringify(g11),
  )
  check('G11：明确告知"在后台线程处理、界面不会卡住"', g11.noteSeen === true, JSON.stringify(g11))
  const bigResult = await cdp.eval(`
    const node = document.querySelector('[data-testid="sc-file-result"]');
    return node ? node.innerText.replace(/\\s+/g, ' ') : '';
  `)
  check('G11：3MB 文件加密完成并给出密钥', /[0-9a-f]{32}/.test(bigResult), bigResult.slice(0, 70))

  // ---- 真实链路 2：解密页对非密文文件必须给「统一失败」提示（验收：所有失败统一提示）----
  await cdp.eval(`document.querySelector('[data-testid="sc-nav-decrypt"]').click(); return true;`)
  await sleep(300)
  await uploadFile(cdp, selfPlain, '[data-testid="sc-decrypt-input"]')
  await sleep(200)
  await cdp.eval(`
    const el = document.querySelector('[data-testid="sc-decrypt-key"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '0123456789abcdef0123456789abcdef');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await sleep(200)
  await cdp.eval(`document.querySelector('[data-testid="sc-decrypt-run"]').click(); return true;`)
  await waitFor(cdp, `document.body.innerText.includes('解密失败')`, 20000, '统一失败提示')
  // 只针对"失败提示本身"断言：找内容恰好等于「解密失败」的叶子节点。
  // 不能拿整页文案去查 MAC/KEY_CHECK —— 页面说明里本来就会出现这些词，那是误报。
  const failProbe = await cdp.eval(`
    const leaves = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && el.textContent.trim() === '解密失败',
    );
    const body = document.body.innerText;
    return {
      exact: leaves.length > 0,
      leaked: /长度字段非法|mac-mismatch|key-check-mismatch|MAC 不匹配|KEY_CHECK 不匹配|校验失败/.test(body),
    };
  `)
  check(
    '自研解密页失败提示统一为「解密失败」且不泄漏失败原因',
    failProbe.exact === true && failProbe.leaked === false,
    JSON.stringify(failProbe),
  )

  // ---- 真实链路 3：水印页可嵌入（给出 WK），对无水印图提取会明确说「未找到」----
  const selfPng = join(process.cwd(), 'docs', 'images', '01-home-encrypt-empty.png')
  await cdp.eval(`document.querySelector('[data-testid="sc-nav-watermark"]').click(); return true;`)
  await sleep(300)
  await uploadFile(cdp, selfPng, '[data-testid="sc-wm-input"]')
  await sleep(400)
  await cdp.eval(`document.querySelector('[data-testid="sc-wm-embed"]').click(); return true;`)
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-wm-embed-result"]')`, 30000, '水印嵌入结果')
  const wmEmbed = await cdp.eval(`
    const node = document.querySelector('[data-testid="sc-wm-embed-result"]');
    return node ? node.innerText.replace(/\\s+/g, ' ') : '';
  `)
  check('自研水印页真实嵌入成功并给出 WK', /[0-9a-f]{32}/.test(wmEmbed), wmEmbed.slice(0, 80))

  await cdp.eval(`document.querySelector('[data-testid="sc-wm-extract"]').click(); return true;`)
  await sleep(1500)
  const wmExtract = await cdp.eval(`return document.body.innerText.replace(/\\s+/g, ' ')`)
  check('对未嵌水印的图提取 → 明确提示「未找到可识别的水印」', /未找到可识别的水印/.test(wmExtract), wmExtract.slice(0, 60))

  // ---- 有形水印：UI 接线 ----
  await cdp.eval(`
    const box = document.querySelector('[data-testid="sc-wm-visible-toggle"]');
    if (!box) throw new Error('找不到有形水印开关');
    if (!box.checked) box.click();
    return box.checked;
  `)
  await sleep(250)
  await cdp.eval(`
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const el = document.querySelector('[data-testid="sc-wm-visible-text"]');
    if (!el) throw new Error('找不到有形水印文字输入框');
    setter.call(el, 'XUQIAN 许七安密匣');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await sleep(200)
  // 先确认表单状态真的进了 React（受控组件被 revert 时，这里会立刻暴露）
  const wmForm = await cdp.eval(`
    const box = document.querySelector('[data-testid="sc-wm-visible-toggle"]');
    const text = document.querySelector('[data-testid="sc-wm-visible-text"]');
    return { checked: box ? box.checked : null, text: text ? text.value : null };
  `)
  check('有形水印表单已就绪（开关已勾、文字已填）', wmForm.checked === true && (wmForm.text ?? '').length > 0, JSON.stringify(wmForm))
  await cdp.eval(`document.querySelector('[data-testid="sc-wm-embed"]').click(); return true;`)
  // 注意：预览画布在**上一次**嵌入时就已存在，直接等它等于没等（探针会读到旧结果）。
  // 必须等"有形水印实际参数"这一行真的变成 px/%/px 形态。
  await waitFor(
    cdp,
    `/\\d+px \\/ \\d+% \\/ \\d+px/.test(document.querySelector('[data-testid="sc-wm-embed-result"]')?.innerText ?? '')`,
    30000,
    '有形水印参数行更新',
  )
  const visibleProbe = await cdp.eval(`
    const canvas = document.querySelector('[data-testid="sc-wm-preview"]');
    const result = document.querySelector('[data-testid="sc-wm-embed-result"]');
    return {
      width: canvas ? canvas.width : 0,
      height: canvas ? canvas.height : 0,
      params: result ? result.innerText.replace(/\\s+/g, ' ') : '',
    };
  `)
  check('有形水印：界面出现预览画布且尺寸正确', visibleProbe.width > 100 && visibleProbe.height > 100, JSON.stringify(visibleProbe))
  check(
    '有形水印：界面如实报出实际参数（字号/透明度/边距）',
    /\d+px \/ \d+% \/ \d+px/.test(visibleProbe.params),
    visibleProbe.params.slice(0, 90),
  )

  // ---- 有形水印：真浏览器里的 Canvas 绘制 + 与 LSB 的可见性对照 ----
  // 这一条补的正是阶段三遗留缺口「有形水印的 Canvas 绘制未在真浏览器验证」。
  const canvasCheck = await cdp.eval(`
    const browser = await import('/src/components/selfcrypto/browser.ts');
    const visible = await import('/src/selfcrypto/watermark/visible.js');
    const extract = await import('/src/selfcrypto/watermark/extract.js');

    // 用站点自己的 docs 图片（public/docs 下已同步）当作真实输入
    const response = await fetch('/docs/images/01-home-encrypt-empty.png');
    const blob = await response.blob();
    const file = new File([blob], 'real.png', { type: 'image/png' });

    const original = await browser.imageFileToImageData(file);
    const { outputImage } = extract.embedWatermark(original, { publicInfo: '公开信息', privateInfo: '私有信息' });

    // ① 只做 LSB 嵌入（不加有形层）→ 变化应极其微小
    const lsbOnly = document.createElement('canvas');
    browser.paintImageToCanvas(lsbOnly, outputImage);
    const lsbCtx = lsbOnly.getContext('2d', { willReadFrequently: true });
    const lsbPixels = lsbCtx.getImageData(0, 0, lsbOnly.width, lsbOnly.height).data;

    // ② 再叠加有形水印 → 应出现明显变化，且集中在指定角落
    const withVisible = document.createElement('canvas');
    browser.paintImageToCanvas(withVisible, outputImage, (ctx, img) => {
      visible.drawVisibleWatermark(ctx, img, { text: 'XUQIAN 许七安密匣', position: 'bottom-right' });
    });
    const vCtx = withVisible.getContext('2d', { willReadFrequently: true });
    const vPixels = vCtx.getImageData(0, 0, withVisible.width, withVisible.height).data;

    const w = withVisible.width;
    const h = withVisible.height;
    let lsbMax = 0;
    let visibleCount = 0;
    let visibleInBottomRight = 0;
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      let d1 = 0;
      let d2 = 0;
      for (let c = 0; c < 3; c++) {
        d1 = Math.max(d1, Math.abs(lsbPixels[i + c] - original.data[i + c]));
        d2 = Math.max(d2, Math.abs(vPixels[i + c] - original.data[i + c]));
      }
      if (d1 > lsbMax) lsbMax = d1;
      if (d2 > 1) {
        visibleCount += 1;
        const x = p % w;
        const y = Math.floor(p / w);
        if (x > w * 0.5 && y > h * 0.85) visibleInBottomRight += 1;
      }
    }
    return { lsbMax, visibleCount, visibleInBottomRight, total: w * h, w, h };
  `)
  check(
    '真浏览器里 LSB 嵌入后逐通道最大变化 ≤ 1（肉眼不可见）',
    canvasCheck.lsbMax <= 1,
    `max delta=${canvasCheck.lsbMax}`,
  )
  check(
    '真浏览器里有形水印确实画上了像素（且集中在右下角）',
    canvasCheck.visibleCount > 50 && canvasCheck.visibleInBottomRight > 20,
    `变化像素 ${canvasCheck.visibleCount}/${canvasCheck.total}，右下角 ${canvasCheck.visibleInBottomRight}`,
  )

  // ---- 全图平铺水印（用户新增需求）：四个象限都要被盖到 ----
  const tileCheck = await cdp.eval(`
    const browser = await import('/src/components/selfcrypto/browser.ts');
    const visible = await import('/src/selfcrypto/watermark/visible.js');
    const extract = await import('/src/selfcrypto/watermark/extract.js');

    const response = await fetch('/docs/images/01-home-encrypt-empty.png');
    const blob = await response.blob();
    const original = await browser.imageFileToImageData(new File([blob], 'real.png', { type: 'image/png' }));
    const { outputImage } = extract.embedWatermark(original, { publicInfo: 'x' });

    const canvas = document.createElement('canvas');
    browser.paintImageToCanvas(canvas, outputImage, (ctx, img) => {
      visible.drawVisibleWatermark(ctx, img, { mode: 'tile', text: 'XUQIAN 许七安密匣' });
    });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const w = canvas.width, h = canvas.height;
    const quads = [0, 0, 0, 0];
    let changed = 0;
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(px[i + c] - original.data[i + c]));
      if (d > 1) {
        changed += 1;
        const x = p % w, y = Math.floor(p / w);
        quads[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)] += 1;
      }
    }
    // 旋转角是否真的用上了：比较 tile 与不旋转版本不可能完全一样，这里只报角度
    const style = visible.computeTileWatermarkStyle({ width: w, height: h }, { text: 'XUQIAN 许七安密匣' });
    const counts = visible.tileCounts(style);
    return { changed, total: w * h, quads, angle: style.angle, tiles: counts.total, fontSize: style.fontSize, opacity: style.opacity };
  `)
  check(
    '全图平铺水印：四个象限都被覆盖（角落模式只有 1 个象限）',
    tileCheck.quads.every((q) => q > 20),
    `各象限变化像素 ${tileCheck.quads.join(' / ')}，总计 ${tileCheck.changed}`,
  )
  check(
    '全图平铺水印：覆盖量远大于角落模式，且角度/条数如实可报',
    tileCheck.changed > canvasCheck.visibleCount * 5 && tileCheck.angle === -30 && tileCheck.tiles > 100,
    `平铺 ${tileCheck.changed} vs 角落 ${canvasCheck.visibleCount}；${tileCheck.angle}° / ${tileCheck.tiles} 条`,
  )

  // ---- 平铺模式的界面接线：切模式后参数行应显示角度与条数 ----
  await cdp.eval(`
    const select = document.querySelector('[data-testid="sc-wm-mode"]');
    if (!select) throw new Error('找不到水印方式选择器');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'tile');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  `)
  await sleep(300)
  await cdp.eval(`document.querySelector('[data-testid="sc-wm-embed"]').click(); return true;`)
  await waitFor(
    cdp,
    `/\\d+px \\/ \\d+% \\/ -?\\d+°/.test(document.querySelector('[data-testid="sc-wm-embed-result"]')?.innerText ?? '')`,
    30000,
    '平铺参数行（角度）',
  )
  const tileUi = await cdp.eval(`
    const node = document.querySelector('[data-testid="sc-wm-embed-result"]');
    return node ? node.innerText.replace(/\\s+/g, ' ') : '';
  `)
  // 注意：这里是普通正则字面量（不是模板字符串里的表达式），所以用单反斜杠 \d
  check('平铺模式在界面上可用，并如实报出角度与条数', /-30°/.test(tileUi) && /\d+ (条|tiles)/.test(tileUi), tileUi.slice(0, 110))

  // ---- 真实链路 4：AI 检测页给出报告，且报告带「未标定」声明 ----
  await cdp.eval(`document.querySelector('[data-testid="sc-nav-ai"]').click(); return true;`)
  await sleep(300)
  await uploadFile(cdp, selfPng, '[data-testid="sc-ai-input"]')
  await sleep(400)
  await cdp.eval(`document.querySelector('[data-testid="sc-ai-run"]').click(); return true;`)
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-ai-generated"]')`, 30000, 'AI 检测报告')
  // 水印分栏是 detectAIWatermark 的异步结果，必须单独等，不能跟着生成分栏一起断言
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-ai-watermark"]')`, 30000, 'AI 水印检出分栏')
  const aiReport = await cdp.eval(`
    const node = document.querySelector('[data-testid="sc-ai-generated"]');
    return {
      text: node ? node.innerText.replace(/\\s+/g, ' ') : '',
      hasWatermarkReport: !!document.querySelector('[data-testid="sc-ai-watermark"]'),
    };
  `)
  check('自研 AI 检测页输出报告（含水印检出分栏）', aiReport.hasWatermarkReport === true, aiReport.text.slice(0, 80))
  check(
    'AI 检测报告写明「未标定 + 不能作为结论」',
    /未标定|未经真实样本标定/.test(aiReport.text) && /不能作为结论/.test(aiReport.text),
    aiReport.text.slice(-120),
  )

  // ---- 阶段六（存储与部署）：数据真的存在本机，且跨刷新仍在 ----
  // 先勾选「存入本地密文库」再加密一次
  await cdp.eval(`document.querySelector('[data-testid="sc-nav-file"]').click(); return true;`)
  await sleep(300)
  await uploadFile(cdp, selfPlain, '[data-testid="sc-file-input"]')
  await sleep(250)
  await cdp.eval(`
    const box = document.querySelector('[data-testid="sc-file-save-local"]');
    if (!box) throw new Error('找不到「存入本地密文库」勾选框');
    if (!box.checked) box.click();
    return box.checked;
  `)
  await sleep(200)
  await cdp.eval(`document.querySelector('[data-testid="sc-file-run"]').click(); return true;`)
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-file-result"]')`, 20000, '带存库的加密结果')
  await sleep(500)

  // 刷新页面：selfTab 不持久化，会回到自研主页；mode 持久化，所以仍在自研路线
  await cdp.send('Page.reload')
  await waitFor(cdp, `document.querySelector('#root')?.children.length > 0`, 30000, '刷新后 React 挂载')
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-home"]')`, 20000, '刷新后回到自研主页')
  await cdp.eval(`document.querySelector('[data-testid="sc-open-decrypt"]').click(); return true;`)
  await waitFor(cdp, `!!document.querySelector('[data-testid="sc-decrypt-library"]')`, 20000, '本地密文库区块')
  const libraryAfterReload = await cdp.eval(`
    const items = Array.from(document.querySelectorAll('[data-testid="sc-decrypt-lib-item"]'));
    return { count: items.length, text: items.map((el) => el.innerText.replace(/\\s+/g, ' ')).join(' | ') };
  `)
  check(
    '刷新后本地密文库仍有记录（验收：数据存本地）',
    libraryAfterReload.count > 0 && /self-plain\.bin\.xuqian/.test(libraryAfterReload.text),
    JSON.stringify(libraryAfterReload).slice(0, 120),
  )

  // 直接从本地密文库选用密文作为解密来源
  await cdp.eval(`document.querySelector('[data-testid="sc-decrypt-lib-use"]').click(); return true;`)
  await sleep(400)
  const fromLibrary = await cdp.eval(`return document.body.innerText.replace(/\\s+/g, ' ')`)
  check('可从本地密文库直接选用密文（无需重新选文件）', /本地密文库/.test(fromLibrary) && /self-plain\.bin\.xuqian/.test(fromLibrary), fromLibrary.slice(0, 80))

  // 直接查库，确认落库记录里**没有**任何密钥类字段（SPEC §7 红线，在真浏览器里验）
  const storedFields = await cdp.eval(`
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('xuqian-self-crypto', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction('ciphertext', 'readonly');
      const req = tx.objectStore('ciphertext').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const fields = new Set();
    for (const record of all) for (const key of Object.keys(record)) fields.add(key);
    const bytesIsArray = all.every((r) => r.bytes instanceof Uint8Array);
    return { count: all.length, fields: Array.from(fields).sort(), bytesIsArray };
  `)
  const forbiddenInStore = storedFields.fields.filter((f) => /key|pass|secret|wk|recover|seed/i.test(f))
  check(
    '落库记录只含密文与展示字段，**无任何密钥字段**（SPEC §7 红线）',
    storedFields.count > 0 && forbiddenInStore.length === 0 && storedFields.bytesIsArray === true,
    `字段=${storedFields.fields.join(',')} 可疑=${forbiddenInStore.join(',') || '无'}`,
  )

  // 删除后列表应变空
  await cdp.eval(`document.querySelector('[data-testid="sc-decrypt-lib-delete"]').click(); return true;`)
  await sleep(600)
  const libraryAfterDelete = await cdp.eval(`
    return {
      items: document.querySelectorAll('[data-testid="sc-decrypt-lib-item"]').length,
      empty: !!document.querySelector('[data-testid="sc-decrypt-lib-empty"]'),
    };
  `)
  check('删除后本地密文库为空', libraryAfterDelete.items === 0 && libraryAfterDelete.empty === true, JSON.stringify(libraryAfterDelete))

  // ---- 整库备份（D36）：导出 → 清库 → 导入 → 恢复 ----
  // 走页面自己的模块，在**真浏览器 + 真 IndexedDB** 里跑一遍"清浏览器数据后自救"的完整链路。
  const backup = await cdp.eval(`
    const storage = await import('/src/selfcrypto/storage/indexeddb.js');
    await storage.saveCiphertext({ name: 'backup-a.xuqian', bytes: new Uint8Array([1,2,3,4,5]) });
    await storage.saveCiphertext({ name: '备份-中文名.xuqian', bytes: new Uint8Array(1000).fill(7) });
    const before = await storage.listCiphertexts();
    const archive = await storage.exportAllCiphertexts();
    await storage.clearAll();
    const afterClear = await storage.listCiphertexts();
    const saved = await storage.importCiphertextsFromArchive(archive);
    const afterImport = await storage.listCiphertexts();
    const nameSet = new Set(afterImport.map((r) => r.name));
    return {
      before: before.length,
      archiveBytes: archive.length,
      afterClear: afterClear.length,
      saved,
      afterImport: afterImport.length,
      restoredA: nameSet.has('backup-a.xuqian'),
      restoredCn: nameSet.has('备份-中文名.xuqian'),
      noKeyField: afterImport.every((r) => !Object.keys(r).some((k) => /key|pass|secret|wk/i.test(k))),
    };
  `)
  check(
    '备份：导出→清库→导入 能把密文库恢复回来（真浏览器 + 真 IndexedDB）',
    backup.before >= 2 && backup.afterClear === 0 && backup.afterImport === backup.before && backup.restoredA && backup.restoredCn,
    JSON.stringify(backup),
  )
  check(
    '备份：恢复出来的记录里依然没有密钥字段',
    backup.noKeyField === true && backup.saved === backup.before,
    JSON.stringify(backup),
  )

  const backupUi = await cdp.eval(`
    return {
      exportBtn: !!document.querySelector('[data-testid="sc-decrypt-lib-export"]'),
      importInput: !!document.querySelector('[data-testid="sc-decrypt-lib-import"]'),
    };
  `)
  check('备份：解密页有「导出整库备份」与「导入备份」入口', backupUi.exportBtn && backupUi.importInput, JSON.stringify(backupUi))

  // ---- 用量与配额告警（D38）：如实显示"多少条 / 占配额多少"，且**不自动删任何东西** ----
  // 上面的备份测试是**直接用模块**写库的，界面的用量状态还是旧的 —— 所以这里先点「刷新」，
  // 走的才是真实 UI 路径（用户看到刷新后的数字）。
  await cdp.eval(`document.querySelector('[data-testid="sc-decrypt-lib-refresh"]').click(); return true;`)
  await sleep(600)
  const usageUi = await cdp.eval(`
    const node = document.querySelector('[data-testid="sc-decrypt-usage"]');
    const storage = await import('/src/selfcrypto/storage/indexeddb.js');
    const usage = await storage.libraryUsage();
    return {
      text: node ? node.innerText.replace(/\\s+/g, ' ') : '',
      records: usage.records,
      bytes: usage.bytes,
      ratio: usage.ratio,
      nearQuota: usage.nearQuota,
    };
  `)
  check(
    '用量：界面显示条数与密文合计，且与库内实际一致',
    usageUi.records > 0 && new RegExp(usageUi.records + '\\s*条').test(usageUi.text),
    JSON.stringify(usageUi),
  )
  check(
    '用量：配额只在浏览器给得出时显示；接近上限才告警（不自动删除）',
    (usageUi.ratio === null && !usageUi.text.includes('%')) || (usageUi.ratio !== null && usageUi.text.includes('%')),
    JSON.stringify(usageUi),
  )

  // 打包产物：SPEC 阶段六「打包 dist 目录」
  const distIndex = join(process.cwd(), 'dist', 'index.html')
  check('打包产物 dist/index.html 存在（SPEC 阶段六）', existsSync(distIndex), distIndex)

  // 切回开始页 → 再选「简单加密」进入主界面
  await clickByText(cdp, ['切换加密方式', 'Switch route'])
  await sleep(500)
  const backToStart = await cdp.eval(`return !!document.querySelector('[data-testid="start-screen"]')`)
  check('可从主界面切回开始页重新选择', backToStart)
  const enteredSimple = await enterSimpleMode(cdp)
  check('选择「简单加密」进入主界面', enteredSimple || backToStart)

  const docsEntry = await cdp.eval(`
    const link = Array.from(document.querySelectorAll('a')).find((el) => /docs\\/index\\.html/.test(el.getAttribute('href') ?? ''));
    return link ? { href: link.getAttribute('href'), text: link.textContent.trim() } : null;
  `)
  check('应用内「文档」入口存在且指向正确的索引页', docsEntry !== null, docsEntry ? JSON.stringify(docsEntry) : 'null')

  const title = await cdp.eval(`return document.title`)
  check('品牌标题正确', /XUQIAN/.test(title), title)

  const tabs = await cdp.eval(`return Array.from(document.querySelectorAll('[role=tab]')).map((el) => el.textContent)`)
  check('四个主 Tab 存在', Array.isArray(tabs) && tabs.length === 4, JSON.stringify(tabs))

  await cdp.eval(PATCH_DOWNLOADS)

  // ------------------------------------------------------------------
  // A. 文本模式：密钥一次性展示与销毁
  // ------------------------------------------------------------------
  await switchTab(cdp, '文本')
  const plainMarker = `SMOKE-PLAINTEXT-${Date.now()}`
  await setTextArea(cdp, '[data-testid=text-plain]', plainMarker)
  await clickByText(cdp, ['加密文本', 'Encrypt text'], { exact: true })

  await waitFor(cdp, `document.querySelector('#xq-key-title') !== null`, 60000, '密钥弹窗出现')
  check('加密后自动弹出密钥弹窗（验收 13）', true)

  const modalText = await cdp.eval(`return document.body.innerText`)
  check(
    '弹窗含“只显示这一次 / 关闭即销毁 / 无法再次查看”警告（验收 14）',
    /只显示这一次/.test(modalText) && /无法再次查看/.test(modalText),
  )

  const keyInfo = await cdp.eval(`
    const areas = Array.from(document.querySelectorAll('textarea'));
    const hexArea = areas.find((el) => /^[0-9a-f]{32}$/i.test(el.value.trim()));
    const b64Area = areas.find((el) => /^[A-Za-z0-9+/]{22}==$/.test(el.value.trim()));
    const fpNode = Array.from(document.querySelectorAll('div')).find((el) => /^[0-9A-F]{16}$/.test(el.textContent.trim()));
    return {
      hex: hexArea ? hexArea.value.trim() : null,
      base64: b64Area ? b64Area.value.trim() : null,
      fingerprint: fpNode ? fpNode.textContent.trim() : null,
      selected: hexArea ? hexArea.selectionStart === 0 && hexArea.selectionEnd === hexArea.value.length : false,
    };
  `)
  check('Hex 为 32 字符（128 位）', typeof keyInfo.hex === 'string' && keyInfo.hex.length === 32, keyInfo.hex ?? 'null')
  check('Base64 为 24 字符', typeof keyInfo.base64 === 'string' && keyInfo.base64.length === 24, keyInfo.base64 ?? 'null')
  check('展示密钥指纹', typeof keyInfo.fingerprint === 'string' && /^[0-9A-F]{16}$/.test(keyInfo.fingerprint), keyInfo.fingerprint ?? 'null')
  check('弹窗打开时默认选中密钥', keyInfo.selected === true)

  const qrPainted = await cdp.eval(`
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
    return dark > 50;
  `)
  check('弹窗内二维码已渲染', qrPainted === true)

  await clickByText(cdp, ['我已复制，关闭并销毁'])
  await waitFor(cdp, `/尚未复制或下载密钥/.test(document.body.innerText)`, 10000, '二次确认出现')
  check('未复制/未下载时关闭弹出二次确认（验收 15）', true)

  await clickByText(cdp, ['取消', 'Cancel'], { exact: true })
  await sleep(250)
  const stillOpen = await cdp.eval(`
    const areas = Array.from(document.querySelectorAll('textarea'));
    const hexArea = areas.find((el) => /^[0-9a-f]{32}$/i.test(el.value.trim()));
    return { open: document.querySelector('#xq-key-title') !== null, hex: hexArea ? hexArea.value.trim() : null };
  `)
  check('取消后弹窗保持打开且密钥仍在', stillOpen.open && stillOpen.hex === keyInfo.hex)

  // 下载密钥文件（标记为已保存）后关闭
  await cdp.eval(`window.__xqDownloads = []; return true;`)
  await clickByText(cdp, ['下载 .XUQIANKEY'])
  await sleep(500)
  const keyDownloads = await cdp.eval(`return window.__xqDownloads`)
  check('可下载 .XUQIANKEY 密钥文件', Array.isArray(keyDownloads) && keyDownloads.some((n) => n.endsWith('.XUQIANKEY')), JSON.stringify(keyDownloads))

  await clickByText(cdp, ['我已复制，关闭并销毁'])
  await sleep(400)
  const confirmVisible = await cdp.eval(`return /尚未复制或下载密钥/.test(document.body.innerText)`)
  if (confirmVisible) await clickByText(cdp, ['确认关闭并销毁'])
  await waitFor(cdp, `document.querySelector('#xq-key-title') === null`, 20000, '弹窗关闭')
  check('关闭后弹窗销毁（验收 16 前置）', true)

  // 残留检查
  const residue = await cdp.eval(`
    const dump = (store) => {
      let out = '';
      for (let i = 0; i < store.length; i++) out += store.key(i) + '=' + store.getItem(store.key(i)) + '\\n';
      return out;
    };
    const needle = ${JSON.stringify(keyInfo.hex.toLowerCase())};
    let idbNames = [];
    try { idbNames = (await indexedDB.databases?.()) ?? []; } catch {}
    return {
      localStorage: dump(localStorage),
      sessionStorage: dump(sessionStorage),
      cookie: document.cookie,
      url: location.href,
      idbCount: idbNames.length,
      text: document.body.innerText,
    };
  `)
  const hexLower = keyInfo.hex.toLowerCase()
  check('localStorage 中无密钥（验收 17）', !residue.localStorage.toLowerCase().includes(hexLower))
  check('sessionStorage 中无密钥（验收 17）', !residue.sessionStorage.toLowerCase().includes(hexLower))
  check('Cookie 中无密钥（验收 17）', !residue.cookie.includes(keyInfo.hex))
  check('URL 中无密钥', !residue.url.toLowerCase().includes(hexLower))
  // 注意：这一项原本是「IndexedDB 未被使用」。SPEC 阶段六明确要求用 IndexedDB 存**密文**，
  // 所以"库里什么都没有"不再是正确判据（自研路线的密文库会合法地存在）。
  // 改成更强的判据：**直接翻库内容**，确认里面既没有密钥、也没有密钥类字段。
  const idbResidue = await cdp.eval(`
    const names = (await indexedDB.databases()).map((d) => d.name);
    let serialized = '';
    const fields = [];
    for (const name of names) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readonly');
          const req = tx.objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        for (const row of rows) {
          for (const [key, value] of Object.entries(row)) {
            fields.push(key);
            if (!(value instanceof Uint8Array)) serialized += ' ' + key + '=' + String(value);
          }
        }
      }
      db.close();
    }
    return { count: names.length, serialized, fields };
  `)
  const idbKeyFields = idbResidue.fields.filter((f) => /key|pass|secret|wk|recover|seed/i.test(f))
  check(
    'IndexedDB 中无密钥、也无密钥类字段（验收 17，SPEC 阶段六后改判据）',
    !idbResidue.serialized.toLowerCase().includes(hexLower) && idbKeyFields.length === 0,
    `库数=${idbResidue.count} 字段=${[...new Set(idbResidue.fields)].join(',') || '无'} 可疑=${idbKeyFields.join(',') || '无'}`,
  )
  check('关闭后页面内无法再次看到该密钥（验收 16）', !residue.text.toLowerCase().includes(hexLower))

  const cipher = await cdp.eval(`return document.querySelector('[data-testid=text-cipher]').value`)
  check('文本密文已生成', typeof cipher === 'string' && cipher.startsWith('XUQIAN1:'))

  // 刷新后密钥不得恢复
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor(cdp, `document.querySelector('#root')?.children.length > 0`, 30000, '刷新后重新挂载')
  await cdp.eval(PATCH_DOWNLOADS)
  const afterReload = await cdp.eval(`
    const dump = (store) => { let out=''; for (let i=0;i<store.length;i++) out += store.key(i)+'='+store.getItem(store.key(i))+'\\n'; return out; };
    return { body: document.body.innerText, storage: dump(localStorage) + dump(sessionStorage) };
  `)
  check('刷新后密钥不存在（验收 18）', !afterReload.storage.toLowerCase().includes(hexLower))
  check('刷新后页面无密钥文本', !afterReload.body.toLowerCase().includes(hexLower))

  // 错误密钥 / 正确密钥
  await switchTab(cdp, '文本')
  await setTextArea(cdp, '[data-testid=text-cipher]', cipher)
  await setTextArea(cdp, '[data-testid=text-key]', keyInfo.hex.split('').reverse().join(''))
  await clickByText(cdp, ['解密文本', 'Decrypt text'], { exact: true })
  await waitFor(cdp, `/密钥错误或文件损坏|Wrong key or corrupted file/.test(document.body.innerText)`, 30000, '错误密钥提示')
  check('错误密钥提示统一为“密钥错误或文件损坏”（验收 9）', true)

  await setTextArea(cdp, '[data-testid=text-key]', keyInfo.hex)
  await clickByText(cdp, ['解密文本', 'Decrypt text'], { exact: true })
  await waitFor(
    cdp,
    `document.querySelector('[data-testid=text-plain]')?.value.includes(${JSON.stringify(plainMarker)})`,
    30000,
    '正确密钥解密',
  )
  check('正确密钥解密成功、内容一致（验收 3 / 6）', true)
  check('解密后自动做 SHA-256 校验（验收 6）', /哈希校验：一致|SHA-256 一致/.test(await cdp.eval(`return document.body.innerText`)))

  // ------------------------------------------------------------------
  // B. 文件模式：真实文件加密 → 下载 → 解密 → 字节级还原
  // ------------------------------------------------------------------
  const filePlans = [
    { name: 'photo.jpg', size: 150_000, layers: 1, algo: 'AES-128-GCM' },
    { name: 'notes.txt', size: 4_096, layers: 2, algo: 'CHACHA20-POLY1305' },
    { name: 'empty.bin', size: 0, layers: 1, algo: 'AES-256-GCM' },
  ]
  const fixtures = []
  for (const plan of filePlans) {
    const bytes = Buffer.alloc(plan.size)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 17) & 0xff
    const path = join(fixtureDir, plan.name)
    writeFileSync(path, bytes)
    fixtures.push({ ...plan, path, sha: bytes.toString('base64') })
  }

  for (const fixture of fixtures) {
    await switchTab(cdp, '加密')
    // 清空队列
    await cdp.eval(`
      const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '清空' || el.textContent.trim() === 'Clear');
      if (btn) btn.click();
      return true;
    `)
    await sleep(150)

    // 设定层数
    await cdp.eval(`
      const algoSelects = () => Array.from(document.querySelectorAll('select')).filter((el) => /GCM|CHACHA/.test(el.options[0]?.textContent ?? ''));
      const wanted = ${fixture.layers};
      for (let guard = 0; guard < 12; guard++) {
        const current = algoSelects().length;
        if (current === wanted) break;
        if (current < wanted) {
          const add = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('加密层数'));
          add.click();
        } else {
          const removes = Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === '✕');
          removes[removes.length - 1].click();
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      const setSelect = (el, label) => {
        const option = Array.from(el.options).find((o) => o.value === label);
        if (!option) throw new Error('找不到算法: ' + label);
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(el, option.value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const first = algoSelects()[0];
      setSelect(first, ${JSON.stringify(fixture.algo)});
      return algoSelects().length;
    `)

    // 上传文件并加入队列
    await uploadFile(cdp, fixture.path, 'input[type=file]')
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(fixture.name)})`, 20000, '文件加入队列')

    await cdp.eval(`window.__xqDownloads = []; return true;`)
    await clickByText(cdp, ['开始加密'])
    await waitFor(cdp, `document.querySelector('#xq-key-title') !== null`, 120000, `加密 ${fixture.name} 后弹出密钥弹窗`)

    const fileKey = await cdp.eval(`
      const areas = Array.from(document.querySelectorAll('textarea'));
      return areas.map((el) => el.value.trim()).find((v) => /^[0-9a-f]{32}$/i.test(v)) ?? null;
    `)
    if (!fileKey) throw new Error('密钥弹窗里没有读到 Hex 密钥')
    check(`每次加密生成不同的 128 位密钥（${fixture.name}）`, fileKey !== keyInfo.hex)

    // 下载密钥文件后关闭弹窗
    await clickByText(cdp, ['下载 .XUQIANKEY'])
    await sleep(400)
    try {
      const clicked = await cdp.eval(`
        const wanted = '我已复制，关闭并销毁';
        const buttons = Array.from(document.querySelectorAll('button'));
        const matches = buttons.filter((el) => el.textContent.trim() === wanted);
        if (matches.length === 0) return { clicked: false, matches: 0 };
        matches[0].click();
        return { clicked: true, matches: matches.length };
      `)
      await sleep(500)
      const afterClick = await cdp.eval(`
        const wanted = '我已复制，关闭并销毁';
        return {
          modalOpen: document.querySelector('#xq-key-title') !== null,
          confirmVisible: Array.from(document.querySelectorAll('button')).some((el) => el.textContent.includes('确认关闭并销毁')),
          matches: Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === wanted).length,
        };
      `)
      if (afterClick.confirmVisible) {
        await cdp.eval(`
          const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('确认关闭并销毁'));
          btn.click();
          return true;
        `)
      }
      await waitFor(cdp, `document.querySelector('#xq-key-title') === null`, 20000, '密钥弹窗关闭')
      check(`关闭密钥弹窗（${fixture.name}）`, true, JSON.stringify({ clicked, afterClick }))
    } catch (error) {
      const diag = await cdp.eval(`
        return {
          modalOpen: document.querySelector('#xq-key-title') !== null,
          bodyText: document.body.innerText.slice(0, 1200),
          downloads: window.__xqDownloads,
        };
      `)
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(workDir, `failure-${fixture.name}.png`), Buffer.from(shot.data, 'base64'))
      check(`关闭密钥弹窗（${fixture.name}）`, false, `${error.message} | ${JSON.stringify(diag).slice(0, 500)}`)
      writeFileSync(join(process.cwd(), 'smoke-failure.png'), Buffer.from(shot.data, 'base64'))
      throw error
    }

    // 下载 .XUQIAN
    const encName = await cdp.eval(`
      window.__xqDownloads = [];
      const btn = Array.from(document.querySelectorAll('button')).find((el) => /下载.*\\.XUQIAN$/.test(el.textContent.trim()));
      if (!btn) throw new Error('找不到 .XUQIAN 下载按钮');
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      return window.__xqDownloads.find((n) => n.endsWith('.XUQIAN')) ?? null;
    `)
    check(`加密输出为 .XUQIAN 后缀（${fixture.name}，验收 1）`, typeof encName === 'string' && encName.endsWith('.XUQIAN'), encName ?? 'null')

    // 等待真实下载落盘
    let encPath = join(downloadDir, encName ?? '')
    for (let i = 0; i < 60 && !existsSync(encPath); i++) await sleep(200)
    check(`文件已下载到本地（${fixture.name}）`, existsSync(encPath), encName ?? '')

    // 解密
    await switchTab(cdp, '解密')
    await setTextArea(cdp, 'textarea', fileKey)
    await uploadFile(cdp, encPath, 'input[type=file]')
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(encName)})`, 20000, '密文加入解密队列')
    await clickByText(cdp, ['开始解密'])
    await waitFor(cdp, `/解密完成|Decryption finished/.test(document.body.innerText)`, 120000, '完成解密')

    const decName = await cdp.eval(`
      window.__xqDownloads = [];
      const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('下载还原文件'));
      if (!btn) throw new Error('找不到还原文件按钮');
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      return window.__xqDownloads[0] ?? null;
    `)
    const decPath = join(downloadDir, decName ?? '')
    for (let i = 0; i < 60 && !existsSync(decPath); i++) await sleep(200)

    if (existsSync(decPath)) {
      const restored = readFileSync(decPath)
      check(
        `解密后文件与原文件字节一致（${fixture.name}，验收 6）`,
        restored.toString('base64') === fixture.sha,
        `${restored.length} bytes`,
      )
      check(`解密还原原文件名（${fixture.name}，验收 1）`, decName === fixture.name, decName ?? 'null')
    } else {
      check(`解密后文件已下载（${fixture.name}）`, false, decName ?? 'null')
    }
  }

  // ------------------------------------------------------------------
  // D. 用 .XUQIANKEY 文件解密（含密码保护）—— 回归：文件读取 / 重渲染时序
  // ------------------------------------------------------------------
  const KEYFILE_PASSWORD = 'S3cret-Passw0rd!'
  const keyFileBytes = Buffer.alloc(2048)
  for (let i = 0; i < keyFileBytes.length; i++) keyFileBytes[i] = (i * 53 + 11) & 0xff
  const keyFileFixturePath = join(fixtureDir, 'keyfile-case.dat')
  writeFileSync(keyFileFixturePath, keyFileBytes)
  const keyFileFixtureSha = keyFileBytes.toString('base64')

  await switchTab(cdp, '加密')
  await cdp.eval(`
    const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '清空' || el.textContent.trim() === 'Clear');
    if (btn) btn.click();
    return true;
  `)
  await sleep(200)
  await uploadFile(cdp, keyFileFixturePath, 'input[type=file]')
  await waitFor(cdp, `document.body.innerText.includes('keyfile-case.dat')`, 20000, '文件入队')
  await cdp.eval(`window.__xqDownloads = []; return true;`)
  await clickByText(cdp, ['开始加密'])
  await waitFor(cdp, `document.querySelector('#xq-key-title') !== null`, 120000, '密钥弹窗')

  await cdp.eval(`
    const labels = Array.from(document.querySelectorAll('label'));
    const protect = labels.find((el) => el.textContent.includes('用密码保护密钥文件'));
    const box = protect.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    await new Promise((r) => setTimeout(r, 250));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const pwds = Array.from(document.querySelectorAll('input[type=password]'));
    for (const p of pwds) {
      setter.call(p, ${JSON.stringify(KEYFILE_PASSWORD)});
      p.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 250));
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('下载 .XUQIANKEY')).click();
    return true;
  `)
  await sleep(800)
  const protectedKeyName = await cdp.eval(`return window.__xqDownloads.find((n) => n.endsWith('.XUQIANKEY')) ?? null;`)
  console.log(`   [D] 密钥文件下载名 = ${String(protectedKeyName)}，下载目录内容 = ${JSON.stringify(listDir(downloadDir))}`)
  const protectedKeyPath = protectedKeyName ? join(downloadDir, protectedKeyName) : ''
  for (let i = 0; i < 60 && protectedKeyPath && !existsSync(protectedKeyPath); i++) await sleep(200)
  let protectedOk = false
  if (protectedKeyPath && existsSync(protectedKeyPath)) {
    try {
      protectedOk = JSON.parse(readFileSync(protectedKeyPath, 'utf8')).protected === true
    } catch (error) {
      console.log(`   [D] 读取密钥文件失败: ${error.message}`)
    }
  }
  check('生成密码保护的 .XUQIANKEY', protectedOk, protectedKeyName ?? 'null')

  await clickByText(cdp, ['我已复制，关闭并销毁'])
  await sleep(400)
  if (await cdp.eval(`return /尚未复制或下载密钥/.test(document.body.innerText)`)) await clickByText(cdp, ['确认关闭并销毁'])
  await waitFor(cdp, `document.querySelector('#xq-key-title') === null`, 20000, '密钥弹窗关闭')

  const keyfileCipherName = await cdp.eval(`
    window.__xqDownloads = [];
    const btn = Array.from(document.querySelectorAll('button')).find((el) => /下载.*\\.XUQIAN$/.test(el.textContent.trim()));
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return window.__xqDownloads.find((n) => n.endsWith('.XUQIAN')) ?? null;
  `)
  const keyfileCipherPath = join(downloadDir, keyfileCipherName ?? '')
  for (let i = 0; i < 60 && !existsSync(keyfileCipherPath); i++) await sleep(200)

  // 刷新页面清空全部内存状态，模拟"换设备后再解密"
  await cdp.send('Page.reload', { ignoreCache: true })
  await sleep(2500)
  await cdp.send('Runtime.enable').catch(() => {})
  await waitFor(cdp, `document.querySelector('#root')?.children.length > 0`, 40000, '刷新后挂载')
  await cdp.eval(PATCH_DOWNLOADS)

  await switchTab(cdp, '解密')
  await uploadFile(cdp, keyfileCipherPath, 'input[type=file]')
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(keyfileCipherName)})`, 20000, '密文入队')
  await clickByText(cdp, ['上传 .XUQIANKEY'])
  await sleep(400)
  await uploadFile(cdp, protectedKeyPath, '[data-testid="keyfile-input"]')
  // 关键回归点：不等"已载入"提示出现、不等重渲染就立刻填密码并点解密（最坏时序）
  await cdp.eval(`
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const pwd = document.querySelector('[data-testid="keyfile-password"]');
    setter.call(pwd, ${JSON.stringify(KEYFILE_PASSWORD)});
    pwd.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await clickByText(cdp, ['开始解密'])
  await waitFor(cdp, `/解密完成|Decryption finished/.test(document.body.innerText)`, 120000, '用密钥文件解密（最坏时序）')
  check('上传 .XUQIANKEY 后立刻解密也能成功（时序回归）', true)

  const keyfileRestore = await cdp.eval(`
    window.__xqDownloads = [];
    const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('下载还原文件'));
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return window.__xqDownloads[0] ?? null;
  `)
  const keyfileRestorePath = keyfileRestore ? join(downloadDir, keyfileRestore) : ''
  console.log(`   [D] 还原下载名 = ${String(keyfileRestore)} | 下载目录 = ${JSON.stringify(listDir(downloadDir))}`)
  for (let i = 0; i < 60 && keyfileRestorePath && !existsSync(keyfileRestorePath); i++) await sleep(200)
  if (keyfileRestorePath && existsSync(keyfileRestorePath)) {
    check('密钥文件解密后字节一致', readFileSync(keyfileRestorePath).toString('base64') === keyFileFixtureSha, keyfileRestore ?? '')
    check('密钥文件解密还原原文件名', keyfileRestore === 'keyfile-case.dat', keyfileRestore ?? 'null')
  } else {
    check('密钥文件解密后文件已下载', false, keyfileRestore ?? 'null')
  }

  // 错误密码 → 统一提示
  await switchTab(cdp, '解密')
  await uploadFile(cdp, keyfileCipherPath, 'input[type=file]')
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(keyfileCipherName)})`, 20000, '密文再次入队')
  await clickByText(cdp, ['上传 .XUQIANKEY'])
  await sleep(400)
  await uploadFile(cdp, protectedKeyPath, '[data-testid="keyfile-input"]')
  await sleep(500)
  await cdp.eval(`
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const pwd = document.querySelector('[data-testid="keyfile-password"]');
    setter.call(pwd, 'definitely-wrong-password');
    pwd.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `)
  await sleep(200)
  await clickByText(cdp, ['开始解密'])
  await waitFor(
    cdp,
    `/密码错误或密钥文件损坏|Wrong password or corrupted key file/.test(document.body.innerText)`,
    90000,
    '错误密码提示',
  )
  check('密钥文件密码错误提示正确', true)

  // ------------------------------------------------------------------
  // F. 密钥自检（只读头部 + 首块即可判定密钥对错）
  // ------------------------------------------------------------------
  {
    await switchTab(cdp, '解密')
    await uploadFile(cdp, keyfileCipherPath, 'input[type=file]')
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(keyfileCipherName)})`, 20000, '密文入队（自检用）')

    const selfCheckButtonPresent = await cdp.eval(
      `return document.querySelector('[data-testid="decrypt-key-check"]') !== null`,
    )
    check('解密面板存在「自检密钥」按钮', selfCheckButtonPresent)

    // F1) 用密码保护的 .XUQIANKEY 自检：上传后**立刻**点自检，覆盖最坏时序
    await clickByText(cdp, ['上传 .XUQIANKEY'])
    await sleep(400)
    await uploadFile(cdp, protectedKeyPath, '[data-testid="keyfile-input"]')
    await cdp.eval(`
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const pwd = document.querySelector('[data-testid="keyfile-password"]');
      setter.call(pwd, ${JSON.stringify(KEYFILE_PASSWORD)});
      pwd.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-testid="decrypt-key-check"]').click();
      return true;
    `)
    // 「立刻点」是这一步的考点（最坏时序），保留不动；
    // 但如果恰好点在了 React 还没拿到密钥的空档，自检会静默 no-op、整轮就会以超时中止。
    // 所以在超时后**补点一次**再等：考点不变，抖动不再让整轮失败。
    let selfCheckAppeared = true
    try {
      await waitFor(cdp, `document.querySelector('[data-testid="decrypt-check-result"]') !== null`, 20000, '自检结论出现（首次）')
    } catch {
      selfCheckAppeared = false
    }
    if (!selfCheckAppeared) {
      await cdp.eval(`document.querySelector('[data-testid="decrypt-key-check"]').click(); return true;`)
      await waitFor(cdp, `document.querySelector('[data-testid="decrypt-check-result"]') !== null`, 60000, '自检结论出现（补点后）')
    }
    const goodCheckText = await cdp.eval(`
      const box = document.querySelector('[data-testid="decrypt-check-result"]');
      return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '';
    `)
    check('自检结论：正确密钥判定为匹配（上传密钥文件后立刻自检）', /密钥匹配/.test(goodCheckText), goodCheckText)
    check('自检结果带指纹（便于与密钥文件核对）', /[0-9A-F]{16}/.test(goodCheckText), goodCheckText)
    check('时序回归：首次「立刻点自检」未落空（落空时应记录而不是静默）', selfCheckAppeared, selfCheckAppeared ? '' : '首次点击落空，已补点成功')

    // F2) 错误密钥 → 不匹配
    await clickByText(cdp, ['输入 128 位密钥'])
    await sleep(300)
    await cdp.eval(`
      const node = document.querySelector('[data-testid="decrypt-key"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(node, 'ffffffffffffffffffffffffffffffff');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-testid="decrypt-key-check"]').click();
      return true;
    `)
    await waitFor(cdp, `document.querySelector('[data-testid="decrypt-check-result"]') !== null`, 90000, '错误密钥自检结论')
    const badCheckText = await cdp.eval(`
      const box = document.querySelector('[data-testid="decrypt-check-result"]');
      return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '';
    `)
    check('自检结论：错误密钥判定为不匹配', /密钥错误或文件损坏|Wrong key/.test(badCheckText) && !/密钥匹配/.test(badCheckText), badCheckText)
    check(
      '自检不匹配时不会显示"已通过首块认证"（避免自相矛盾）',
      !/已通过首块认证|first block authenticated/i.test(badCheckText),
      badCheckText,
    )
  }

  // ------------------------------------------------------------------
  // G. 加密声明（banner）：前置到密文内容开头 → 头部可读 → 解密精确剥离
  // ------------------------------------------------------------------
  {
    await switchTab(cdp, '加密')
    const noticeUi = await cdp.eval(`
      const field = document.querySelector('[data-testid="encrypt-notice"]');
      if (!field) return null;
      return { placeholder: field.placeholder, value: field.value, maxLength: field.maxLength };
    `)
    check('加密面板存在「加密声明」输入框', noticeUi !== null, noticeUi ? '' : '未找到 encrypt-notice')
    check(
      '未填写时以默认声明作为占位提示（说明声明不可省略）',
      Boolean(noticeUi && /XUQIAN/.test(noticeUi.placeholder) && /解密失败/.test(noticeUi.placeholder)),
      noticeUi?.placeholder?.slice(0, 60) ?? '',
    )

    // 已由前面流程产出的密文：验证「明文声明在文件最开头，且不需要密钥」
    const preamble = readPreambleOf(keyfileCipherPath)
    check(
      '明文声明位于文件最开头（偏移 6 的标记 = 2）',
      preamble !== null && /XUQIAN/.test(preamble.noticeText),
      preamble ? `${preamble.noticeBytes} 字节` : '未找到前导区',
    )
    const header = readHeaderJson(keyfileCipherPath)
    check(
      '加密头部记录声明的长度（nl）与 SHA-256（nh）',
      typeof header.meta.nl === 'number' && header.meta.nl > 0 && /^[0-9A-F]{64}$/.test(header.meta.nh ?? ''),
      `nl=${header.meta.nl} nh=${String(header.meta.nh).slice(0, 12)}…`,
    )
    check(
      '头部记录的长度与明文声明的实际字节数一致',
      preamble !== null && header.meta.nl === Buffer.byteLength(preamble.noticeText, 'utf8'),
      `${header.meta.nl} vs ${preamble ? Buffer.byteLength(preamble.noticeText, 'utf8') : '?'}`,
    )

    // 解密该密文：载入后（**还没给密钥**）界面就该展示这段明文声明
    await switchTab(cdp, '解密')
    await uploadFile(cdp, keyfileCipherPath, 'input[type=file]')
    await waitFor(cdp, `document.body.innerText.includes('keyfile-case.dat.XUQIAN')`, 20000, '密文入队')
    await waitFor(cdp, `document.querySelector('[data-testid="decrypt-preamble-notice"]') !== null`, 20000, '明文声明面板')
    const noticeShown = await cdp.eval(`
      const box = document.querySelector('[data-testid="decrypt-preamble-notice"]');
      return box ? box.innerText.replace(/\\s+/g, ' ').trim() : '';
    `)
    check('未提供密钥即可在界面读到明文声明', /XUQIAN 认证加密文件/.test(noticeShown), noticeShown.slice(0, 60))
    await clickByText(cdp, ['上传 .XUQIANKEY'])
    await sleep(400)
    await uploadFile(cdp, protectedKeyPath, '[data-testid="keyfile-input"]')
    await sleep(500)
    await cdp.eval(`
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const pwd = document.querySelector('[data-testid="keyfile-password"]');
      setter.call(pwd, ${JSON.stringify(KEYFILE_PASSWORD)});
      pwd.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `)
    await sleep(200)
    await clickByText(cdp, ['开始解密'])
    await waitFor(cdp, `/解密完成/.test(document.body.innerText)`, 120000, '带明文声明的密文解密完成')
    check('带明文声明的密文可正常解密', true)
  }

  // ------------------------------------------------------------------
  // E. 主题与移动端
  // ------------------------------------------------------------------
  const themeBefore = await cdp.eval(`return document.documentElement.dataset.theme`)
  await cdp.eval(`
    const btn = Array.from(document.querySelectorAll('button')).find((el) => /亮色|暗色|Light|Dark/.test(el.textContent));
    if (btn) btn.click();
    return true;
  `)
  await sleep(250)
  const themeAfter = await cdp.eval(`return document.documentElement.dataset.theme`)
  check('亮色/暗色主题可切换', themeAfter !== themeBefore, `${themeBefore} → ${themeAfter}`)

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(300)
  const mobile = await cdp.eval(
    `return { overflow: document.documentElement.scrollWidth <= window.innerWidth + 2, tabs: document.querySelectorAll('[role=tab]').length, width: window.innerWidth }`,
  )
  check('移动端视口无横向溢出（验收 10）', mobile.overflow === true, JSON.stringify(mobile))
  await cdp.send('Emulation.clearDeviceMetricsOverride')

  // ------------------------------------------------------------------
  // 无障碍审计：开始页 + 简单路线四个页签 + 自研路线五个页面
  // ------------------------------------------------------------------
  await clickByText(cdp, ['切换加密方式', 'Switch route'])
  await sleep(450)
  await auditA11y(cdp, '开始页')

  for (const tab of ['加密', '解密', '文本', '工具']) {
    await switchTab(cdp, tab)
    await sleep(300)
    await auditA11y(cdp, `简单路线 · ${tab}`)
  }

  await clickByText(cdp, ['切换加密方式', 'Switch route'])
  await sleep(450)
  await cdp.eval(`
    const btn = document.querySelector('[data-testid="start-self"] button');
    if (!btn) throw new Error('找不到自研加密入口');
    btn.click();
    return true;
  `)
  await sleep(450)
  await auditA11y(cdp, '自研路线 · 主页')
  for (const key of ['file', 'decrypt', 'watermark', 'ai', 'status']) {
    await cdp.eval(`
      const open = document.querySelector('[data-testid="sc-open-${key}"]');
      if (open) { open.click(); return true; }
      const nav = document.querySelector('[data-testid="sc-nav-${key}"]');
      if (!nav) throw new Error('找不到入口 ${key}');
      nav.click();
      return true;
    `)
    await sleep(350)
    await auditA11y(cdp, `自研路线 · ${key}`)
  }
} catch (error) {
  check('冒烟流程执行', false, error instanceof Error ? error.message : String(error))
  exitCode = 1
} finally {
  cdp?.close()
  browser.kill()
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(` - ${item.name}${item.detail ? ` (${item.detail})` : ''}`)
  exitCode = 1
}
writeFileSync('smoke-report.json', JSON.stringify({ base: BASE, ts: new Date().toISOString(), results }, null, 2))
process.exit(exitCode)
