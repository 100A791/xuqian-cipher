/** 文件加密页（对应 SPEC §2 的 file_page.js）。走自研格式，与「简单加密」的 .xuqian 格式互不通用。 */
import { useRef, useState } from 'react'
import { useApp } from '../../app/store.ts'
import { Alert, Field, Progress, Stat } from '../ui.tsx'
import { isAvailable, saveCiphertext } from '../../selfcrypto/storage/indexeddb.js'
import { downloadBytes, describeFailure, fileToBytes } from './browser.ts'
import { runEncrypt, supportsWorker, type ProgressEvent, type RunHandle } from './selfWorkerClient.ts'
import { SelfShell } from './SelfShell.tsx'

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export function SelfFilePage() {
  const t = useApp((s) => s.t)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveLocal, setSaveLocal] = useState(false)
  const [savedLocal, setSavedLocal] = useState(false)
  const [phase, setPhase] = useState<ProgressEvent | null>(null)
  const [percent, setPercent] = useState(0)
  const [cancelled, setCancelled] = useState(false)
  const [result, setResult] = useState<{ keyHex: string; name: string; outputName: string; size: number; outputSize: number } | null>(null)
  const handleRef = useRef<RunHandle<{ cipherBytes: Uint8Array; keyK: Uint8Array }> | null>(null)

  const onProgress = (p: ProgressEvent) => {
    setPhase(p)
    // 只有分块变换这一段有真实的"已处理/总量"；其它阶段不编造百分比
    if (p.phase === 'cipher') setPercent(Math.round((p.done / p.total) * 100))
  }

  const run = async () => {
    if (!file) {
      setError(t('sc.err.needFile'))
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    setSavedLocal(false)
    setCancelled(false)
    setPhase(null)
    setPercent(0)
    try {
      const bytes = await fileToBytes(file)
      const handle = runEncrypt(
        bytes,
        { name: file.name, mime: file.type || 'application/octet-stream', created: Math.floor(file.lastModified / 1000) },
        onProgress,
      )
      handleRef.current = handle
      const { cipherBytes, keyK } = await handle.promise
      setPercent(100)
      downloadBytes(cipherBytes, `${file.name}.xuqian`)
      // 存本地密文库：只落**密文**，密钥不落库（SPEC §7 红线，storage/indexeddb.js 里有白名单强制）
      if (saveLocal && isAvailable()) {
        await saveCiphertext({ name: `${file.name}.xuqian`, bytes: cipherBytes, version: 1 })
        setSavedLocal(true)
      }
      setResult({
        keyHex: hex(keyK),
        name: file.name,
        outputName: `${file.name}.xuqian`,
        size: bytes.length,
        outputSize: cipherBytes.length,
      })
    } catch (e) {
      setError(describeFailure(e))
    } finally {
      handleRef.current = null
      setBusy(false)
      setPhase(null)
    }
  }

  const cancel = () => {
    const cancelledOk = handleRef.current?.cancel() ?? false
    setCancelled(cancelledOk)
    if (cancelledOk) {
      setBusy(false)
      setPhase(null)
    }
  }

  return (
    <SelfShell title={t('sc.file.title')} description={t('sc.file.desc')}>
      <Field label={t('sc.file.pick')}>
        <input
          type="file"
          className="xq-input"
          data-testid="sc-file-input"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null)
            setResult(null)
            setError(null)
          }}
        />
      </Field>

      {isAvailable() ? (
        <label className="flex items-center gap-2 text-[12px]" data-testid="sc-file-save-local-label">
          <input
            type="checkbox"
            data-testid="sc-file-save-local"
            checked={saveLocal}
            onChange={(event) => setSaveLocal(event.target.checked)}
          />
          {t('sc.file.saveLocal')}
        </label>
      ) : null}

      {/* 如实告知速度：实测约 1.8–2 MB/s（浏览器 1.82 / Node 1.93~2.04），预估用 1.8。超过 2MB 就提前说，别让用户干等。 */}
      {file && file.size > 2 * 1024 * 1024 ? (
        <Alert tone="warn" data-testid="sc-file-slow-warn">
          {t('sc.file.slowWarn')} ~{Math.ceil(file.size / 1024 / 1024 / 1.8)} s（{(file.size / 1024 / 1024).toFixed(1)} MB）
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="xq-btn w-fit" data-testid="sc-file-run" disabled={busy || !file} onClick={run}>
          {busy ? t('sc.working') : t('sc.file.run')}
        </button>
        {busy ? (
          <button type="button" className="xq-btn" data-testid="sc-file-cancel" onClick={cancel}>
            {t('sc.file.cancel')}
          </button>
        ) : null}
      </div>

      {/* 进度：只在真有"已处理/总量"的阶段显示百分比，其它阶段只显示阶段名 */}
      {busy ? (
        <div className="flex flex-col gap-1">
          <Progress
            value={percent}
            label={`${t('sc.working')} ${phase ? t(`sc.phase.${phase.phase}` as 'sc.phase.setup') : ''}${
              phase?.phase === 'cipher' ? `（${phase.done}/${phase.total}）` : ''
            }`}
          />
          <p className="text-[11px] xq-muted">
            {supportsWorker() ? t('sc.file.workerNote') : t('sc.file.noWorkerNote')}
          </p>
        </div>
      ) : null}

      {cancelled ? <Alert tone="info">{t('sc.file.cancelled')}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {savedLocal ? <Alert tone="info">{t('sc.file.savedLocal')}</Alert> : null}

      {result ? (
        <div className="flex flex-col gap-2" data-testid="sc-file-result">
          <Alert tone="warn">{t('sc.file.keyWarning')}</Alert>
          <div className="grid gap-2 sm:grid-cols-2">
            <Stat label={t('sc.file.key')} value={result.keyHex} mono />
            <Stat label={t('sc.file.output')} value={result.outputName} mono />
            <Stat label={t('sc.file.plainSize')} value={`${result.size}`} />
            <Stat label={t('sc.file.cipherSize')} value={`${result.outputSize}`} />
          </div>
        </div>
      ) : null}
    </SelfShell>
  )
}
