/**
 * PWA 更新提示条。
 *
 * 出现时机：Service Worker 检测到 waiting 状态的新版本（src/app/pwa.ts 广播
 * `xq-sw-update`）。刻意做成独立小组件：只依赖 useApp 的 t() 和 window 事件，
 * 不读密钥相关状态，更新提示永远不会碰密钥数据。
 *
 * 「立即刷新」触发 window.location.reload() —— 若密钥尚未销毁，beforeunload
 * 确认框会先弹出（src/worker/client.ts），所以这里不需要也不能绕过它。
 */
import { useEffect, useState } from 'react'
import { useApp } from '../app/store.ts'

export function UpdateBanner() {
  const t = useApp((s) => s.t)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onUpdate = () => setVisible(true)
    window.addEventListener('xq-sw-update', onUpdate)
    return () => window.removeEventListener('xq-sw-update', onUpdate)
  }, [])

  if (!visible) return null
  return (
    <div
      className="xq-panel flex flex-wrap items-center justify-between gap-3 p-3"
      role="status"
      data-testid="update-banner"
    >
      <div className="text-xs">
        <div className="font-medium">{t('pwa.update.title')}</div>
        <div className="mt-0.5 text-[11px] xq-muted">{t('pwa.update.hint')}</div>
      </div>
      <div className="flex gap-2">
        <button type="button" className="xq-btn text-xs" onClick={() => setVisible(false)}>
          {t('pwa.update.later')}
        </button>
        <button
          type="button"
          className="xq-btn xq-btn-primary text-xs"
          data-testid="update-reload"
          onClick={() => window.location.reload()}
        >
          {t('pwa.update.reload')}
        </button>
      </div>
    </div>
  )
}
