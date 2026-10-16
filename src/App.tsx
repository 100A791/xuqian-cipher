/** 应用外壳：开始页（加密路线二选一）、品牌头、四个主 Tab、主题/语言开关、快捷键、合规页脚。 */
import { lazy, Suspense, useEffect } from 'react'
import { useApp, syncDocumentChrome, type TabKey } from './app/store.ts'
import { useAutoLock } from './app/useAutoLock.ts'
import { EncryptTab } from './components/EncryptTab.tsx'
import { DecryptTab } from './components/DecryptTab.tsx'
import { TextTab } from './components/TextTab.tsx'
import { ToolsTab } from './components/ToolsTab.tsx'
import { KeyModal } from './components/KeyModal.tsx'
import { LockScreen } from './components/LockScreen.tsx'
import { StartScreen } from './components/StartScreen.tsx'
// 自研加密路线按需加载：开始页还没选路线时，两种路线的代码都会被静态导入 → 选「简单加密」
// 的用户也要白下载整个自研路线（含 AI 检测的 FFT/DWT）。改成 lazy 后首屏主包从
// 484 kB 降到约 411 kB（gzip 163 → 137 kB），自研路线拆成约 13 个按需 chunk。
const SelfHome = lazy(() => import('./components/selfcrypto/SelfHome.tsx').then((m) => ({ default: m.SelfHome })))
const SelfFilePage = lazy(() =>
  import('./components/selfcrypto/SelfFilePage.tsx').then((m) => ({ default: m.SelfFilePage })),
)
const SelfDecryptPage = lazy(() =>
  import('./components/selfcrypto/SelfDecryptPage.tsx').then((m) => ({ default: m.SelfDecryptPage })),
)
const SelfWatermarkPage = lazy(() =>
  import('./components/selfcrypto/SelfWatermarkPage.tsx').then((m) => ({ default: m.SelfWatermarkPage })),
)
const SelfAiPage = lazy(() => import('./components/selfcrypto/SelfAiPage.tsx').then((m) => ({ default: m.SelfAiPage })))
const SelfStatusPage = lazy(() =>
  import('./components/selfcrypto/SelfStatusPage.tsx').then((m) => ({ default: m.SelfStatusPage })),
)
import { Alert } from './components/ui.tsx'

const TAB_ORDER: TabKey[] = ['encrypt', 'decrypt', 'text', 'tools']

export function App() {
  const t = useApp((s) => s.t)
  const tab = useApp((s) => s.tab)
  const theme = useApp((s) => s.theme)
  const lang = useApp((s) => s.lang)
  const mode = useApp((s) => s.mode)
  const selfTab = useApp((s) => s.selfTab)
  const keyModalOpen = useApp((s) => s.keyModal.open)
  const store = useApp()

  // 空闲自动锁定（0 = 关闭）
  useAutoLock()

  useEffect(() => {
    syncDocumentChrome()
  }, [theme, lang])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 开始页（未选路线）时不响应 Tab 快捷键
      if (store.mode === null) return
      const target = event.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (event.key === 'Escape' && !keyModalOpen) {
        store.setTab('encrypt')
        return
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return
      const index = Number.parseInt(event.key, 10)
      if (Number.isInteger(index) && index >= 1 && index <= TAB_ORDER.length) {
        store.setTab(TAB_ORDER[index - 1])
      }
    }
    const onThemeShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        store.setTheme(store.theme === 'dark' ? 'light' : 'dark')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keydown', onThemeShortcut)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keydown', onThemeShortcut)
    }
  }, [store, keyModalOpen])

  // 还没选加密路线 → 先显示开始页
  if (mode === null) {
    return (
      <>
        <StartScreen />
        <LockScreen />
      </>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:px-5 sm:py-6">
      <header className="xq-panel flex flex-wrap items-center gap-3 p-4">
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
            data-testid="mode-switch"
            onClick={() => store.setMode(null)}
          >
            {t('start.switch')}
          </button>
          <button
            type="button"
            className="xq-btn text-xs"
            title={t('lock.buttonHint')}
            data-testid="lock-now"
            onClick={() => store.lockNow()}
          >
            {t('lock.button')}
          </button>
          <button
            type="button"
            className="xq-btn text-xs"
            title={t('theme.toggle')}
            onClick={() => store.setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? `☾ ${t('theme.light')}` : `☀ ${t('theme.dark')}`}
          </button>
          <button
            type="button"
            className="xq-btn text-xs"
            title={t('lang.toggle')}
            onClick={() => store.setLang(lang === 'zh' ? 'en' : 'zh')}
          >
            {lang === 'zh' ? 'EN' : '中文'}
          </button>
          <a
            className="xq-btn text-xs"
            href="./docs/index.html"
            target="_blank"
            rel="noopener noreferrer"
            title={t('nav.docs')}
          >
            {t('nav.docs')}
          </a>
        </div>
      </header>

      {/* 自研路线：五个入口 + 状态页（SPEC §5 阶段五），与简单加密的页签完全独立 */}
      {mode === 'self' ? (
        <Suspense fallback={<div className="xq-panel p-4 text-sm xq-muted">{t('sc.loading')}</div>}>
          {selfTab === 'home' ? <SelfHome /> : null}
          {selfTab === 'file' ? <SelfFilePage /> : null}
          {selfTab === 'decrypt' ? <SelfDecryptPage /> : null}
          {selfTab === 'watermark' ? <SelfWatermarkPage /> : null}
          {selfTab === 'ai' ? <SelfAiPage /> : null}
          {selfTab === 'status' ? <SelfStatusPage /> : null}
        </Suspense>
      ) : (
        <>
          <nav className="xq-panel flex gap-1 p-1.5" role="tablist" aria-label="main">
            {TAB_ORDER.map((key, index) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className="xq-tab flex-1"
                data-active={tab === key}
                onClick={() => store.setTab(key)}
              >
                <span className="xq-mono mr-1 text-[10px] opacity-60">{index + 1}</span>
                {t(`tab.${key}` as `tab.${TabKey}`)}
              </button>
            ))}
          </nav>

          <main className="flex-1">
            {tab === 'encrypt' ? <EncryptTab /> : null}
            {tab === 'decrypt' ? <DecryptTab /> : null}
            {tab === 'text' ? <TextTab /> : null}
            {tab === 'tools' ? <ToolsTab /> : null}
          </main>
        </>
      )}

      <footer className="space-y-2">
        <Alert tone="warn">{t('compliance')}</Alert>
        <p className="text-center text-[11px] xq-muted">{t('footer.note')}</p>
      </footer>

      <KeyModal />
      <LockScreen />
    </div>
  )
}

export default App
