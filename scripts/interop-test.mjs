/**
 * 浏览器 ↔ 命令行 双向互操作测试。
 *
 * 目的：把"格式开放、两端可互解"从承诺变成可复现的证据。
 *
 * 覆盖：
 *   A. CLI 加密 → 浏览器解密（5 种算法、多层、gzip）
 *   B. 浏览器加密 → CLI 解密
 *   C. 密钥文件交叉：CLI 的 .XUQIANKEY（明文 / 密码保护）给浏览器用；浏览器的给 CLI 用
 *   D. 负例：错误密钥在两端都必须失败
 *
 * 用法：node scripts/interop-test.mjs [baseUrl]
 * 环境变量：XQ_INTEROP_KEEP=1 保留临时目录便于排查
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  clickByText,
  createChecker,
  launchSession,
  setInput,
  sleep,
  switchTab,
  uploadFile,
  waitFor,
} from './lib/browser-harness.mjs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:5188/'
// 端口可用 XQ_INTEROP_PORT 覆盖。原先固定 9335 / 9336 只是"端口分工"，并没有解决
// 「等待超时: 页面加载完成」——那个问题的根因是端口被 IDE 的预览浏览器占用，
// 目前已由 scripts/lib/devtools.mjs 的 assertPortFree() 在启动前拦下。
const PORT = Number(process.env.XQ_INTEROP_PORT ?? 9412)
const ROOT = process.cwd()
const CLI = join(ROOT, 'cli', 'xuqian.ts')
const KEEP = process.env.XQ_INTEROP_KEEP === '1'

const { check, results, summary } = createChecker()
const work = mkdtempSync(join(tmpdir(), 'xuqian-interop-'))
const reportRows = []

/** 项目自身的密钥文件工具：造"指定密钥"的 .XUQIANKEY（keygen 只能生成随机密钥）。 */
function makeKeyFile(targetPath, keyHex, password) {
  const helper = join(ROOT, 'scripts', 'lib', 'make-keyfile.ts')
  const args = [helper, targetPath, keyHex]
  if (password) args.push(password)
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT })
  if (result.status !== 0) return { ok: false, detail: (result.stderr || result.stdout || '').trim().slice(0, 220) }
  try {
    return JSON.parse(result.stdout)
  } catch {
    return { ok: false, detail: result.stdout?.slice(0, 220) }
  }
}

function xuqian(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? work,
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function writeFixture(path, size, { incompressible = false } = {}) {
  const buffer = incompressible ? randomBytes(size) : Buffer.alloc(size)
  if (!incompressible) for (let i = 0; i < size; i++) buffer[i] = (i * 97 + 31) & 0xff
  writeFileSync(path, buffer)
  return buffer
}

/** 清空某个面板的文件队列，避免用例之间互相污染。 */
async function clearQueue(session, tab) {
  await switchTab(session.cdp, tab)
  await session.cdp.eval(`
    const btn = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '清空');
    if (btn) btn.click();
    return true;
  `)
  await sleep(250)
}

/** 读出页面上的密钥/错误相关文本，用于失败诊断。 */
async function readPanelFeedback(session) {
  return session.cdp.eval(`
    const lines = document.body.innerText.split('\\n').map((l) => l.trim()).filter(Boolean);
    const interesting = lines.filter((l) => /密钥|错误|失败|损坏|完成|校验|一致|不匹配|密码/.test(l));
    return interesting.slice(-6).join(' | ');
  `)
}

/** 用浏览器解密给定的 .XUQIAN（密钥或密钥文件二选一）。 */
async function browserDecrypt(session, { cipherPath, cipherName, keyHex, keyFile, keyFilePassword }) {
  await clearQueue(session, '解密')
  await uploadFile(session.cdp, cipherPath, 'input[type=file]')
  await waitFor(session.cdp, `document.body.innerText.includes(${JSON.stringify(cipherName)})`, 20000, '密文入队')

  if (keyFile) {
    await clickByText(session.cdp, ['上传 .XUQIANKEY'])
    await sleep(400)
    await uploadFile(session.cdp, keyFile, '[data-testid="keyfile-input"]')
    // 等"已载入"出现，确保组件已接管该 File 对象
    await waitFor(session.cdp, `/已载入.*XUQIANKEY/.test(document.body.innerText)`, 20000, '密钥文件载入')
    // 文件模式下密钥输入框不存在；这里只在它存在时清空，避免残留旧值造成误判
    await session.cdp.eval(`
      const node = document.querySelector('[data-testid="decrypt-key"]');
      if (node) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(node, '');
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    `)
    if (keyFilePassword) await setInput(session.cdp, '[data-testid="keyfile-password"]', keyFilePassword)
    await sleep(300)
  } else {
    await setInput(session.cdp, '[data-testid="decrypt-key"]', keyHex)
    await sleep(250)
  }

  await clickByText(session.cdp, ['开始解密'])
  try {
    await waitFor(session.cdp, `/解密完成|Decryption finished/.test(document.body.innerText)`, 120000, '浏览器解密完成')
    return { ok: true }
  } catch {
    return { ok: false, detail: await readPanelFeedback(session) }
  }
}

/** 让浏览器下载它刚解出来的原文件，返回落盘路径。 */
async function browserSaveRestored(session) {
  const clicked = await session.cdp.eval(`
    window.__xqDownloads = [];
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((el) => /下载还原文件|下载原文件|Download restored/.test(el.textContent));
    if (!btn) {
      return { ok: false, candidates: buttons.map((el) => el.textContent.trim()).filter(Boolean).slice(0, 12) };
    }
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    return { ok: true, names: window.__xqDownloads };
  `)
  if (!clicked.ok)
    return { name: null, path: null, detail: `无还原按钮；候选按钮=${JSON.stringify(clicked.candidates)}` }
  const name = (clicked.names ?? [])[0] ?? null
  if (!name) return { name: null, path: null, detail: '还原按钮存在但未记录到 download 文件名' }
  const path = join(session.downloadDir, name)
  for (let i = 0; i < 60 && !existsSync(path); i++) await sleep(200)
  return { name, path }
}

let session
try {
  const keyHex = '0123456789abcdef0123456789abcdef'
  const keysDir = join(work, 'keys')
  mkdirSync(keysDir, { recursive: true })

  const cliKeyFile = join(keysDir, 'cli.XUQIANKEY')
  const cliProtectedKeyFile = join(keysDir, 'cli-protected.XUQIANKEY')
  const plainInfo = makeKeyFile(cliKeyFile, keyHex)
  const protectedInfo = makeKeyFile(cliProtectedKeyFile, keyHex, 'interop-pass')
  check(
    '准备测试密钥文件（明文 + 密码保护，并回读确认密钥一致）',
    plainInfo.ok &&
      protectedInfo.ok &&
      plainInfo.keyHex?.toLowerCase() === keyHex &&
      protectedInfo.keyHex?.toLowerCase() === keyHex,
    `指纹 ${plainInfo.fingerprint ?? '?'}${plainInfo.detail ? ` · ${plainInfo.detail}` : ''}`,
  )
  console.log(`  工作目录: ${work}${KEEP ? '（保留）' : ''}`)

  console.log('\n启动浏览器…')
  session = await launchSession({ base: BASE, port: PORT })
  // 启动时浏览器可能已跑完入口脚本，这里补一次下载拦截
  await session.cdp.eval(`window.__xqDownloads = []; return true;`)

  // ==================================================================
  // A. CLI 加密 → 浏览器解密
  // ==================================================================
  console.log('\n[A] CLI 加密 → 浏览器解密')
  const algoCases = [
    { label: 'AES-128-GCM', layers: 'AES-128-GCM', gzip: false },
    { label: 'AES-256-GCM', layers: 'AES-256-GCM', gzip: false },
    { label: 'CHACHA20-POLY1305', layers: 'CHACHA20-POLY1305', gzip: false },
    { label: 'XCHACHA20-POLY1305', layers: 'XCHACHA20-POLY1305', gzip: false },
    { label: 'SM4-GCM', layers: 'SM4-GCM', gzip: false },
    { label: '三层混合', layers: 'AES-256-GCM,CHACHA20-POLY1305,SM4-GCM', gzip: false },
    { label: '三层 + gzip（不可压缩数据）', layers: 'AES-256-GCM,CHACHA20-POLY1305,SM4-GCM', gzip: true },
  ]

  let firstCipher = null
  for (const testCase of algoCases) {
    const dir = join(work, `cli-${testCase.label.replace(/[^\w]/g, '')}`)
    mkdirSync(dir, { recursive: true })
    const original = join(dir, 'payload.bin')
    const originalBytes = writeFixture(original, 150_000, { incompressible: testCase.gzip })

    const args = ['encrypt', original, '--key', keyHex, '--layers', testCase.layers, '--out', dir, '--quiet']
    if (testCase.gzip) args.push('--gzip')
    const enc = xuqian(args)
    const cipherPath = join(dir, 'payload.bin.XUQIAN')
    if (enc.status !== 0 || !existsSync(cipherPath)) {
      check(`CLI 加密（${testCase.label}）`, false, enc.stderr.trim().slice(0, 140))
      continue
    }
    if (!firstCipher) firstCipher = { path: cipherPath, original }

    const outcome = await browserDecrypt(session, { cipherPath, cipherName: 'payload.bin.XUQIAN', keyHex })
    check(`浏览器能解密 CLI 产物（${testCase.label}）`, outcome.ok, outcome.detail ?? '')

    if (outcome.ok) {
      const saved = await browserSaveRestored(session)
      const identical = saved.path && existsSync(saved.path) && readFileSync(saved.path).equals(originalBytes)
      check(
        `浏览器还原字节一致（${testCase.label}）`,
        Boolean(identical),
        identical ? (saved.name ?? '') : (saved.detail ?? `${saved.name ?? '无下载'} → ${saved.path ?? ''}`),
      )
      reportRows.push({
        direction: 'CLI → 浏览器',
        case: testCase.label,
        result: identical ? '字节一致' : '解密成功但字节不一致',
      })
    } else {
      reportRows.push({ direction: 'CLI → 浏览器', case: testCase.label, result: '解密失败' })
    }
  }

  // ==================================================================
  // C. 密钥文件交叉
  // ==================================================================
  console.log('\n[C] 密钥文件交叉使用')
  if (firstCipher) {
    const viaPlainKeyFile = await browserDecrypt(session, {
      cipherPath: firstCipher.path,
      cipherName: 'payload.bin.XUQIAN',
      keyFile: cliKeyFile,
    })
    check('浏览器用 CLI 生成的明文 .XUQIANKEY 解密', viaPlainKeyFile.ok, viaPlainKeyFile.detail ?? '')
    reportRows.push({
      direction: 'CLI → 浏览器（密钥文件）',
      case: '明文 .XUQIANKEY',
      result: viaPlainKeyFile.ok ? '成功' : '失败',
    })

    const viaProtectedKeyFile = await browserDecrypt(session, {
      cipherPath: firstCipher.path,
      cipherName: 'payload.bin.XUQIAN',
      keyFile: cliProtectedKeyFile,
      keyFilePassword: 'interop-pass',
    })
    check('浏览器用 CLI 生成的密码保护 .XUQIANKEY 解密', viaProtectedKeyFile.ok, viaProtectedKeyFile.detail ?? '')
    reportRows.push({
      direction: 'CLI → 浏览器（密钥文件）',
      case: '密码保护 .XUQIANKEY',
      result: viaProtectedKeyFile.ok ? '成功' : '失败',
    })

    const viaWrongPassword = await browserDecrypt(session, {
      cipherPath: firstCipher.path,
      cipherName: 'payload.bin.XUQIAN',
      keyFile: cliProtectedKeyFile,
      keyFilePassword: 'totally-wrong',
    })
    check('浏览器用错误密钥文件密码必须失败', viaWrongPassword.ok === false, viaWrongPassword.detail ?? '')
  }

  // ==================================================================
  // B. 浏览器加密 → CLI 解密
  // ==================================================================
  console.log('\n[B] 浏览器加密 → CLI 解密')
  const browserSource = join(work, 'browser-source.bin')
  const browserBytes = writeFixture(browserSource, 200_000, { incompressible: true })
  let browserKey = null
  let browserCipherPath = null
  let browserKeyFile = null
  {
    await clearQueue(session, '加密')
    // 用**多层**（3 层）在浏览器侧加密：这是"开头是否仍被加密"的唯一未覆盖组合
    const uiLayers = await session.cdp.eval(`
      const algoSelects = () => Array.from(document.querySelectorAll('select')).filter((el) => /GCM|CHACHA/.test(el.options[0]?.textContent ?? ''));
      const wanted = 3;
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
      return algoSelects().length;
    `)
    check('浏览器侧已设为 3 层加密', uiLayers === 3, `实际 ${uiLayers} 层`)
    reportRows.push({
      direction: '浏览器侧设置',
      case: '3 层加密',
      result: uiLayers === 3 ? '成功' : `实际 ${uiLayers} 层`,
    })

    await uploadFile(session.cdp, browserSource, 'input[type=file]')
    await waitFor(session.cdp, `document.body.innerText.includes('browser-source.bin')`, 20000, '文件入队')
    await session.cdp.eval(`window.__xqDownloads = []; return true;`)
    await clickByText(session.cdp, ['开始加密'])
    await waitFor(session.cdp, `document.querySelector('#xq-key-title') !== null`, 120000, '密钥弹窗')

    browserKey = await session.cdp.eval(`
      const areas = Array.from(document.querySelectorAll('textarea'));
      return areas.map((el) => el.value.trim()).find((v) => /^[0-9a-f]{32}$/i.test(v)) ?? null;
    `)
    check(
      '浏览器加密后取得密钥（Hex）',
      typeof browserKey === 'string' && /^[0-9a-f]{32}$/i.test(browserKey),
      `${browserKey?.slice(0, 8)}…`,
    )

    await session.cdp.eval(`
      Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('下载 .XUQIANKEY')).click();
      return true;
    `)
    await sleep(900)
    const keyFileName = await session.cdp.eval(
      `return window.__xqDownloads.find((n) => n.endsWith('.XUQIANKEY')) ?? null;`,
    )
    if (keyFileName) {
      const candidate = join(session.downloadDir, keyFileName)
      for (let i = 0; i < 60 && !existsSync(candidate); i++) await sleep(200)
      if (existsSync(candidate)) browserKeyFile = candidate
    }
    check('浏览器生成 .XUQIANKEY 并落盘', browserKeyFile !== null, keyFileName ?? '无')

    await clickByText(session.cdp, ['我已复制，关闭并销毁'])
    await sleep(400)
    if (await session.cdp.eval(`return /尚未复制或下载密钥/.test(document.body.innerText)`)) {
      await clickByText(session.cdp, ['确认关闭并销毁'])
    }
    await waitFor(session.cdp, `document.querySelector('#xq-key-title') === null`, 20000, '弹窗关闭')

    await session.cdp.eval(`window.__xqDownloads = []; return true;`)
    const cipherName = await session.cdp.eval(`
      const btn = Array.from(document.querySelectorAll('button')).find((el) => /下载.*\\.XUQIAN$/.test(el.textContent.trim()));
      if (!btn) throw new Error('找不到 .XUQIAN 下载按钮');
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
      return window.__xqDownloads.find((n) => n.endsWith('.XUQIAN')) ?? null;
    `)
    if (cipherName) {
      const candidate = join(session.downloadDir, cipherName)
      for (let i = 0; i < 60 && !existsSync(candidate); i++) await sleep(200)
      if (existsSync(candidate)) browserCipherPath = candidate
    }
    check('浏览器产物已落盘', browserCipherPath !== null, cipherName ?? '无')

    // 关键断言：浏览器侧**多层**加密的产物，开头必须仍是**明文**声明
    if (browserCipherPath) {
      const raw = readFileSync(browserCipherPath)
      const marker = raw.length > 6 ? raw[6] : null
      let noticeText = ''
      if (marker === 2) {
        const n = raw.readUInt32BE(7)
        noticeText = raw.subarray(11, 11 + n).toString('utf8')
      }
      check(
        '浏览器 3 层加密后，文件开头仍是明文声明（未被加密）',
        marker === 2 && /XUQIAN/.test(noticeText),
        `marker=${marker} 声明 ${noticeText.length} 字`,
      )
      reportRows.push({
        direction: '浏览器侧产物',
        case: '3 层 + 明文声明在文件最前',
        result: marker === 2 && /XUQIAN/.test(noticeText) ? '通过' : '失败',
      })
    }
  }

  if (browserCipherPath && browserKey) {
    const decDir = join(work, 'cli-from-browser')
    mkdirSync(decDir, { recursive: true })
    const dec = xuqian(['decrypt', browserCipherPath, '--key', browserKey, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'browser-source.bin')
    const identical = dec.status === 0 && existsSync(restored) && readFileSync(restored).equals(browserBytes)
    check('CLI 能解密浏览器产物且字节一致', identical, dec.stderr.trim().split('\n').pop() ?? '')
    reportRows.push({
      direction: '浏览器 → CLI',
      case: '3 层（AES-128-GCM×3）',
      result: identical ? '字节一致' : '不一致',
    })

    if (browserKeyFile) {
      const dir2 = join(work, 'cli-from-browser-keyfile')
      mkdirSync(dir2, { recursive: true })
      const dec2 = xuqian(['decrypt', browserCipherPath, '--keyfile', browserKeyFile, '--out', dir2, '--quiet'])
      const restored2 = join(dir2, 'browser-source.bin')
      const same2 = dec2.status === 0 && existsSync(restored2) && readFileSync(restored2).equals(browserBytes)
      check('CLI 可用浏览器生成的 .XUQIANKEY 解密', same2, dec2.stderr.trim().split('\n').pop() ?? '')
      reportRows.push({
        direction: '浏览器 → CLI（密钥文件）',
        case: '.XUQIANKEY 交叉',
        result: same2 ? '成功' : '失败',
      })
    }

    const wrongDir = join(work, 'cli-wrong-key')
    mkdirSync(wrongDir, { recursive: true })
    const wrong = xuqian([
      'decrypt',
      browserCipherPath,
      '--key',
      'ffffffffffffffffffffffffffffffff',
      '--out',
      wrongDir,
      '--quiet',
    ])
    check(
      'CLI 用错误密钥解浏览器产物必须失败',
      wrong.status !== 0 && /密钥错误或文件损坏/.test(wrong.stderr),
      wrong.stderr.trim().split('\n').pop() ?? '',
    )
    reportRows.push({ direction: '负例', case: 'CLI 错误密钥', result: wrong.status !== 0 ? '按预期失败' : '意外成功' })
  }

  // ==================================================================
  // D. 浏览器侧负例
  // ==================================================================
  if (firstCipher) {
    const bad = await browserDecrypt(session, {
      cipherPath: firstCipher.path,
      cipherName: 'payload.bin.XUQIAN',
      keyHex: 'ffffffffffffffffffffffffffffffff',
    })
    check('浏览器用错误密钥解 CLI 产物必须失败', bad.ok === false, bad.detail ?? '')
    reportRows.push({ direction: '负例', case: '浏览器错误密钥', result: bad.ok === false ? '按预期失败' : '意外成功' })
  }

  // ==================================================================
  // 报告
  // ==================================================================
  const allOk = results.every((r) => r.ok)
  const runInfo = `Node ${process.version} · ${process.platform} · 真实 headless 浏览器（Edge/Chromium）`
  // 报告里出现的随机密钥前缀（形如 `ccaadd90…`）每次运行都不同，会让报告产生无意义 diff。
  // 只对写入文件的内容做脱敏；控制台仍然打印完整明细。
  const stableDetail = (text) => text.replace(/\b[0-9a-f]{6,}(?=…)/gi, '<hex>')
  // 时间戳与环境**不写进报告文件**：它们每次重跑都会变，会在工作树里制造无意义的 diff。
  // 需要追溯运行环境时看控制台输出（或 CI 日志）。
  console.log(`\n[interop] 运行环境：${runInfo}`)
  const report = `# 浏览器 ↔ 命令行 互操作测试报告

> 本文件由 \`node scripts/interop-test.mjs\` 自动生成，**请勿手工编辑**。
> 时间戳与环境只打印到控制台，不写进文件，避免每次重跑都产生无意义的 diff。

测试密钥：固定 Hex（\`0123456789abcdef0123456789abcdef\`）与浏览器随机生成的 128 位密钥各一轮

## 结论

${allOk ? '**两端产物完全互解** —— `.XUQIAN` 与 `.XUQIANKEY` 的格式承诺可复现。' : '**存在失败项**，格式互操作尚未完全成立，详见下方明细。'}

| 方向 | 用例 | 结果 |
| --- | --- | --- |
${reportRows.map((r) => `| ${r.direction} | ${r.case} | ${r.result} |`).join('\n')}

## 断言明细（共 ${results.length} 项，通过 ${results.filter((r) => r.ok).length} 项）

${results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${stableDetail(r.detail)}` : ''}`).join('\n')}

## 为什么这个测试重要

\`.XUQIAN\` 的头部与分块布局由 \`src/crypto/container.ts\` 唯一定义。浏览器与命令行两端
**共用同一份加密实现**（CLI 直接 import \`src/crypto/*\`，依赖 Node ≥20 的 \`crypto.subtle\`），
因此本测试验证的是"同一实现对同一格式的读写一致"，而不是两套独立实现的偶然兼容。
`
  writeFileSync(join(ROOT, 'docs', 'interop-report.md'), report)
  console.log(`\n报告已写入 docs/interop-report.md（${allOk ? '全部通过' : '存在失败项'}）`)
} catch (error) {
  check('互操作测试流程未抛异常', false, error.message)
} finally {
  if (session) await session.teardown()
  const ok = summary('互操作测试')
  if (!ok) process.exitCode = 1
  if (!KEEP) {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  } else {
    console.log(`临时目录已保留: ${work}`)
  }
}
