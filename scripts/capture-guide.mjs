/**
 * 界面截图脚本：驱动真实浏览器把每个分区的关键状态截图，输出到 docs/images/。
 * 用途：为 docs/GUIDE.md（带图操作手册）生成配图。
 *
 * 用法：node scripts/capture-guide.mjs [baseUrl]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5188/'
const PORT = 9337
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const outDir = join(process.cwd(), 'docs', 'images')
mkdirSync(outDir, { recursive: true })

const workDir = mkdtempSync(join(tmpdir(), 'xq-shot-'))
const profileDir = join(workDir, 'profile')
const dlDir = join(workDir, 'dl')
const fixDir = join(workDir, 'fixtures')
for (const d of [profileDir, dlDir, fixDir]) mkdirSync(d, { recursive: true })

// 造几个像样的示例文件，让截图里的文件名有辨识度
const samples = [
  { name: '出差报销单.pdf', size: 182_400 },
  { name: '合同扫描件.jpg', size: 1_248_000 },
  { name: 'readme.txt', size: 3_200 },
]
for (const s of samples) {
  const buf = Buffer.alloc(Math.min(s.size, 4096))
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 17) & 0xff
  writeFileSync(join(fixDir, s.name), buf)
}

const browser = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--window-size=1280,900',
    BASE,
  ],
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
async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(expr, ms = 60000, label = '') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await ev(`return Boolean(${expr})`)) return
    } catch {
      /* context 未就绪 */
    }
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}
async function upload(filePath, selector, nth = 0) {
  const { root } = await send('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector })
  const nodeId = nodeIds[nth]
  if (!nodeId) throw new Error(`找不到 input: ${selector}[${nth}]`)
  await send('DOM.setFileInputFiles', { nodeId, files: [filePath] })
}
async function clickText(texts, exact = false) {
  return ev(`
    const wanted = ${JSON.stringify(texts)};
    const nodes = Array.from(document.querySelectorAll('button'));
    const found = nodes.find((el) => wanted.some((w) => (${exact} ? el.textContent.trim() === w : el.textContent.includes(w))));
    if (!found) throw new Error('找不到按钮: ' + wanted.join('/'));
    found.click();
    return true;
  `)
}
async function setText(selector, value) {
  await ev(`
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到 ' + ${JSON.stringify(selector)});
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `)
}
async function switchTab(needle) {
  await ev(`
    const tabs = Array.from(document.querySelectorAll('[role=tab]'));
    const tab = tabs.find((el) => el.textContent.includes(${JSON.stringify(needle)}));
    if (!tab) throw new Error('找不到标签页: ' + ${JSON.stringify(needle)});
    tab.click();
    return true;
  `)
  await sleep(350)
}

const shots = []
async function shot(name, note) {
  // 统一回到顶部并停掉动画，保证每张截图取景一致
  await ev(`window.scrollTo(0, 0); document.documentElement.style.overflowY = 'hidden'; return true;`).catch(() => {})
  await sleep(200)
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(outDir, `${name}.png`)
  writeFileSync(file, Buffer.from(result.data, 'base64'))
  shots.push({ name, note, file: `docs/images/${name}.png`, bytes: readFileSync(file).length })
  console.log(`  📸 ${name}.png — ${note}`)
}

const PATCH = `
  document.documentElement.dataset.test = '1';
  if (!window.__dl) {
    window.__dl = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__dl.push(this.download); try { orig.apply(this, arguments); } catch (e) {} return; }
      return orig.apply(this, arguments);
    };
  }
  return true;
`

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break
    } catch {
      // 浏览器还没就绪：继续轮询（下一轮再取 /json/version）
    }
    await sleep(250)
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result)
    }
  })
  await send('Runtime.enable')
  await send('DOM.enable')
  await send('Page.enable')
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir })
  await waitFor(`document.querySelector('#root')?.children.length > 0`, 30000, '挂载')
  await ev(PATCH)
  // 滚动条不干扰版面
  await ev(`document.documentElement.style.overflowY = 'hidden'; return true;`)

  console.log('开始截图…')

  // ---------- 01 首页 / 加密分区（空态） ----------
  await switchTab('加密')
  await shot('01-home-encrypt-empty', '首页与加密分区（空态）')

  // ---------- 02 加密分区：已选文件 + 多层算法 + 选项 ----------
  await upload(join(fixDir, '出差报销单.pdf'), 'input[type=file]')
  await sleep(400)
  await upload(join(fixDir, '合同扫描件.jpg'), 'input[type=file]')
  await sleep(400)
  await ev(`
    const algoSelects = () => Array.from(document.querySelectorAll('select')).filter((el) => /GCM|CHACHA/.test(el.options[0]?.textContent ?? ''));
    // 加到 3 层
    for (let g = 0; g < 6 && algoSelects().length < 3; g++) {
      Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('加密层数')).click();
      await new Promise((r) => setTimeout(r, 90));
    }
    const setSelect = (el, label) => {
      const option = Array.from(el.options).find((o) => o.value === label);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, option.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const list = algoSelects();
    const wanted = ['AES-256-GCM', 'CHACHA20-POLY1305', 'SM4-GCM'];
    for (let i = 0; i < wanted.length; i++) setSelect(list[i], wanted[i]);
    const gzipLabel = Array.from(document.querySelectorAll('label')).find((el) => el.textContent.includes('gzip 压缩'));
    const box = gzipLabel.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    return algoSelects().length;
  `)
  await setText('input[placeholder="—"]', '出差材料备份，请勿外传')
  await setText('input[type=datetime-local]', '2026-12-31T18:00')
  await sleep(400)
  await shot('02-encrypt-configured', '加密分区：已选文件、三层算法、gzip、备注与到期提醒')

  // ---------- 03 加密进行中（进度） ----------
  // 小文件加密太快，进度条一闪而过；这里单独加密一个较大的文件，确保能抓到"进行中"这一帧
  const bigPath = join(fixDir, '大文件示例.bin')
  writeFileSync(bigPath, Buffer.alloc(28 * 1024 * 1024, 0xa5))
  await ev(`window.scrollTo(0, 0); return true;`)
  await upload(bigPath, 'input[type=file]')
  await sleep(500)
  await shot('03a-encrypt-queued-bigfile', '加密分区：加入一个大文件后队列状态')
  await ev(`
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('开始加密')).click();
    return true;
  `)
  // 轮询直到出现"处理中"但尚未弹窗
  for (let i = 0; i < 200; i++) {
    const state = await ev(
      `return { busy: /处理中/.test(document.body.innerText), modal: document.querySelector('#xq-key-title') !== null }`,
    )
    if (state.modal) break
    if (state.busy) {
      await sleep(60)
      await shot('03-encrypt-progress', '加密进行中：进度条与按钮状态（大文件分块加密）')
      break
    }
    await sleep(50)
  }
  await waitFor(`document.querySelector('#xq-key-title') !== null`, 180000, '大文件加密完成弹窗')
  // 关闭这个大文件任务的弹窗，回到干净状态
  await ev(`
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('我已复制，关闭并销毁')).click();
    await new Promise((r) => setTimeout(r, 300));
    const confirm = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('确认关闭并销毁'));
    if (confirm) confirm.click();
    return true;
  `)
  await waitFor(`document.querySelector('#xq-key-title') === null`, 20000, '弹窗关闭')
  // 清空队列，回到前面的两个小文件配置
  await ev(`
    const q = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '清空');
    if (q) q.click();
    return true;
  `)
  await sleep(300)
  await upload(join(fixDir, '出差报销单.pdf'), 'input[type=file]')
  await sleep(300)
  await upload(join(fixDir, '合同扫描件.jpg'), 'input[type=file]')
  await sleep(400)
  await ev(`
    const algoSelects = () => Array.from(document.querySelectorAll('select')).filter((el) => /GCM|CHACHA/.test(el.options[0]?.textContent ?? ''));
    for (let g = 0; g < 6 && algoSelects().length < 3; g++) {
      Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('加密层数')).click();
      await new Promise((r) => setTimeout(r, 90));
    }
    const setSelect = (el, label) => {
      const option = Array.from(el.options).find((o) => o.value === label);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, option.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const list = algoSelects();
    for (const [i, label] of ['AES-256-GCM', 'CHACHA20-POLY1305', 'SM4-GCM'].entries()) setSelect(list[i], label);
    const gzipLabel = Array.from(document.querySelectorAll('label')).find((el) => el.textContent.includes('gzip 压缩'));
    const box = gzipLabel.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    return true;
  `)
  await setText('input[placeholder="—"]', '出差材料备份，请勿外传')
  await setText('input[type=datetime-local]', '2026-12-31T18:00')
  await sleep(300)
  await ev(`
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('开始加密')).click();
    return true;
  `)

  // ---------- 04 密钥一次性展示弹窗 ----------
  await waitFor(`document.querySelector('#xq-key-title') !== null`, 120000, '密钥弹窗')
  await sleep(600)
  await shot('04-key-modal', '密钥一次性展示弹窗：红色警告、Hex/Base64/指纹、二维码、分片')

  // 记录密钥，供后续解密演示
  const demoKey = await ev(`
    const areas = Array.from(document.querySelectorAll('textarea'));
    return areas.map((el) => el.value.trim()).find((v) => /^[0-9a-f]{32}$/i.test(v)) ?? null;
  `)
  console.log('   demo key =', demoKey)

  // ---------- 05 密钥弹窗：二次确认 ----------
  await clickText(['我已复制，关闭并销毁'])
  await sleep(500)
  await shot('05-key-confirm', '未复制/未下载就关闭时的二次确认')
  await clickText(['取消'], true)
  await sleep(300)

  // ---------- 06 密钥弹窗：密码保护 + 分片展开 ----------
  await ev(`
    const labels = Array.from(document.querySelectorAll('label'));
    const protect = labels.find((el) => el.textContent.includes('用密码保护密钥文件'));
    const box = protect.querySelector('input[type=checkbox]');
    if (!box.checked) box.click();
    await new Promise((r) => setTimeout(r, 250));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const pwds = Array.from(document.querySelectorAll('input[type=password]'));
    for (const p of pwds) { setter.call(p, 'Xq-2026-Demo!'); p.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 250));
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('生成分片')).click();
    await new Promise((r) => setTimeout(r, 400));
    return true;
  `)
  await sleep(500)
  await shot('06-key-password-shamir', '密钥弹窗：密码保护密钥文件 + Shamir 分片已生成')

  // 关闭弹窗（已下载标记为否，走二次确认）
  await ev(`
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('我已复制，关闭并销毁')).click();
    await new Promise((r) => setTimeout(r, 300));
    const confirm = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('确认关闭并销毁'));
    if (confirm) confirm.click();
    return true;
  `)
  await waitFor(`document.querySelector('#xq-key-title') === null`, 20000, '弹窗关闭')
  await sleep(300)

  // ---------- 07 加密完成：结果与下载 ----------
  await shot('07-encrypt-results', '加密完成：每个文件的下载按钮与 ZIP 打包')

  // 拿一个真实 .XUQIAN 文件用于解密分区截图
  const encName = await ev(`
    window.__dl = [];
    const btn = Array.from(document.querySelectorAll('button')).find((el) => /下载.*\\.XUQIAN$/.test(el.textContent.trim()));
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    return window.__dl.find((n) => n.endsWith('.XUQIAN')) ?? null;
  `)
  const encPath = join(dlDir, encName ?? '')
  for (let i = 0; i < 60 && !existsSync(encPath); i++) await sleep(200)
  console.log('   cipher =', encName, existsSync(encPath) ? `${readFileSync(encPath).length} B` : 'MISSING')

  // ---------- 08 解密分区：已载入密文 + 文件头信息 ----------
  await switchTab('解密')
  await setText('[data-testid=decrypt-key]', demoKey ?? '')
  await upload(encPath, 'input[type=file]')
  await sleep(700)
  await shot('08-decrypt-loaded', '解密分区：已载入 .XUQIAN、显示明文文件头、输入密钥')

  // ---------- 08a 密钥自检（正确密钥 → 匹配） ----------
  await ev(`
    const btn = document.querySelector('[data-testid="decrypt-key-check"]');
    if (!btn) throw new Error('找不到自检按钮');
    btn.click();
    return true;
  `)
  await waitFor(`document.querySelector('[data-testid="decrypt-check-result"]') !== null`, 90000, '自检结果')
  await sleep(300)
  await shot('08a-selfcheck-match', '密钥自检：只读文件头与首块即可判定密钥是否匹配')

  // ---------- 08b 密钥自检（错误密钥 → 不匹配） ----------
  await setText('[data-testid=decrypt-key]', 'ffffffffffffffffffffffffffffffff')
  await sleep(250)
  await ev(`
    document.querySelector('[data-testid="decrypt-key-check"]').click();
    return true;
  `)
  await waitFor(
    `/密钥错误或文件损坏/.test(document.querySelector('[data-testid="decrypt-check-result"]')?.innerText ?? '')`,
    90000,
    '自检不匹配结果',
  )
  await sleep(300)
  await shot('08b-selfcheck-mismatch', '密钥自检：错误密钥给出统一结论并显示当前密钥指纹')
  // 恢复正确密钥，后续用例继续
  await setText('[data-testid=decrypt-key]', demoKey ?? '')
  await sleep(250)

  // ---------- 09 解密完成 ----------
  await clickText(['开始解密'])
  await waitFor(`/解密完成/.test(document.body.innerText)`, 120000, '解密完成')
  await sleep(400)
  await shot('09-decrypt-done', '解密完成：SHA-256 校验一致、还原文件下载')

  // ---------- 10 解密失败（统一提示） ----------
  await switchTab('解密')
  await upload(encPath, 'input[type=file]')
  await sleep(500)
  await setText('[data-testid=decrypt-key]', 'ffffffffffffffffffffffffffffffff')
  await clickText(['开始解密'])
  await waitFor(`/密钥错误或文件损坏/.test(document.body.innerText)`, 90000, '错误密钥提示')
  await sleep(300)
  await shot('10-decrypt-failed', '错误密钥：统一提示「密钥错误或文件损坏」，不区分具体原因')

  // ---------- 11 用 .XUQIANKEY 解密（密码保护） ----------
  await switchTab('解密')
  await upload(encPath, 'input[type=file]')
  await sleep(500)
  await clickText(['上传 .XUQIANKEY'])
  await sleep(400)
  await shot('11-decrypt-keyfile-mode', '解密分区：切换到「上传 .XUQIANKEY 文件」模式')

  // ---------- 12 文本分区 ----------
  await switchTab('文本')
  let cipherText = ''
  await setText('[data-testid=text-plain]', '这是要加密的示例文本：账号 admin，口令 secret-2026。')
  await clickText(['加密文本'], true)
  await waitFor(`document.querySelector('#xq-key-title') !== null`, 60000, '文本加密弹窗')
  cipherText = await ev(`
    const el = document.querySelector('[data-testid=text-cipher]');
    return el ? el.value : '';
  `)
  const textKey = await ev(`
    const areas = Array.from(document.querySelectorAll('textarea'));
    return areas.map((el) => el.value.trim()).find((v) => /^[0-9a-f]{32}$/i.test(v)) ?? null;
  `)
  await shot('12-text-key-modal', '文本分区：文本加密同样强制弹出密钥弹窗')
  await ev(`
    Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('我已复制，关闭并销毁')).click();
    await new Promise((r) => setTimeout(r, 300));
    const confirm = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('确认关闭并销毁'));
    if (confirm) confirm.click();
    return true;
  `)
  await waitFor(`document.querySelector('#xq-key-title') === null`, 20000, '弹窗关闭')
  await sleep(400)
  await shot('13-text-panel', '文本分区：明文 → 密文串（XUQIAN1: 前缀），可复制/存文件')

  // ---------- 14 工具分区：密码生成器 ----------
  await switchTab('工具')
  await clickText(['生成密码'], true)
  await sleep(500)
  await shot('14-tools-password', '工具分区：随机密码生成器（CSPRNG）')

  // ---------- 15 工具分区：哈希校验 ----------
  await ev(`
    const areas = Array.from(document.querySelectorAll('textarea'));
    const target = areas.find((el) => el.value === '' && el.rows <= 4) ?? areas[areas.length - 1];
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(target, 'sha256-check-demo');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '哈希校验');
    btn.click();
    await new Promise((r) => setTimeout(r, 900));
    return true;
  `)
  await sleep(500)
  await shot('15-tools-hash', '工具分区：SHA-256 / SHA-512 哈希校验')

  // ---------- 16 工具分区：文件头查看 + 分片恢复 + 设置/日志 ----------
  await ev(`window.scrollTo(0, 1500); document.documentElement.style.overflowY = 'hidden'; return true;`)
  await sleep(400)
  const lower = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, '16-tools-inspect-shamir.png'), Buffer.from(lower.data, 'base64'))
  shots.push({
    name: '16-tools-inspect-shamir',
    note: '工具分区（下半部分）：查看 .XUQIAN 文件头、Shamir 分片恢复、设置与本地日志',
    file: 'docs/images/16-tools-inspect-shamir.png',
    bytes: readFileSync(join(outDir, '16-tools-inspect-shamir.png')).length,
  })
  console.log('  📸 16-tools-inspect-shamir.png — 工具分区下半部分')
  await ev(`window.scrollTo(0, 0); return true;`)
  await sleep(250)

  // ---------- 17 亮色主题 ----------
  await ev(`
    const btn = Array.from(document.querySelectorAll('button')).find((el) => /亮色|Light/.test(el.textContent));
    if (btn) btn.click();
    return document.documentElement.dataset.theme;
  `)
  await switchTab('加密')
  await sleep(500)
  await shot('17-light-theme', '亮色主题下的加密分区')

  // ---------- 18 英文界面 ----------
  await ev(`
    const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'EN');
    if (btn) btn.click();
    return true;
  `)
  await sleep(500)
  await shot('18-english', '英文界面（工具分区可切换语言）')

  // 切回中文
  await ev(`
    const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '中文');
    if (btn) btn.click();
    return true;
  `)

  // ---------- 19 移动端 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await switchTab('加密')
  await sleep(600)
  await shot('19-mobile-encrypt', '移动端（390×844）：加密分区布局')
  await switchTab('解密')
  await sleep(500)
  await shot('20-mobile-decrypt', '移动端：解密分区布局')
  await send('Emulation.clearDeviceMetricsOverride')

  // ---------- 21 密钥二维码特写 ----------
  await switchTab('文本')
  await setText('[data-testid=text-plain]', '二维码特写用')
  await clickText(['加密文本'], true)
  await waitFor(`document.querySelector('#xq-key-title') !== null`, 60000, '弹窗')
  await sleep(900)
  const clip = await ev(`
    const canvas = document.querySelector('canvas');
    const card = canvas.closest('div');
    const r = card.getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 2 };
  `)
  const qr = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(join(outDir, '21-key-qr.png'), Buffer.from(qr.data, 'base64'))
  shots.push({
    name: '21-key-qr',
    note: '密钥二维码特写（等同密钥，切勿外传）',
    file: 'docs/images/21-key-qr.png',
    bytes: readFileSync(join(outDir, '21-key-qr.png')).length,
  })
  console.log('  📸 21-key-qr.png — 密钥二维码特写')

  writeFileSync(join(workDir, 'shots.json'), JSON.stringify(shots, null, 2))
  writeFileSync(
    join(process.cwd(), 'docs', 'images', 'shots.json'),
    JSON.stringify({ base: BASE, ts: new Date().toISOString(), shots }, null, 2),
  )
  console.log(`\n共生成 ${shots.length} 张截图 → docs/images/`)
  void cipherText
  void textKey
} catch (error) {
  console.error('截图失败:', error.message)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    // 连接可能已断：收尾阶段不因 close 失败而抛
  }
  browser.kill()
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    // 临时目录可能仍被浏览器占用：失败不影响测试结论
  }
}
