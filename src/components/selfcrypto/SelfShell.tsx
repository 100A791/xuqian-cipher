/**
 * 自研路线的页面外壳 —— SPEC §5 阶段五「先写 main.js 做主界面和路由」的对应物（决策 D25：React 实现）。
 * 五个入口与 SPEC §2 的页面划分一一对应：文件加密 / 解密 / 图片水印 / AI 检测 + 算法与状态。
 */
import type { ReactNode } from 'react'
import { SELF_TABS, useApp, type SelfTab } from '../../app/store.ts'

export function SelfShell({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  const t = useApp((s) => s.t)
  const selfTab = useApp((s) => s.selfTab)
  const setSelfTab = useApp((s) => s.setSelfTab)

  return (
    <main className="flex flex-1 flex-col gap-4" data-testid="sc-shell">
      <nav className="xq-panel flex flex-wrap gap-1 p-1.5" role="tablist" aria-label="self-crypto">
        <button
          type="button"
          role="tab"
          aria-selected={selfTab === 'home'}
          data-active={selfTab === 'home'}
          className="xq-tab"
          data-testid="sc-nav-home"
          onClick={() => setSelfTab('home')}
        >
          {t('sc.nav.home')}
        </button>
        {SELF_TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selfTab === key}
            data-active={selfTab === key}
            className="xq-tab"
            data-testid={`sc-nav-${key}`}
            onClick={() => setSelfTab(key as SelfTab)}
          >
            {t(`sc.nav.${key}` as 'sc.nav.home')}
          </button>
        ))}
      </nav>

      <section className="xq-panel flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-[12px] leading-relaxed xq-muted">{description}</p> : null}
        </div>
        {children}
      </section>
    </main>
  )
}
