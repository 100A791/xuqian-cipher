/**
 * 文件头验证：在真实浏览器里加密「多层 + gzip」文件，落盘后读取 .XUQIAN 文件头，
 * 确认头部真的记录了算法顺序、层数、压缩标志、原始文件名与哈希 —— 即证明 UI 的
 * 算法层栈确实生效，而不是退化成单层。
 *
 * 用法：node scripts/verify-header.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertPortFree, findBrowser, waitPortReleased } from './lib/devtools.mjs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5188/'
// 端口可用 XQ_HEADER_PORT 覆盖。端口分工本身**不解决**「等待超时: 页面加载完成」；
// 根因已定位为调试端口被 IDE 的预览浏览器占用（详见 scripts/lib/devtools.mjs 顶部注释），
// 现在由启动前的 assertPortFree() 直接拦下，而不是连到别人的 about:blank 上等 60 秒。
const PORT = Number(process.env.XQ_HEADER_PORT ?? 9413)
const BROWSER = findBrowser() ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const workDir = mkdtempSync(join(tmpdir(), 'xq-hdr-'))
const profileDir = join(workDir, 'profile')
const downloadDir = join(workDir, 'dl')
const fixtureDir = join(workDir, 'fixtures')
mkdirSync(profileDir, { recursive: true })
mkdirSync(downloadDir, { recursive: true })
mkdirSync(fixtureDir, { recursive: true })

const LAYERS = ['AES-256-GCM', 'CHACHA20-POLY1305', 'SM4-GCM']
const fixtureName = 'report-报告.pdf'
const fixtureBytes = Buffer.alloc(3000)
for (let i = 0; i < fixtureBytes.length; i++) fixtureBytes[i] = (i * 37) & 0xff
const fixturePath = join(fixtureDir, fixtureName)
writeFileSync(fixturePath, fixtureBytes)

// 端口被占用时直接失败，不要连到别人的浏览器上
try {
  await assertPortFree(PORT, 'XQ_HEADER_PORT')
} catch (error) {
  console.error(`[verify-header] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const browser = spawn(
  BROWSER,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, '--no-first-run', BASE],
  { stdio: 'ignore' },
)

let ws
let id = 0
const pending = new Map()
function send(method, params = {}) {
  const mid = ++id
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => pending.has(mid) && (pending.delete(mid), reject(new Error(`timeout ${method}`))), 120000)
  })
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(expr, timeoutMs = 60000, label = '') {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await evalJs(`return Boolean(${expr})`)) return
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break
    } catch {}
    await sleep(250)
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  await send('Runtime.enable')
  await send('DOM.enable')
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })
  await waitFor(`document.querySelector('#root')?.children.length > 0`, 30000, '挂载')

  await evalJs(`
    if (!window.__dl) {
      window.__dl = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) { window.__dl.push(this.download); try { orig.apply(this, arguments); } catch (e) {} return; }
        return orig.apply(this, arguments);
      };
    }
    return true;
  `)

  // 开始页（加密路线二选一）会挡住主界面：若它在，就先选「简单加密」。
  //
  // 2026-10-17 复验补记：本脚本此前**从未处理开始页**，直接去找 [role=tab]，
  // 而开始页上根本没有任何 tab → `.find(...)` 返回 undefined → `.click()` 抛
  // `TypeError: Cannot read properties of undefined (reading 'click')`。
  // 它明明挂在 `test:all` 里，却一直没被人跑过 —— 与冒烟那条"过期断言"是同一类问题：
  // **没进自动化流程的检查等于不存在**（见 CHANGELOG「修复」一节）。
  // 做法与 scripts/smoke.mjs 的 enterSimpleMode() 保持一致（同一组 data-testid）。
  await evalJs(`
    const start = document.querySelector('[data-testid="start-screen"]');
    if (start) {
      const card = document.querySelector('[data-testid="start-simple"]');
      const btn = card ? card.querySelector('button') : null;
      if (!btn) throw new Error('开始页存在但找不到「简单加密」的进入按钮');
      btn.click();
    }
    return true;
  `)
  await sleep(500)

  // 切到加密 Tab（此处也必须判空：找不到就给出可读错误，而不是 undefined.click）
  await evalJs(`
    const tab = Array.from(document.querySelectorAll('[role=tab]')).find((el) => el.textContent.includes('加密'));
    if (!tab) throw new Error('找不到「加密」标签页');
    tab.click();
    return true;
  `)
  await sleep(300)

  // 配置 3 层算法 + gzip
  const applied = await evalJs(`
    const algoSelects = () => Array.from(document.querySelectorAll('select')).filter((el) => /GCM|CHACHA/.test(el.options[0]?.textContent ?? ''));
    const wanted = ${JSON.stringify(LAYERS)};
    for (let guard = 0; guard < 12; guard++) {
      const current = algoSelects().length;
      if (current === wanted.length) break;
      if (current < wanted.length) {
        Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('加密层数')).click();
      } else {
        const removes = Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === '✕');
        removes[removes.length - 1].click();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const setSelect = (el, label) => {
      const option = Array.from(el.options).find((o) => o.value === label);
      if (!option) throw new Error('no option ' + label);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, option.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const selects = algoSelects();
    for (let i = 0; i < wanted.length; i++) setSelect(selects[i], wanted[i]);
    await new Promise((r) => setTimeout(r, 200));
    const labels = Array.from(document.querySelectorAll('label'));
    const gzipLabel = labels.find((el) => el.textContent.includes('gzip 压缩'));
    const box = gzipLabel.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    await new Promise((r) => setTimeout(r, 200));
    return {
      values: algoSelects().map((el) => el.value),
      gzip: box.checked,
    };
  `)
  console.log('下拉框实际值:', JSON.stringify(applied))

  // 上传并加密
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await send('DOM.setFileInputFiles', { nodeId, files: [fixturePath] })
  await waitFor(`document.body.innerText.includes(${JSON.stringify(fixtureName)})`, 20000, '文件入队')

  await evalJs(`
    window.__dl = [];
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('开始加密')).click();
    return true;
  `)
  await waitFor(`document.querySelector('#xq-key-title') !== null`, 120000, '密钥弹窗')

  const keyHex = await evalJs(`
    const areas = Array.from(document.querySelectorAll('textarea'));
    return areas.map((el) => el.value.trim()).find((v) => /^[0-9a-f]{32}$/i.test(v)) ?? null;
  `)

  await evalJs(`
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('下载 .XUQIANKEY')).click();
    await new Promise((r) => setTimeout(r, 300));
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('我已复制，关闭并销毁')).click();
    await new Promise((r) => setTimeout(r, 300));
    const confirm = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('确认关闭并销毁'));
    if (confirm) confirm.click();
    return true;
  `)
  await waitFor(`document.querySelector('#xq-key-title') === null`, 20000, '弹窗关闭')

  const encName = await evalJs(`
    window.__dl = [];
    Array.from(document.querySelectorAll('button')).find((el) => /下载.*\\.XUQIAN$/.test(el.textContent.trim())).click();
    await new Promise((r) => setTimeout(r, 400));
    return window.__dl.find((n) => n.endsWith('.XUQIAN')) ?? null;
  `)
  const encPath = join(downloadDir, encName)
  for (let i = 0; i < 80 && !existsSync(encPath); i++) await sleep(200)

  // 解析文件头
  //
  // 2026-10-17 复验补记（第二处失效）：`.XUQIAN` 文件 = [明文声明前导区] ‖ [加密容器]
  // （`docs/FORMAT.md` §2.3.1）。这段代码原先把**文件起点当成容器起点**，于是：
  //   - `version`（offset 6）读到的是前导区标记 0x02；
  //   - `headerLen`（offset 17）落进了声明正文中间 → 得到一个荒谬的长度；
  //   - 最终 `JSON.parse` 从声明正文的**第二个字节**开始切，报
  //     `Unexpected token '证', "证加密文件 ｜ 由 "…`（声明以"认证加密文件"开头）。
  // 现在先解前导区、算出容器起点，再按容器内的相对偏移解析。
  const bytes = readFileSync(encPath)
  const fileMagic = bytes.subarray(0, 6).toString('latin1')
  const declMarker = bytes[6]
  let declLen = 0
  let declaration = null
  if (declMarker === 2) {
    declLen = bytes.readUInt32BE(7)
    declaration = bytes.subarray(11, 11 + declLen).toString('utf8')
  }
  const containerStart = declMarker === 2 ? 11 + declLen : 0
  const container = bytes.subarray(containerStart)

  const magic = container.subarray(0, 6).toString('latin1')
  const version = container[6]
  const flags = container[7]
  const chunkSize = container.readUInt32BE(8)
  const chunkCount = container.readUInt32BE(12)
  const layerCount = container[16]
  const jsonLen = container.readUInt32BE(17)
  const headerJson = JSON.parse(container.subarray(21, 21 + jsonLen).toString('utf8'))

  console.log('\n=== .XUQIAN 文件头 ===')
  console.log('文件魔数        :', fileMagic)
  console.log('声明前导区      :', declMarker === 2 ? `存在（${declLen} 字节）` : '不存在（旧格式）')
  console.log('容器起点        :', containerStart)
  console.log('magic          :', magic)
  console.log('version        :', version)
  console.log('flags          :', flags, flags & 2 ? '(gzip=on)' : '(gzip=off)')
  console.log('chunkSize      :', chunkSize)
  console.log('chunkCount     :', chunkCount)
  console.log('layerCount     :', layerCount)
  console.log('headerJsonLen  :', jsonLen)
  console.log('算法顺序        :', headerJson.layers.map((l) => l.a).join(' -> '))
  console.log('元数据加密      :', flags & 4 ? '已开启（标识性字段收进 meta.x）' : '未开启（明文头部）')
  console.log('原始文件名      :', headerJson.meta.n ?? '(已加密，明文头部不可见)')
  console.log('原始大小        :', headerJson.meta.s, '(+os=' + (headerJson.meta.os ?? '已加密') + ')')
  console.log(
    'meta.x 密文块   :',
    typeof headerJson.meta.x === 'string' ? `存在（${headerJson.meta.x.length} 字符 base64）` : '无',
  )
  console.log('SHA-256        :', headerJson.meta.h)
  console.log('header CRC     :', headerJson.crc)
  console.log('文件总大小      :', bytes.length)

  const problems = []
  if (magic !== 'XUQIAN' || fileMagic !== 'XUQIAN') problems.push('魔数不正确')
  if (version !== 1) problems.push('版本号不正确')
  // 声明是被密码学强制的（FORMAT.md §2.3.1「不可去除」）：本工具产出的文件必须带前导区。
  if (declMarker !== 2) problems.push('缺少明文声明前导区（偏移 6 的标记应为 2）')
  if (declaration !== null) {
    if (Buffer.byteLength(declaration, 'utf8') !== headerJson.meta.nl) {
      problems.push(`声明长度与头部 nl 不一致（${Buffer.byteLength(declaration, 'utf8')} vs ${headerJson.meta.nl}）`)
    }
    const declHash = createHash('sha256').update(Buffer.from(declaration, 'utf8')).digest('hex').toUpperCase()
    if (declHash !== headerJson.meta.nh)
      problems.push(`声明哈希与头部 nh 不一致（${declHash} vs ${headerJson.meta.nh}）`)
  }
  if ((flags & 2) === 0) problems.push('gzip 标志位未写入')
  if (layerCount !== LAYERS.length) problems.push(`层数应为 ${LAYERS.length}，实际 ${layerCount}`)
  // UI 的层列表是「自上而下显示、自下而上执行」，因此文件头里的加密顺序等于 UI 数组的逆序
  const expectedOrder = [...LAYERS].reverse()
  const recorded = headerJson.layers.map((l) => l.a)
  if (recorded.join(',') !== expectedOrder.join(',')) {
    problems.push(`加密顺序应为 ${expectedOrder.join(',')}（UI 逆序），实际 ${recorded.join(',')}`)
  }
  if ([...recorded].sort().join(',') !== [...LAYERS].sort().join(',')) {
    problems.push('算法集合与所选不一致')
  }
  if (headerJson.meta.n !== undefined && headerJson.meta.n !== fixtureName) {
    problems.push(`原始文件名未正确记录（${headerJson.meta.n}）`)
  }
  if (headerJson.meta.os !== undefined && headerJson.meta.os !== fixtureBytes.length) {
    problems.push(`原始大小未正确记录（${headerJson.meta.os}）`)
  }

  // 元数据加密（`docs/FORMAT.md` §2.4，简单路线**默认开启**）。
  //
  // 2026-10-17 复验补记（第三处失效）：上面两条原本是**无条件**断言的，而开启元数据加密后
  // `n`/`m`/`os`/`c`/`as` 会被移出明文头部、收进 `meta.x` 密文块 —— 于是脚本报
  // 「原始文件名未正确记录（undefined）」。那不是回归，恰恰是**隐私功能在生效**。
  // 现在按 flags 位分流，并且在加密时改断言「这些字段必须**不在**明文头部里」——
  // 这是比断言字段值更强的性质，也才是这个功能真正的验收点。
  if ((flags & 4) !== 0) {
    if (typeof headerJson.meta.x !== 'string' || headerJson.meta.x.length === 0) {
      problems.push('元数据加密位（0x04）已置位，但缺少 meta.x 密文块')
    }
    const sealed = ['n', 'm', 'os', 'c', 'as'].filter((k) => k in headerJson.meta)
    if (sealed.length > 0) problems.push(`元数据加密已开启，但明文头部仍含：meta.${sealed.join(', meta.')}`)
    const plainHeader = bytes.subarray(0, containerStart + 21 + jsonLen).toString('utf8')
    if (plainHeader.includes(fixtureName)) problems.push('明文头部/声明区出现了原始文件名（元数据加密未真正生效）')
  }
  if (!/^[0-9A-F]{64}$/.test(headerJson.meta.h)) problems.push('缺少 SHA-256 哈希')
  if (typeof keyHex !== 'string' || keyHex.length !== 32) problems.push('密钥弹窗未展示 32 位 Hex')
  // gzip 生效的证据：容器内明文（meta.s）应明显小于原始文件大小（fixtureBytes.length）
  if (headerJson.meta.s >= fixtureBytes.length) {
    problems.push(`gzip 未生效（压缩后 ${headerJson.meta.s} >= 原始 ${fixtureBytes.length}）`)
  }
  // 泄露检查要覆盖「声明前导区 + 容器头部」整段明文（声明本身就是明文，同样不能出现密钥）
  const headerText = bytes
    .subarray(0, containerStart + 21 + jsonLen)
    .toString('latin1')
    .toLowerCase()
  if (keyHex && headerText.includes(keyHex)) problems.push('文件头泄露了主密钥！')

  if (problems.length > 0) {
    console.log('\n❌ 文件头验证失败：')
    for (const p of problems) console.log(' -', p)
    process.exitCode = 1
  } else {
    console.log('\n✅ 文件头验证全部通过（明文声明前导区、算法层栈、层数、gzip、元数据、哈希均正确写入）')
  }
} catch (error) {
  console.error('验证脚本出错:', error.message)
  process.exitCode = 1
} finally {
  // 用 CDP 真正关掉浏览器，再等端口释放：只 kill 启动器会让浏览器本体留在后台，
  // 而下一行删 profile 会让下一次运行更容易撞上"陈旧实例"。
  try {
    ws?.send(JSON.stringify({ id: 99999, method: 'Browser.close' }))
  } catch {}
  try {
    ws?.close()
  } catch {}
  browser.kill()
  await waitPortReleased(PORT)
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {}
}
