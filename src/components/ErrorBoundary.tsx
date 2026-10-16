/**
 * 全局错误边界。
 *
 * 为什么必须有：本站是加密工具。React 在渲染期抛异常时会卸载整棵树 → 用户看到白屏，
 * 而白屏**无法区分**「界面崩了」与「密钥被销毁了」。把这层说清楚是安全体验的一部分，
 * 不是装饰。
 *
 * 设计取舍：
 * - 故意**不**依赖 `useApp` / `i18n` / `ui.tsx`：崩溃可能就源自 store 或共享组件，
 *   此时再去读它们只会二次抛错。因此文案在本文件内自足（中文为主 + 一行英文）。
 * - 崩溃页只做只读陈述 + 两个动作，不尝试"自动恢复"，避免掩盖真实故障。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null; info: ErrorInfo | null; confirmingReload: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, confirmingReload: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 只写控制台：本站不发送任何网络请求，错误绝不上报。
    console.error('[XUQIAN] 界面渲染出错：', error, info.componentStack)
    this.setState({ info })
  }

  private retry = () => {
    this.setState({ error: null, info: null, confirmingReload: false })
  }

  private reload = () => {
    if (!this.state.confirmingReload) {
      this.setState({ confirmingReload: true })
      return
    }
    window.location.reload()
  }

  render() {
    const { error, info, confirmingReload } = this.state
    if (!error) return this.props.children

    return (
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 px-3 py-8 sm:px-5">
        <section className="xq-danger-panel space-y-3 p-5">
          <h1 className="text-lg font-semibold">界面出错了</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Something went wrong in the interface. Your files were never uploaded.
          </p>

          <div className="space-y-2 text-sm">
            <p>
              <strong>先说结论：这不等于你的密钥没了。</strong>
              主密钥只存在于加密 Worker 的内存里。界面崩溃既不会把它写入磁盘，也不会把它上传 —— 本站没有任何网络请求。
            </p>
            <p>
              <strong>如果你刚加密完、还没保存密钥：先别刷新。</strong>
              点下面的「重试」有机会把界面恢复回来，密钥仍在 Worker 中。
            </p>
            <p>
              <strong>正在进行的加密/解密已中断</strong>，但此前已经下载到磁盘的文件不受影响。
            </p>
            <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
              刷新页面 = 彻底销毁密钥且<strong>无法恢复</strong>。仅在确认密钥已备份、
              或本次操作不涉及未备份的新密钥时使用。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" className="xq-btn xq-btn-primary text-xs" onClick={this.retry}>
              重试渲染
            </button>
            <button type="button" className="xq-btn text-xs" onClick={this.reload}>
              {confirmingReload ? '确认刷新（将销毁密钥）' : '刷新页面…'}
            </button>
            {confirmingReload ? (
              <button
                type="button"
                className="xq-btn xq-btn-ghost text-xs"
                onClick={() => this.setState({ confirmingReload: false })}
              >
                取消
              </button>
            ) : null}
          </div>
        </section>

        <section className="xq-panel p-4">
          <details>
            <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-dim)' }}>
              技术细节（截图反馈时可一并提供）
            </summary>
            <pre className="xq-mono mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-[11px]">
              {String(error?.message || error)}
              {'\n\n'}
              {error?.stack || '(无堆栈)'}
              {info?.componentStack ? `\n\n组件栈：${info.componentStack}` : ''}
            </pre>
          </details>
        </section>

        <p className="text-center text-[11px]" style={{ color: 'var(--text-dim)' }}>
          本网站仅用于合法合规的文件加密与隐私保护。密钥不落盘、不上传，丢失后无法恢复。
        </p>
      </div>
    )
  }
}
