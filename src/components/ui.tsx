/** 共享 UI 组件：拖拽区、进度条、字段、告警等等。 */
import { useCallback, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { useApp } from '../app/store.ts'
import { collectDroppedFiles, copyText, type DroppedEntry } from '../app/utils.ts'

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`xq-panel p-4 sm:p-5 ${className}`}>{children}</section>
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span className="shrink-0 whitespace-nowrap text-xs font-medium tracking-wide" style={{ color: 'var(--text-dim)' }}>
        {children}
      </span>
      {hint ? <span className="min-w-0 truncate text-right text-[11px] xq-muted">{hint}</span> : null}
    </div>
  )
}

export function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="space-y-1">
      {label ? (
        <div className="flex items-center justify-between text-[11px] xq-muted">
          <span>{label}</span>
          <span className="xq-mono">{Math.round(value)}%</span>
        </div>
      ) : null}
      <div className="xq-progress" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  )
}

export function Alert({
  tone = 'info',
  title,
  children,
  ...rest
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok'
  title?: ReactNode
  children?: ReactNode
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  const palette: Record<string, { border: string; bg: string; color: string }> = {
    info: { border: 'var(--panel-border)', bg: 'color-mix(in srgb, var(--panel) 60%, transparent)', color: 'var(--text)' },
    warn: { border: 'color-mix(in srgb, var(--accent) 60%, transparent)', bg: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--text)' },
    danger: { border: 'color-mix(in srgb, var(--seal) 70%, transparent)', bg: 'color-mix(in srgb, var(--seal) 16%, transparent)', color: 'var(--text)' },
    ok: { border: 'color-mix(in srgb, var(--jade) 60%, transparent)', bg: 'color-mix(in srgb, var(--jade) 12%, transparent)', color: 'var(--text)' },
  }
  const toneStyle = palette[tone]
  return (
    // ...rest 必须透传：否则调用方传的 data-testid 会被静默丢弃，
    // 测试里就会变成"元素找不到"这种很难查的现象（已经踩过一次）。
    <div
      {...rest}
      className="rounded-lg px-3 py-2 text-xs leading-relaxed"
      style={{ border: `1px solid ${toneStyle.border}`, background: toneStyle.bg, color: toneStyle.color }}
    >
      {title ? <div className="mb-0.5 font-semibold">{title}</div> : null}
      {children}
    </div>
  )
}

export function CopyButton({ text, label, onCopied }: { text: string; label: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false)
  const t = useApp((s) => s.t)
  return (
    <button
      type="button"
      className="xq-btn"
      onClick={async () => {
        const ok = await copyText(text)
        setDone(ok)
        if (ok) onCopied?.()
        setTimeout(() => setDone(false), 1800)
      }}
    >
      {done ? t('common.copied') : `${t('common.copy')} ${label}`}
    </button>
  )
}

export function DropZone({
  onFiles,
  disabled,
  children,
}: {
  onFiles: (entries: DroppedEntry[]) => void
  disabled?: boolean
  children?: ReactNode
}) {
  const t = useApp((s) => s.t)
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      onFiles(Array.from(files).map((file) => ({ file, path: file.webkitRelativePath || file.name })))
    },
    [onFiles],
  )

  return (
    <div
      className="rounded-xl border-2 border-dashed px-4 py-6 text-center transition"
      style={{
        borderColor: over ? 'var(--accent)' : 'var(--panel-border)',
        background: over ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
        opacity: disabled ? 0.5 : 1,
      }}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (event) => {
        event.preventDefault()
        setOver(false)
        if (disabled) return
        const entries = await collectDroppedFiles(event.dataTransfer)
        if (entries.length > 0) onFiles(entries)
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
      }}
    >
      <input
        id={id}
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        // 视觉上隐藏但仍可被 AT 发现，必须给可访问名（无障碍审计抓到的缺口）
        aria-label={t('drop.hint')}
        onChange={(event) => {
          handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <div className="space-y-1">
        <div className="text-sm font-medium">{t('drop.hint')}</div>
        <div className="text-[11px] xq-muted">{t('drop.subhint')}</div>
      </div>
      {children}
      <button
        type="button"
        className="xq-btn xq-btn-ghost mt-3 text-[11px]"
        onClick={(event) => {
          event.stopPropagation()
          const picker = document.createElement('input')
          picker.type = 'file'
          ;(picker as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true
          picker.multiple = true
          picker.onchange = () => {
            handleFiles(picker.files)
          }
          picker.click()
        }}
      >
        {t('common.select')} · 文件夹
      </button>
    </div>
  )
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  // 用 <label> 把说明文字与控件**程序化关联**（隐式关联，不需要 id）。
  // 原来是 <div> + 一段文字，屏幕阅读器读不出这个控件叫什么 —— 这是无障碍审计抓到的真问题
  // （WCAG 1.3.1 信息与关系 / 4.1.2 名称角色值）。label 的内容模型是 phrasing content，
  // 所以这里不用会渲染成 div 的 <Label>，直接内联 span 排版。
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="shrink-0 whitespace-nowrap text-xs font-medium tracking-wide" style={{ color: 'var(--text-dim)' }}>
          {label}
        </span>
        {hint ? <span className="min-w-0 truncate text-right text-[11px] xq-muted">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}

export function Stat({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[11px] xq-muted">{label}</span>
      <span className={`text-[11px] ${mono ? 'xq-mono' : ''}`}>{value}</span>
    </div>
  )
}
