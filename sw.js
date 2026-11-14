/**
 * Service Worker 模板 —— 构建时由 vite.config.ts 注入「构建号」与「预缓存清单」，
 * 产出 dist/sw.js。**不要直接编辑 dist/sw.js**，也不要把这个文件放进 public/。
 *
 * 缓存策略（为什么不是"全都 cache-first"）：
 * - 预缓存：构建产物（hashed 文件名）在 install 时一次性写入，离线首屏可用。
 * - 导航请求：network-first。保证每次打开都先拿最新 index.html；离线时回退到缓存。
 * - 其它同源 GET：cache-first（hashed 资源按内容寻址，天然不可变）。
 * - 不做 skipWaiting：新版本在所有标签页关闭后生效。正在使用的页面仍能取到旧 chunk，
 *   不会因为更新而"半个应用崩掉"——对一个加密工具，这比"立即更新"重要。
 */
const BUILD = '932c7dbd5938'
const PRECACHE = [
  "./",
  "./index.html",
  "./assets/index-AC-kquSf.css",
  "./assets/index-R4K5SAoW.js",
  "./assets/ToolsTab-CTrb22kp.js",
  "./assets/SelfHome-C04Ihkhp.js",
  "./assets/SelfFilePage-BBtTu5cI.js",
  "./assets/SelfDecryptPage-fnEsroIB.js",
  "./assets/selfWorkerClient-5ys9nc9d.js",
  "./assets/SelfWatermarkPage-sjlUwAzj.js",
  "./assets/SelfAiPage-ORStktTI.js",
  "./assets/bytes-DQnjKB3x.js",
  "./assets/SelfStatusPage-BdHR4XDy.js",
  "./assets/SelfShell-Do6cR22H.js",
  "./assets/pbkdf2-BYtN-M9O.js",
  "./assets/extract-DNYs-0NK.js",
  "./assets/fail-BJ5f2Crt.js",
  "./assets/crypto.worker-JlWzaTpk.js",
  "./assets/self.worker-DJcPisHy.js"
]
const CACHE_NAME = `xuqian-${BUILD}`

// 离线手册（纯文本，不含截图，量很小）。这些文件由 sync-docs 复制进 dist/，
// 不在构建产物流里，所以没法进 __PRECACHE__；改为安装时"尽力而为"地补缓存，
// 缺任何一篇都不影响离线壳本身（Promise.allSettled）。
const DOCS = [
  './docs/index.html',
  './docs/README.md',
  './docs/GUIDE.md',
  './docs/FORMAT.md',
  './docs/SECURITY.md',
  './docs/TESTING.md',
  './docs/KEY-LIFECYCLE.md',
  './docs/PROJECT-REPORT.md',
  './docs/PERFORMANCE.md',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      await cache.addAll(PRECACHE)
      await Promise.allSettled(DOCS.map((url) => cache.add(url)))
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((key) => key.startsWith('xuqian-') && key !== CACHE_NAME).map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request)
        } catch {
          const cache = await caches.open(CACHE_NAME)
          return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error()
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      const hit = await cache.match(request)
      if (hit) return hit
      const response = await fetch(request)
      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone())
      }
      return response
    })(),
  )
})
