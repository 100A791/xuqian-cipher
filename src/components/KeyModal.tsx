/**
 * 密钥一次性展示弹窗 —— 本项目最高优先级的安全交互。
 *
 * 行为约定（对应验收标准 13–20）：
 * 1) 加密完成后必须先弹出本弹窗，且不能直接跳过。
 * 2) 顶部固定红色警告：只显示一次、关闭即销毁、丢失无法恢复。
 * 3) 展示 Hex / Base64 / 指纹，并提供复制与 .XUQIANKEY 下载。
 * 4) 弹窗打开时默认选中密钥文本，方便直接 Ctrl+C。
 * 5) 未复制且未下载时点击关闭 → 必须二次确认。
 * 6) 确认关闭后：命令 Worker 覆写主密钥 → 清空弹窗状态 → 卸载 DOM → 无法再次打开。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useApp } from '../app/store.ts'
import { copyText, clearClipboard, saveText, formatBytes } from '../app/utils.ts'
import { buildPlainKeyFile, buildProtectedKeyFile, serializeKeyFile, KEYFILE_WARNING } from '../crypto/keyfile.ts'
import { combineShares, decodeShare, encodeShare, splitSecret, type ShamirShare } from '../crypto/shamir.ts'
import { randomBytes } from '../crypto/keys.ts'
import { bytesToHex } from '../crypto/encoding.ts'
import { cryptoClient } from '../worker/client.ts'
import { Alert, Field, Label } from './ui.tsx'
import { PassphraseMeter } from './PassphraseMeter.tsx'
import { EXT_KEYFILE, encryptedFileName } from '../crypto/container.ts'

export function KeyModal() {
  const t = useApp((s) => s.t)
  const modal = useApp((s) => s.keyModal)
  const closeKeyModal = useApp((s) => s.closeKeyModal)
  const patchKeyModal = useApp((s) => s.patchKeyModal)
  const clipboardClear = useApp((s) => s.clipboardClear)
  const logEvent = useApp((s) => s.logEvent)

  const keyRef = useRef<HTMLTextAreaElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const destroyedRef = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [usePassword, setUsePassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shamirM, setShamirM] = useState(3)
  const [shamirN, setShamirN] = useState(5)
  const [shares, setShares] = useState<string[]>([])

  const view = modal.view
  const copied = modal.copiedHex || modal.copiedBase64
  // 注意：关闭是否跳过二次确认始终以 store 最新值为准（见 requestClose），
  // 这里的 copied/downloaded 仅用于渲染状态提示。

  // 打开时默认选中密钥，便于直接复制；同时重置"已销毁"标记
  // （必须重置：KeyModal 组件常驻，若不复位，第二次加密后将无法关闭弹窗）
  useEffect(() => {
    if (!modal.open || !view) return
    destroyedRef.current = false
    setConfirming(false)
    setError(null)
    const node = keyRef.current
    if (node) {
      node.focus()
      node.select()
    }
  }, [modal.open, view])

  // 生成二维码（二维码只在弹窗内显示，关闭后 canvas 一起销毁）
  useEffect(() => {
    if (!modal.open || !view || !canvasRef.current) return
    const payload = `XUQIANKEY:${view.hex}:${view.fingerprint}`
    void QRCode.toCanvas(canvasRef.current, payload, {
      width: 168,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0a0e17', light: '#f7f4ee' },
    })
  }, [modal.open, view])

  const keyFileName = useMemo(() => {
    const base = modal.contextLabel ? modal.contextLabel.replace(/\.XUQIAN$/i, '') : 'xuqian'
    return `${base}${EXT_KEYFILE}`
  }, [modal.contextLabel])

  if (!modal.open) return null

  const markCopied = (which: 'hex' | 'base64') => {
    patchKeyModal(which === 'hex' ? { copiedHex: true } : { copiedBase64: true })
    if (clipboardClear) {
      // 可选：10 秒后尝试清除剪贴板（浏览器要求页面仍然聚焦）
      setTimeout(() => {
        void clearClipboard()
      }, 10_000)
    }
  }

  const downloadKeyFile = async () => {
    if (!view) return
    setError(null)
    setBusy(true)
    try {
      if (usePassword) {
        if (password.length < 8) throw new Error('KEYFILE_PASSWORD_REQUIRED')
        if (password !== password2) throw new Error('KEYFILE_PASSWORD_REQUIRED')
      }
      const payload = {
        keyHex: view.hex,
        keyB64: view.base64,
        fingerprint: view.fingerprint,
        layers: modal.layers,
        createdAt: Date.now(),
        chunkSize: modal.chunkSize,
        gzip: modal.gzip,
        warning: KEYFILE_WARNING,
      }
      const file = usePassword ? await buildProtectedKeyFile(payload, password) : buildPlainKeyFile(payload)
      saveText(serializeKeyFile(file), keyFileName, 'application/json;charset=utf-8')
      patchKeyModal({ downloaded: true })
      logEvent('keyGen', `导出密钥文件 ${keyFileName}${usePassword ? '（密码保护）' : ''}`)
      setPassword('')
      setPassword2('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'UNKNOWN'
      setError(message === 'KEYFILE_PASSWORD_REQUIRED' ? t('key.passwordWeak') : t('error.UNKNOWN'))
    } finally {
      setBusy(false)
    }
  }

  const downloadQr = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${modal.contextLabel || 'xuqian'}.key-qr.png`
      anchor.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const generateShares = () => {
    if (!view) return
    setError(null)
    const m = Math.max(2, Math.min(shamirM, shamirN))
    const n = Math.max(m, Math.min(shamirN, 10))
    try {
      const secret = hexToBytesLocal(view.hex)
      const parts: ShamirShare[] = splitSecret(secret, m, n, (len) => randomBytes(len))
      // 自检：确保任意 M 份都能恢复（防止实现错误导致用户丢密钥）
      const restored = combineShares(parts.slice(0, m))
      if (bytesToHex(restored) !== view.hex.toLowerCase()) throw new Error('SHAMIR_SELFTEST_FAILED')
      setShares(parts.map((share) => encodeShare(share, n, m)))
      logEvent('shamir', `生成 ${n} 份分片，门限 ${m}`)
    } catch {
      setError(t('error.UNKNOWN'))
    }
  }

  const downloadShares = () => {
    if (shares.length === 0) return
    const body = [
      `XUQIAN Shamir 分片 — ${modal.contextLabel || 'key'}`,
      `指纹: ${view?.fingerprint ?? ''}`,
      `门限: 任意 ${shamirM} 份可恢复，共 ${shares.length} 份`,
      `生成时间: ${new Date().toISOString()}`,
      '',
      '警告：这些分片等同于主密钥。请分发给不同保管人，切勿集中存放！',
      '',
      ...shares.flatMap((share, index) => [`# 分片 ${index + 1}/${shares.length}`, share, '']),
    ].join('\n')
    saveText(body, `${modal.contextLabel || 'xuqian'}.shards.txt`)
    patchKeyModal({ downloaded: true })
  }

  const finalizeClose = () => {
    if (destroyedRef.current) return
    destroyedRef.current = true
    setShares([])
    setPassword('')
    setPassword2('')
    setError(null)
    setConfirming(false)
    // 1) 立即命令 Worker 覆写主密钥并释放引用（fire-and-forget，绝不让 UI 等待 Worker 往返）。
    //    消息按序处理，因此这条 destroy 一定在后续任何请求之前生效。
    cryptoClient.destroyKeySync()
    // 2) 立即清空弹窗状态（含一次性文本视图）→ 卸载弹窗 DOM
    closeKeyModal()
    logEvent('keyDestroy', '关闭密钥弹窗并销毁主密钥', 'warn')
    // 3) 随后仍等待一次确认（仅用于确保 Worker 侧确实处理完毕），不阻塞 UI
    void cryptoClient.destroyKey()
  }

  const requestClose = () => {
    // 从 store 直接读取最新状态，避免"刚复制完就点关闭"时拿到过期的渲染快照
    const latest = useApp.getState().keyModal
    if (latest.copiedHex || latest.copiedBase64 || latest.downloaded) {
      finalizeClose()
    } else {
      setConfirming(true)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      style={{ background: 'rgba(3, 5, 10, 0.72)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="xq-key-title"
    >
      <div
        className="xq-panel max-h-[95vh] w-full overflow-y-auto rounded-b-none p-4 sm:max-w-3xl sm:rounded-xl sm:p-5"
        style={{ borderColor: 'color-mix(in srgb, var(--seal) 60%, transparent)' }}
      >
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="xq-key-title" className="text-base font-semibold">
              {t('key.title')}
            </h2>
            <p className="mt-0.5 text-[11px] xq-muted">
              {t('key.fingerprint.hint')} · {t('key.tipAfter')}
            </p>
          </div>
          <div className="xq-seal h-12 w-12 shrink-0 text-[10px] leading-tight">许七安</div>
        </header>

        <Alert tone="danger" title={t('common.warning')}>
          <strong>{t('key.warning')}</strong>
        </Alert>

        {view ? (
          <div className="mt-4 space-y-4">
            <div>
              <Label hint={`SHA-256 · ${formatBytes(view.bytes)}`}>{t('key.hex')}</Label>
              <textarea
                ref={keyRef}
                readOnly
                rows={1}
                value={view.hex}
                className="xq-textarea xq-mono text-base tracking-widest"
                onFocus={(event) => event.currentTarget.select()}
                spellCheck={false}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="xq-btn"
                  onClick={async () => {
                    if (await copyText(view.hex)) markCopied('hex')
                  }}
                >
                  {modal.copiedHex ? `✓ ${t('common.copied')}` : t('key.copyHex')}
                </button>
                <button
                  type="button"
                  className="xq-btn"
                  onClick={async () => {
                    if (await copyText(view.base64)) markCopied('base64')
                  }}
                >
                  {modal.copiedBase64 ? `✓ ${t('common.copied')}` : t('key.copyBase64')}
                </button>
                {clipboardClear ? <span className="xq-chip">{t('key.copyClearOn')}</span> : null}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>{t('key.base64')}</Label>
                <textarea readOnly rows={1} value={view.base64} className="xq-textarea xq-mono" spellCheck={false} />
              </div>
              <div>
                <Label>{t('key.fingerprint')}</Label>
                <div className="xq-input xq-mono text-sm" aria-readonly="true">
                  {view.fingerprint}
                </div>
                <div className="mt-1 text-[11px] xq-muted">{t('key.fingerprint.hint')}</div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[auto,1fr]">
              <div className="xq-card flex flex-col items-center gap-2 p-3">
                <canvas ref={canvasRef} className="rounded-md" width={168} height={168} />
                <div className="text-center text-[10px] xq-muted">{t('key.qrHint')}</div>
                <button type="button" className="xq-btn text-[11px]" onClick={downloadQr}>
                  {t('common.download')} PNG
                </button>
              </div>

              <div className="space-y-3">
                <div className="xq-card space-y-2 p-3">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={usePassword}
                      onChange={(event) => setUsePassword(event.target.checked)}
                    />
                    {t('key.protect')}
                  </label>
                  {usePassword ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label={t('key.password')} hint="≥ 8">
                        <input
                          type="password"
                          className="xq-input"
                          value={password}
                          autoComplete="new-password"
                          onChange={(event) => setPassword(event.target.value)}
                        />
                      </Field>
                      <Field label={t('key.passwordConfirm')}>
                        <input
                          type="password"
                          className="xq-input"
                          value={password2}
                          autoComplete="new-password"
                          onChange={(event) => setPassword2(event.target.value)}
                        />
                      </Field>
                      <PassphraseMeter password={password} className="sm:col-span-2" />
                      <p className="text-[10px] xq-muted sm:col-span-2">
                        PBKDF2-SHA256 · 600,000 次迭代 · AES-256-GCM 封装。密码丢失后密钥文件同样无法解开。
                      </p>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="xq-btn xq-btn-primary w-full"
                    disabled={busy}
                    onClick={() => void downloadKeyFile()}
                  >
                    {modal.downloaded ? `✓ ${t('key.downloaded')}` : t('key.download')}
                  </button>
                </div>

                <div className="xq-card space-y-2 p-3">
                  <div className="text-xs font-medium">{t('key.shamir')}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t('key.shamirM')}>
                      <input
                        type="number"
                        min={2}
                        max={10}
                        className="xq-input"
                        value={shamirM}
                        onChange={(event) => setShamirM(Number(event.target.value))}
                      />
                    </Field>
                    <Field label={t('key.shamirN')}>
                      <input
                        type="number"
                        min={2}
                        max={10}
                        className="xq-input"
                        value={shamirN}
                        onChange={(event) => setShamirN(Number(event.target.value))}
                      />
                    </Field>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="xq-btn text-[11px]" onClick={generateShares}>
                      {t('key.shamirGenerate')}
                    </button>
                    <button
                      type="button"
                      className="xq-btn text-[11px]"
                      disabled={shares.length === 0}
                      onClick={downloadShares}
                    >
                      {t('key.shamirDownload')}
                    </button>
                  </div>
                  {shares.length > 0 ? (
                    <div
                      className="max-h-28 space-y-1 overflow-y-auto rounded-md p-2 text-[10px] xq-mono"
                      style={{ background: 'color-mix(in srgb, var(--bg) 60%, transparent)' }}
                    >
                      {shares.map((share) => (
                        <div key={share} className="break-all">
                          {share}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {error ? <Alert tone="danger">{error}</Alert> : null}

            <Alert tone="info">
              关闭后：主密钥与全部派生子密钥会被立即覆写，salt / nonce 一并清除，网站内没有任何入口可以再次查看。
              仅在你自行保存了密钥的前提下继续。
            </Alert>
          </div>
        ) : (
          <div className="mt-4">
            <Alert tone="warn">密钥已销毁，无法再次查看。</Alert>
          </div>
        )}

        <footer className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] xq-muted">
            <span>
              {t('key.copyHex')}：{copied ? `✓ ${t('key.copied')}` : t('key.notCopied')}
            </span>
            <span>
              {EXT_KEYFILE}：{modal.downloaded ? `✓ ${t('key.downloaded')}` : t('key.notCopied')}
            </span>
          </div>
          <button type="button" className="xq-btn xq-btn-primary" onClick={requestClose}>
            {t('key.close')}
          </button>
        </footer>

        {confirming ? (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
            style={{ background: 'rgba(3, 5, 10, 0.8)' }}
          >
            <div className="xq-panel xq-danger-panel max-w-md p-4">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--seal-bright)' }}>
                {t('key.confirmTitle')}
              </h3>
              <p className="mt-2 text-xs leading-relaxed">{t('key.confirmBody')}</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" className="xq-btn" onClick={() => setConfirming(false)}>
                  {t('common.cancel')}
                </button>
                <button type="button" className="xq-btn xq-btn-primary" onClick={finalizeClose}>
                  {t('key.confirmClose')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.trim()
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export { encryptedFileName, decodeShare }
