/**
 * PWA 离线壳的注册入口 + 新版本检测。
 *
 * 只在**生产构建**里注册：
 * - dev 下不注册，避免 HMR、依赖预构建与缓存互相干扰；
 * - 生产下 sw.js 由 vite.config.ts 在构建时生成（预缓存全部 hashed 产物）。
 *
 * 注册失败（浏览器不支持 / 非安全上下文 / 策略拦截）只意味着"没有离线能力"，
 * 不影响任何加密功能，也不应打断页面。
 *
 * 新版本检测：SW 不做 skipWaiting（理由见 scripts/sw-template.js），新版本装好后
 * 会停在 waiting。这里监听两处 —— 注册时已有 waiting、或 updatefound 的 installing
 * 变成 installed —— 命中就广播 `xq-sw-update`，由 UpdateBanner 展示"立即刷新 / 稍后"。
 * 点刷新会经过 beforeunload 确认，不会静默销毁未备份的密钥。
 */
export function registerOfflineShell(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((registration) => {
        notifyIfWaiting(registration)
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          installing?.addEventListener('statechange', () => {
            // controller 存在 = 本次会话已被某个 SW 接管；此时 installed 才代表
            // "来了一个还没接管的新版本"（首次安装不算更新）。
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              notifyIfWaiting(registration)
            }
          })
        })
      })
      .catch(() => {
        /* 离线能力降级；加密与解密不依赖它 */
      })
  })
}

function notifyIfWaiting(registration: ServiceWorkerRegistration): void {
  if (!registration.waiting) return
  window.dispatchEvent(new CustomEvent('xq-sw-update'))
}
