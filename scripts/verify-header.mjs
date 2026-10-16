/**
 * 文件头验证：在真实浏览器里加密「多层 + gzip」文件，落盘后读取 .XUQIAN 文件头，
 * 确认头部真的记录了算法顺序、层数、压缩标志、原始文件名与哈希 —— 即证明 UI 的
 * 算法层栈确实生效，而不是退化成单层。
 *
 * 用法：node scripts/verify-header.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5188/'
const PORT = 9335
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
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

  // 切到加密 Tab
  await evalJs(`
    Array.from(document.querySelectorAll('[role=tab]')).find((el) => el.textContent.includes('加密')).click();
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
  const bytes = readFileSync(encPath)
  const magic = bytes.subarray(0, 6).toString('latin1')
  const version = bytes[6]
  const flags = bytes[7]
  const chunkSize = bytes.readUInt32BE(8)
  const chunkCount = bytes.readUInt32BE(12)
  const layerCount = bytes[16]
  const jsonLen = bytes.readUInt32BE(17)
  const headerJson = JSON.parse(bytes.subarray(21, 21 + jsonLen).toString('utf8'))

  console.log('\n=== .XUQIAN 文件头 ===')
  console.log('magic          :', magic)
  console.log('version        :', version)
  console.log('flags          :', flags, flags & 2 ? '(gzip=on)' : '(gzip=off)')
  console.log('chunkSize      :', chunkSize)
  console.log('chunkCount     :', chunkCount)
  console.log('layerCount     :', layerCount)
  console.log('headerJsonLen  :', jsonLen)
  console.log('算法顺序        :', headerJson.layers.map((l) => l.a).join(' -> '))
  console.log('原始文件名      :', headerJson.meta.n)
  console.log('原始大小        :', headerJson.meta.s, '(+os=' + headerJson.meta.os + ')')
  console.log('SHA-256        :', headerJson.meta.h)
  console.log('header CRC     :', headerJson.crc)
  console.log('文件总大小      :', bytes.length)

  const problems = []
  if (magic !== 'XUQIAN') problems.push('魔数不正确')
  if (version !== 1) problems.push('版本号不正确')
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
  if (headerJson.meta.n !== fixtureName) problems.push(`原始文件名未正确记录（${headerJson.meta.n}）`)
  if (headerJson.meta.os !== fixtureBytes.length) problems.push(`原始大小未正确记录（${headerJson.meta.os}）`)
  if (!/^[0-9A-F]{64}$/.test(headerJson.meta.h)) problems.push('缺少 SHA-256 哈希')
  if (typeof keyHex !== 'string' || keyHex.length !== 32) problems.push('密钥弹窗未展示 32 位 Hex')
  // gzip 生效的证据：容器内明文（meta.s）应明显小于原始大小（meta.os）
  if (headerJson.meta.s >= headerJson.meta.os)
    problems.push(`gzip 未生效（压缩后 ${headerJson.meta.s} >= 原始 ${headerJson.meta.os}）`)
  const headerText = bytes
    .subarray(0, 21 + jsonLen)
    .toString('latin1')
    .toLowerCase()
  if (keyHex && headerText.includes(keyHex)) problems.push('文件头泄露了主密钥！')

  if (problems.length > 0) {
    console.log('\n❌ 文件头验证失败：')
    for (const p of problems) console.log(' -', p)
    process.exitCode = 1
  } else {
    console.log('\n✅ 文件头验证全部通过（算法层栈、层数、gzip、元数据、哈希均正确写入）')
  }
} catch (error) {
  console.error('验证脚本出错:', error.message)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {}
  browser.kill()
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {}
}
