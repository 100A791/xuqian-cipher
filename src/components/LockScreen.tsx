/** 锁定遮罩：会话被锁定（空闲超时或手动锁定）时盖住整个界面，直到用户明确确认。 */
import { useApp } from '../app/store.ts'

export function LockScreen() {
  const t = useApp((s) => s.t)
  const locked = useApp((s) => s.locked)
  const store = useApp()

  if (!locked) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={t('lock.title')}
      data-testid="lock-screen"
    >
      <div className="xq-panel w-full max-w-sm space-y-3 p-5 text-center">
        <div className="xq-seal mx-auto h-12 w-12 text-xs leading-tight">许七安</div>
        <h2 className="text-base font-semibold">{t('lock.title')}</h2>
        <p className="text-xs xq-muted">{t('lock.body')}</p>
        <button type="button" className="xq-btn w-full" data-testid="lock-continue" onClick={() => store.setLocked(false)}>
          {t('lock.unlock')}
        </button>
      </div>
    </div>
  )
}
