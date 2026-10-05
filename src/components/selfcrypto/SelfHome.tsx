/** 自研路线主页：五个入口（SPEC §5 阶段五、§6 阶段五验收「主界面五个入口」）。 */
import { useApp } from '../../app/store.ts'
import { Alert } from '../ui.tsx'

const ENTRIES = [
  { key: 'file', badge: '01' },
  { key: 'decrypt', badge: '02' },
  { key: 'watermark', badge: '03' },
  { key: 'ai', badge: '04' },
  { key: 'status', badge: '05' },
] as const

export function SelfHome() {
  const t = useApp((s) => s.t)
  const setSelfTab = useApp((s) => s.setSelfTab)

  return (
    <main className="flex flex-1 flex-col gap-4" data-testid="sc-home">
      <section className="xq-panel flex flex-col gap-2 p-4">
        <h2 className="text-base font-semibold">{t('sc.home.title')}</h2>
        <p className="text-[12px] leading-relaxed xq-muted">{t('sc.home.lead')}</p>
        <Alert tone="info">{t('sc.home.formatNote')}</Alert>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        {ENTRIES.map((entry) => (
          <section key={entry.key} className="xq-panel flex flex-col gap-2 p-4" data-testid={`sc-entry-${entry.key}`}>
            <div className="flex items-center gap-2">
              <span className="xq-mono rounded px-2 py-0.5 text-[11px] xq-muted" style={{ border: '1px solid var(--xq-line)' }}>
                {entry.badge}
              </span>
              <h3 className="text-sm font-semibold">{t(`sc.nav.${entry.key}` as 'sc.nav.file')}</h3>
            </div>
            <p className="text-[12px] leading-relaxed xq-muted">{t(`sc.entry.${entry.key}` as 'sc.entry.file')}</p>
            <button
              type="button"
              className="xq-btn mt-auto w-full"
              data-testid={`sc-open-${entry.key}`}
              onClick={() => setSelfTab(entry.key)}
            >
              {t('sc.open')} →
            </button>
          </section>
        ))}
      </div>
    </main>
  )
}
