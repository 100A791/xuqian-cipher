/**
 * PWA 离线壳的注册入口。
 *
 * 只在**生产构建**里注册：
 * - dev 下不注册，避免 HMR、依赖预构建与缓存互相干扰；
 * - 生产下 sw.js 由 vite.config.ts 在构建时生成（预缓存全部 hashed 产物）。
 *
 * 注册失败（浏览器不支持 / 非安全上下文 / 策略拦截）只意味着"没有离线能力"，
 * 不影响任何加密功能，也不应打断页面。
 */
export function registerOfflineShell(): void {
  if (!import.meta.env.PROD) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      /* 离线能力降级；加密与解密不依赖它 */
    })
  })
}
