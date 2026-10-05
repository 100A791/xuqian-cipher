/**
 * 解密页（对应 SPEC §2 的 decrypt_page.js）。
 * 密文有两个来源：本地文件，或**本地密文库**（IndexedDB，SPEC §5 阶段六「数据存本地」）。
 * 失败由内核统一归一，界面只显示同一句话。
 */
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../app/store.ts'
import { Alert, Field, Progress, Stat } from '../ui.tsx'
import { checkKey } from '../../selfcrypto/file/decrypt.js'
import {
  deleteCiphertext,
  exportAllCiphertexts,
  importCiphertextsFromArchive,
  isAvailable,
  libraryUsage,
  listCiphertexts,
  loadCiphertext,
} from '../../selfcrypto/storage/indexeddb.js'
import { downloadBytes, describeFailure, fileToBytes, formatBytes } from './browser.ts'
import { runDecrypt, type ProgressEvent, type RunHandle } from './selfWorkerClient.ts'
import { SelfShell } from './SelfShell.tsx'

const fromHex = (text: string) => {
  const clean = text.trim().toLowerCase().replace(/[^0-9a-f]/g, '')
  if (clean.length !== 32) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

interface LibraryItem {
  id: string
  name: string
  size: number
  savedAt: number
}

export function SelfDecryptPage() {
  const t = useApp((s) => s.t)
  const [source, setSource] = useState<{ name: string; bytes: Uint8Array; from: 'file' | 'library' } | null>(null)
  const [keyText, setKeyText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ name: string; size: number; keyOk: boolean | null } | null>(null)
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [libraryReady, setLibraryReady] = useState(false)
  const [phase, setPhase] = useState<ProgressEvent | null>(null)
  const [percent, setPercent] = useState(0)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ records: number; bytes: number; usage: number | null; quota: number | null; ratio: number | null; nearQuota: boolean } | null>(null)
  const handleRef = useRef<RunHandle<{ plainBytes: Uint8Array; metadata: Map<string, unknown> }> | null>(null)

  const refreshLibrary = async () => {
    if (!isAvailable()) {
      setLibraryReady(false)
      return
    }
    try {
      setLibrary(await listCiphertexts())
      // 用量汇总：让用户知道"库里多少、占配额多少"（接近上限时要提前说，见 D38）
      setUsage(await libraryUsage())
      setLibraryReady(true)
    } catch {
      setLibraryReady(false)
    }
  }

  useEffect(() => {
    void refreshLibrary()
  }, [])

  const pickFile = async (file: File | undefined) => {
    setResult(null)
    setError(null)
    if (!file) {
      setSource(null)
      return
    }
    try {
      setSource({ name: file.name, bytes: await fileToBytes(file), from: 'file' })
    } catch (e) {
      setError(describeFailure(e))
    }
  }

  const pickFromLibrary = async (item: LibraryItem) => {
    setResult(null)
    setError(null)
    try {
      const record = await loadCiphertext(item.id)
      setSource({ name: record.name, bytes: record.bytes, from: 'library' })
    } catch (e) {
      setError(describeFailure(e))
    }
  }

  const removeFromLibrary = async (item: LibraryItem) => {
    try {
      await deleteCiphertext(item.id)
      if (source?.from === 'library' && source.name === item.name) setSource(null)
      await refreshLibrary()
    } catch (e) {
      setError(describeFailure(e))
    }
  }

  const runExport = async () => {
    setBackupMessage(null)
    try {
      const archive = await exportAllCiphertexts()
      downloadBytes(archive, 'xuqian-library-backup.xqlib')
      setBackupMessage(`${t('sc.decrypt.exported')}：${library.length}`)
    } catch (e) {
      setError(describeFailure(e))
    }
  }

  const runImport = async (file: File | undefined) => {
    if (!file) return
    setBackupMessage(null)
    setError(null)
    try {
      const saved = await importCiphertextsFromArchive(await fileToBytes(file))
      await refreshLibrary()
      setBackupMessage(`${t('sc.decrypt.imported')}：${saved}`)
    } catch (e) {
      // 备份文件损坏属"用户可自行判断"的问题，可以给具体原因；密码学失败仍走统一文案
      setError(e instanceof Error ? e.message : describeFailure(e))
    }
  }

  const run = async () => {
    if (!source) {
      setError(t('sc.err.needFile'))
      return
    }
    const key = fromHex(keyText)
    if (!key) {
      setError(t('sc.err.needKey'))
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    setPercent(0)
    setPhase(null)
    try {
      // 走 Worker：解密同样可能很慢（大文件要逐块 CTR），不能卡住界面
      const handle = runDecrypt(source.bytes, key, (p) => {
        setPhase(p)
        if (p.phase === 'cipher') setPercent(Math.round((p.done / p.total) * 100))
      })
      handleRef.current = handle
      const outcome = await handle.promise
      setPercent(100)
      const name = String(outcome.metadata.get('name') ?? 'restored.bin')
      downloadBytes(outcome.plainBytes, name)
      setResult({ name, size: outcome.plainBytes.length, keyOk: true })
    } catch (e) {
      setError(describeFailure(e))
    } finally {
      handleRef.current = null
      setBusy(false)
      setPhase(null)
    }
  }

  const cancel = () => {
    if (handleRef.current?.cancel()) {
      setBusy(false)
      setPhase(null)
      setError(null)
    }
  }

  const runCheck = async () => {
    if (!source) {
      setError(t('sc.err.needFile'))
      return
    }
    const key = fromHex(keyText)
    if (!key) {
      setError(t('sc.err.needKey'))
      return
    }
    try {
      setResult({ name: '', size: 0, keyOk: checkKey(source.bytes, key) })
      setError(null)
    } catch (e) {
      setError(describeFailure(e))
    }
  }

  return (
    <SelfShell title={t('sc.decrypt.title')} description={t('sc.decrypt.desc')}>
      <Field label={t('sc.decrypt.pick')}>
        <input type="file" className="xq-input" data-testid="sc-decrypt-input" onChange={(e) => void pickFile(e.target.files?.[0])} />
      </Field>

      {libraryReady ? (
        <div className="flex flex-col gap-2" data-testid="sc-decrypt-library">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-semibold">{t('sc.decrypt.library')}</span>
            <button type="button" className="xq-btn" data-testid="sc-decrypt-lib-refresh" onClick={() => void refreshLibrary()}>
              {t('sc.decrypt.refresh')}
            </button>
          </div>
          {library.length === 0 ? (
            <p className="text-[11px] xq-muted" data-testid="sc-decrypt-lib-empty">
              {t('sc.decrypt.libraryEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {library.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="sc-decrypt-lib-item">
                  <span className="xq-mono">{item.name}</span>
                  <span className="xq-muted">{item.size} B</span>
                  <span className="xq-muted">{new Date(item.savedAt).toLocaleString()}</span>
                  <button type="button" className="xq-btn" data-testid="sc-decrypt-lib-use" onClick={() => void pickFromLibrary(item)}>
                    {t('sc.decrypt.use')}
                  </button>
                  <button type="button" className="xq-btn" data-testid="sc-decrypt-lib-delete" onClick={() => void removeFromLibrary(item)}>
                    {t('sc.decrypt.delete')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] xq-muted">{t('sc.decrypt.localNote')}</p>
          {usage ? (
            <div className="flex flex-col gap-1 text-[11px]" data-testid="sc-decrypt-usage">
              <span className="xq-muted">
                {t('sc.decrypt.usage')}：{usage.records} {t('sc.decrypt.usageValue')} {formatBytes(usage.bytes)}
              </span>
              {usage.quota ? (
                <span className="xq-muted">
                  {t('sc.decrypt.quotaValue')}：{formatBytes(usage.usage)} / {formatBytes(usage.quota)}
                  {usage.ratio !== null ? `（${(usage.ratio * 100).toFixed(1)}%）` : ''}
                </span>
              ) : null}
            </div>
          ) : null}
          {usage?.nearQuota ? <Alert tone="warn">{t('sc.decrypt.quotaWarn')}</Alert> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="xq-btn" data-testid="sc-decrypt-lib-export" onClick={() => void runExport()}>
              {t('sc.decrypt.exportLib')}
            </button>
            <label className="xq-btn" style={{ cursor: 'pointer' }}>
              {t('sc.decrypt.importLib')}
              <input
                type="file"
                accept=".xqlib"
                data-testid="sc-decrypt-lib-import"
                style={{ display: 'none' }}
                onChange={(event) => void runImport(event.target.files?.[0])}
              />
            </label>
          </div>
          <p className="text-[11px] xq-muted">{t('sc.decrypt.backupNote')}</p>
          {backupMessage ? (
            <p className="text-[11px]" data-testid="sc-decrypt-backup-message">
              {backupMessage}
            </p>
          ) : null}
        </div>
      ) : null}

      <Field label={t('sc.decrypt.key')} hint={t('sc.decrypt.keyHint')}>
        <input
          type="text"
          className="xq-input xq-mono"
          data-testid="sc-decrypt-key"
          placeholder="0123456789abcdef0123456789abcdef"
          value={keyText}
          onChange={(event) => setKeyText(event.target.value)}
        />
      </Field>

      {source ? (
        <Stat label={t('sc.decrypt.source')} value={`${source.name}（${source.from === 'library' ? t('sc.decrypt.fromLibrary') : t('sc.decrypt.fromFile')}）`} mono />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="xq-btn" data-testid="sc-decrypt-run" disabled={busy || !source} onClick={run}>
          {busy ? t('sc.working') : t('sc.decrypt.run')}
        </button>
        <button type="button" className="xq-btn" data-testid="sc-decrypt-check" disabled={!source} onClick={runCheck}>
          {t('sc.decrypt.check')}
        </button>
        {busy ? (
          <button type="button" className="xq-btn" data-testid="sc-decrypt-cancel" onClick={cancel}>
            {t('sc.file.cancel')}
          </button>
        ) : null}
      </div>

      {busy ? (
        <Progress
          value={percent}
          label={`${t('sc.working')} ${phase ? t(`sc.phase.${phase.phase}` as 'sc.phase.keycheck') : ''}${
            phase?.phase === 'cipher' ? `（${phase.done}/${phase.total}）` : ''
          }`}
        />
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {result && result.name === '' ? (
        <Alert tone={result.keyOk ? 'info' : 'danger'}>{result.keyOk ? t('sc.decrypt.keyOk') : t('sc.decrypt.keyBad')}</Alert>
      ) : null}
      {result?.name ? (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="sc-decrypt-result">
          <Stat label={t('sc.decrypt.saved')} value={result.name} mono />
          <Stat label={t('sc.decrypt.size')} value={`${result.size}`} />
        </div>
      ) : null}
    </SelfShell>
  )
}
