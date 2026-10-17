/**
 * 离线壳（PWA）验证：真构建、真 preview、真断网。
 *
 * 检查四件事：
 *   1. dist/ 里确实有 sw.js、manifest.webmanifest、图标；
 *   2. 页面能注册 Service Worker 并由它接管（controller 指向 sw.js）；
 *   3. 用 CDP 把网络切成 offline 后刷新，应用外壳仍能启动；
 *   4. 断网状态下还能完成一次文本加密（密钥弹窗出现）——证明加解密不依赖任何网络。
 *
 * 前提：先 `pnpm build`（本脚本不重复构建；`pnpm test:offline` 会先构建）。
 * 端口：preview 5189、调试 9414（均可用环境变量覆盖）。
 *
 * 用法：node scripts/verify-offline.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  clickByText,
  createChecker,
  launchSession,
  setInput,
  sleep,
  switchTab,
  waitFor,
} from './lib/browser-harness.mjs'
import { assertPortFree } from './lib/devtools.mjs'

const ROOT = process.cwd()
const PREVIEW_PORT = Number(process.env.XQ_PREVIEW_PORT ?? 5189)
const DEBUG_PORT = Number(process.env.XQ_OFFLINE_PORT ?? 9414)
const BASE = `http://127.0.0.1:${PREVIEW_PORT}/`
const DIST = resolve(ROOT, 'dist')
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

const { check, summary } = createChecker()

if (!existsSync(join(DIST, 'index.html'))) {
  console.log('[offline] dist/ 不存在，先构建一次…')
  const built = spawnSync(process.execPath, [VITE_BIN, 'build'], { cwd: ROOT, stdio: 'inherit' })
  if (built.status !== 0) {
    console.error('[offline] 构建失败')
    process.exit(2)
  }
}

// preview 端口必须空着：否则可能预览到别的项目
try {
  const res = await fetch(BASE)
  if (res.ok) throw new Error(`预览端口 ${PREVIEW_PORT} 已被占用，请用 XQ_PREVIEW_PORT 换一个`)
} catch (error) {
  if (error instanceof Error && error.message.includes('已被占用')) {
    console.error(`[offline] ${error.message}`)
    process.exit(1)
  }
}
try {
  await assertPortFree(DEBUG_PORT, 'XQ_OFFLINE_PORT')
} catch (error) {
  console.error(`[offline] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const preview = spawn(
  process.execPath,
  [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
  { stdio: 'ignore' },
)

const stopPreview = () => {
  try {
    preview.kill()
  } catch {
    /* ignore */
  }
}

let session
try {
  // 等 preview 起来
  const deadline = Date.now() + 60000
  let up = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE)
      if (res.ok) {
        up = true
        break
      }
    } catch {
      /* retry */
    }
    await sleep(250)
  }
  if (!up) throw new Error('preview 服务器未就绪')

  // 1) 构建产物齐全
  const required = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'favicon.svg']
  const missing = required.filter((rel) => !existsSync(join(DIST, rel)))
  check(
    '生产构建包含 sw.js / manifest / 图标',
    missing.length === 0,
    missing.length ? `缺失: ${missing.join(', ')}` : required.join(' · '),
  )

  session = await launchSession({ base: BASE, port: DEBUG_PORT })
  const { cdp } = session
  await cdp.send('Network.enable')

  // 2) 注册并接管
  let registered = false
  for (let i = 0; i < 60 && !registered; i++) {
    registered = await cdp.eval(`
      const reg = await navigator.serviceWorker.getRegistration();
      return !!(reg && (reg.active || reg.installing || reg.waiting));
    `)
    if (!registered) await sleep(250)
  }
  check('Service Worker 已注册', registered === true)

  // 首次加载时 SW 可能还没接管，刷新一次让它进入 controller
  let controlled = false
  for (let i = 0; i < 40 && !controlled; i++) {
    controlled = await cdp.eval(`return !!navigator.serviceWorker.controller`)
    if (controlled) break
    if (i % 8 === 0) {
      await cdp.send('Page.reload', { ignoreCache: false })
      await waitFor(cdp, `document.querySelector('#root')?.children.length > 0`, 30000, '刷新后挂载')
    }
    await sleep(300)
  }
  const swProbe = await cdp.eval(`
    const names = await caches.keys();
    return {
      hasController: !!navigator.serviceWorker.controller,
      script: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
      caches: names,
    };
  `)
  check(
    'Service Worker 已注册并接管页面',
    swProbe.hasController === true && typeof swProbe.script === 'string' && swProbe.script.includes('/sw.js'),
    JSON.stringify(swProbe),
  )

  // 3) 断网刷新
  await cdp.eval(`window.__xqBeforeOffline = true; return true;`)
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  })
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitFor(
    cdp,
    `document.readyState === 'complete' && document.querySelector('#root')?.children.length > 0 && !window.__xqBeforeOffline`,
    30000,
    '断网后重新挂载',
  )
  const offlineProbe = await cdp.eval(`
    return { online: navigator.onLine, text: document.body.innerText.slice(0, 120) };
  `)
  check(
    '断网刷新后应用外壳仍可用',
    offlineProbe.online === false && /许七安/.test(offlineProbe.text),
    JSON.stringify(offlineProbe),
  )

  // 4) 断网状态下加密一段文本：密钥弹窗必须出现
  await switchTab(cdp, '文本')
  await setInput(cdp, '[data-testid=text-plain]', 'OFFLINE-XUQIAN-检查')
  await clickByText(cdp, ['加密文本', 'Encrypt text'], { exact: true })
  await waitFor(cdp, `document.querySelector('#xq-key-title') !== null`, 60000, '断网状态下的密钥弹窗')
  check('断网状态下仍可完成文本加密', true, '密钥弹窗已出现')
} catch (error) {
  check('离线壳验证流程', false, error instanceof Error ? error.message : String(error))
} finally {
  if (session) await session.teardown()
  stopPreview()
}

const ok = summary('离线壳验证')
process.exit(ok ? 0 : 1)
