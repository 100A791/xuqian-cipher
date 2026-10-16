/**
 * 开始页：加密路线二选一（用户要求：在开始页面先选着——1. 简单加密 2. 自研加密，各带解释）。
 *
 * 两条路线相互独立、产出格式互不通用，因此把区别写在选择之前，而不是让用户进去以后才发现。
 * 选择持久化在 localStorage（非敏感信息），已选过则直接进入对应界面，可用顶栏按钮切回本页。
 */
import { useApp } from '../app/store.ts'
import { Alert } from './ui.tsx'

function Bullet({ children }: { children: string }) {
  return (
    <li className="flex gap-2 text-[12px] leading-relaxed">
      <span aria-hidden className="mt-[2px] text-[10px] opacity-60">
        ◆
      </span>
      <span>{children}</span>
    </li>
  )
}

function ModeCard({
  testId,
  title,
  badge,
  desc,
  points,
  best,
  warning,
  cta,
  onChoose,
}: {
  testId: string
  title: string
  badge: string
  desc: string
  points: string[]
  best: string
  warning?: string
  cta: string
  onChoose: () => void
}) {
  return (
    <section className="xq-panel flex flex-col gap-3 p-4" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span
          className="xq-mono rounded px-2 py-0.5 text-[11px] xq-muted"
          style={{ border: '1px solid var(--xq-line)' }}
        >
          {badge}
        </span>
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      <p className="text-[12px] leading-relaxed xq-muted">{desc}</p>
      <ul className="flex flex-col gap-1.5">
        {points.map((point) => (
          <Bullet key={point}>{point}</Bullet>
        ))}
      </ul>
      {warning ? <Alert tone="warn">{warning}</Alert> : null}
      <p className="text-[11px] xq-muted">{best}</p>
      <button type="button" className="xq-btn mt-auto w-full" onClick={onChoose}>
        {cta}
      </button>
    </section>
  )
}

export function StartScreen() {
  const t = useApp((s) => s.t)
  const theme = useApp((s) => s.theme)
  const lang = useApp((s) => s.lang)
  const store = useApp()

  return (
    <div
      className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center gap-4 px-3 py-8 sm:px-5"
      data-testid="start-screen"
    >
      <header className="flex flex-wrap items-center gap-3">
        <div className="xq-seal h-14 w-14 shrink-0 text-xs leading-tight">许七安</div>
        <div className="min-w-[12rem] flex-1">
          <h1 className="text-lg font-semibold tracking-wide sm:text-xl">
            {t('brand.title')}
            <span className="ml-2 text-sm xq-muted">/ {t('brand.subtitle')}</span>
          </h1>
          <p className="mt-0.5 text-[11px] xq-muted">{t('brand.tagline')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="xq-btn text-xs"
            onClick={() => store.setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? `☾ ${t('theme.light')}` : `☀ ${t('theme.dark')}`}
          </button>
          <button type="button" className="xq-btn text-xs" onClick={() => store.setLang(lang === 'zh' ? 'en' : 'zh')}>
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
        </div>
      </header>

      <div>
        <h2 className="text-base font-semibold">{t('start.title')}</h2>
        <p className="mt-1 text-[12px] leading-relaxed xq-muted">{t('start.lead')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModeCard
          testId="start-simple"
          badge="01"
          title={t('start.simple.title')}
          desc={t('start.simple.desc')}
          points={[t('start.simple.p1'), t('start.simple.p2'), t('start.simple.p3')]}
          best={t('start.simple.best')}
          cta={`${t('start.choose')} →`}
          onChoose={() => store.setMode('simple')}
        />
        <ModeCard
          testId="start-self"
          badge="02"
          title={t('start.self.title')}
          desc={t('start.self.desc')}
          points={[t('start.self.p1'), t('start.self.p2'), t('start.self.p3')]}
          best={t('start.self.best')}
          warning={t('start.self.pending')}
          cta={`${t('start.choose')} →`}
          onChoose={() => store.setMode('self')}
        />
      </div>

      <Alert tone="info">{t('compliance')}</Alert>
    </div>
  )
}
