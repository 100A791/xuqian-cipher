/** 加密面板：算法层栈、拖拽、进度、批量、gzip、ZIP 输出。 */
import { useCallback, useMemo, useState } from 'react'
import { ALL_ALGO_IDS, ALGO_SPECS, type AlgoId } from '../crypto/aead.ts'
import { encryptedFileName } from '../crypto/container.ts'
import { defaultBanner } from '../crypto/banner.ts'
import { useApp, type QueueItem } from '../app/store.ts'
import { errorMessageKey } from '../app/i18n.ts'
import { cryptoClient } from '../worker/client.ts'
import { buildZip } from '../app/zip.ts'
import {
  baseNameOf,
  bytesToBlobPart,
  dirOf,
  formatBytes,
  formatDuration,
  saveBlob,
  sanitizeFileName,
  type DroppedEntry,
} from '../app/utils.ts'
import { Alert, DropZone, Field, Panel, Progress } from './ui.tsx'

const CHUNK_OPTIONS = [
  { label: '16 MiB', value: 16 * 1024 * 1024 },
  { label: '64 MiB（推荐）', value: 64 * 1024 * 1024 },
  { label: '256 MiB', value: 256 * 1024 * 1024 },
]

export function EncryptTab() {
  const t = useApp((s) => s.t)
  const files = useApp((s) => s.encryptFiles)
  const layers = useApp((s) => s.layers)
  const gzip = useApp((s) => s.gzip)
  const note = useApp((s) => s.note)
  const notice = useApp((s) => s.notice)
  const lang = useApp((s) => s.lang)
  const expiresAt = useApp((s) => s.expiresAt)
  const chunkSize = useApp((s) => s.chunkSize)
  const encrypting = useApp((s) => s.encrypting)
  const progress = useApp((s) => s.encryptProgress)
  const store = useApp()
  const [error, setError] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<{ count: number; ms: number; bytes: number } | null>(null)

  const totalSize = useMemo(() => files.reduce((sum, item) => sum + item.size, 0), [files])

  const addEntries = useCallback(
    (entries: DroppedEntry[]) => {
      const existing = new Set(files.map((item) => item.path))
      const next: QueueItem[] = [...files]
      for (const entry of entries) {
        if (existing.has(entry.path)) continue
        existing.add(entry.path)
        next.push({
          id: `${entry.path}-${entry.file.size}-${entry.file.lastModified}`,
          name: entry.file.name,
          path: entry.path,
          size: entry.file.size,
          status: 'pending',
          progress: 0,
          fileRef: entry.file,
        })
      }
      store.setEncryptFiles(next)
      setError(null)
    },
    [files, store],
  )

  const runEncryption = async () => {
    if (files.length === 0) return
    setError(null)
    setLastRun(null)
    store.setEncrypting(true)
    store.setEncryptProgress(0)
    const started = performance.now()
    let written = 0

    try {
      // 1) 生成一次性 128 位主密钥（此时才开始，确保密钥生命周期尽量短）
      const { fingerprint } = await cryptoClient.generateKey()
      store.logEvent('keyGen', `生成 128 位主密钥（指纹 ${fingerprint}），层数 ${layers.length}`)

      const expiresTs = expiresAt ? new Date(expiresAt).getTime() : undefined
      const targets = files.filter((item) => item.status !== 'done' || !item.outputBlob)
      const list = targets.length > 0 ? targets : files

      // 2) 逐文件加密（共用同一主密钥 → 只弹一次密钥弹窗）
      for (let index = 0; index < list.length; index++) {
        const item = list[index]
        store.patchEncryptFile(item.id, { status: 'encrypting', progress: 5, message: undefined })
        const source = files.find((f) => f.id === item.id)
        const file = source?.fileRef
        if (!file) {
          // 从队列重建 File 需要原始引用；这里使用路径匹配过的 File（由 addEntries 保存）
          store.patchEncryptFile(item.id, { status: 'error', message: t('error.file') })
          continue
        }
        const buffer = await file.arrayBuffer()
        const result = await cryptoClient.encrypt({
          bytes: buffer,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          layers,
          chunkSize,
          gzip,
          note: note || undefined,
          notice,
          lang,
          expiresAt: Number.isFinite(expiresTs) ? expiresTs : undefined,
          kind: 'bytes',
        })
        const outputName = encryptedFileName(item.path)
        const blob = new Blob([result.bytes], { type: 'application/octet-stream' })
        store.patchEncryptFile(item.id, {
          status: 'done',
          progress: 100,
          outputName,
          outputBlob: blob,
          message: `${formatBytes(result.outputSize)}`,
        })
        written += result.outputSize
        store.setEncryptProgress(Math.round(((index + 1) / list.length) * 100))
        // 让浏览器有机会刷新界面
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      const elapsed = performance.now() - started
      setLastRun({ count: list.length, ms: elapsed, bytes: written })
      store.logEvent('encrypt', `加密 ${list.length} 个文件，输出 ${formatBytes(written)}，耗时 ${formatDuration(elapsed)}`)

      // 3) 必须先弹出密钥展示弹窗（不可跳过）
      const view = await cryptoClient.viewKey()
      store.openKeyModal({
        view,
        fingerprint: view.fingerprint,
        copiedHex: false,
        copiedBase64: false,
        downloaded: false,
        contextLabel: list.length === 1 ? encryptedFileName(list[0].path) : `${list.length}-files`,
        layers: [...layers],
        chunkSize,
        gzip,
        expiresAt: Number.isFinite(expiresTs) ? expiresTs : undefined,
      })
    } catch (err) {
      setError(t(errorMessageKey(err)))
      store.logEvent('encrypt', `加密失败：${errorMessageKey(err)}`, 'error')
    } finally {
      store.setEncrypting(false)
    }
  }

  const downloadAll = async () => {
    const done = files.filter((item) => item.status === 'done' && item.outputBlob)
    if (done.length === 0) return
    if (done.length === 1) {
      saveBlob(done[0].outputBlob!, basenameOfOutput(done[0]), 'application/octet-stream')
      return
    }
    // 多文件：打包 ZIP 并保持目录结构
    const entries = []
    for (const item of done) {
      const bytes = new Uint8Array(await item.outputBlob!.arrayBuffer())
      entries.push({ path: sanitizePath(item.path) + '.XUQIAN', data: bytes })
    }
    const zip = buildZip(entries)
    saveBlob(bytesToBlobPart(zip), `XUQIAN-batch-${Date.now()}.zip`, 'application/zip')
    store.logEvent('encrypt', `打包下载 ${entries.length} 个文件为 ZIP`)
  }

  return (
    <div className="space-y-4">
      <Panel>
        <div className="grid gap-4 lg:grid-cols-[1.15fr,1fr]">
          <div className="space-y-3">
            <DropZone onFiles={addEntries} disabled={encrypting} />
            {files.length > 0 ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="xq-muted">
                    {t('drop.selected')}：{files.length} · {formatBytes(totalSize)}
                  </span>
                  <button type="button" className="xq-btn xq-btn-ghost text-[11px]" disabled={encrypting} onClick={() => store.setEncryptFiles([])}>
                    {t('common.clear')}
                  </button>
                </div>
                <ul className="max-h-52 space-y-1 overflow-y-auto pr-1">
                  {files.map((item) => (
                    <li key={item.id} className="xq-card flex items-center gap-2 px-2 py-1.5 text-[11px]">
                      <span className="flex-1 truncate" title={item.path}>
                        {item.path}
                      </span>
                      <span className="xq-mono xq-muted">{formatBytes(item.size)}</span>
                      <StatusChip status={item.status} progress={item.progress} detail={item.message} />
                      <button
                        type="button"
                        className="xq-btn xq-btn-ghost px-1.5 py-0.5 text-[11px]"
                        disabled={encrypting}
                        onClick={() => store.setEncryptFiles(files.filter((f) => f.id !== item.id))}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium">{t('encrypt.algorithms')}</span>
                <span className="xq-chip">
                  {t('encrypt.layers')}：{layers.length}
                </span>
              </div>
              <p className="mb-2 text-[11px] xq-muted">{t('encrypt.order')}</p>
              <ul className="space-y-1.5">
                {[...layers].reverse().map((algo, reversedIndex) => {
                  const index = layers.length - 1 - reversedIndex
                  return (
                    <li key={`${algo}-${index}`} className="xq-card flex items-center gap-2 px-2 py-1.5">
                      <span className="xq-mono w-5 text-center text-[11px] xq-muted">{index + 1}</span>
                      <select
                        className="xq-select flex-1 py-1 text-xs"
                        value={algo}
                        disabled={encrypting}
                        onChange={(event) => store.setLayerAt(index, event.target.value as AlgoId)}
                      >
                        {ALL_ALGO_IDS.map((id) => (
                          <option key={id} value={id}>
                            {ALGO_SPECS[id].label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="xq-btn xq-btn-ghost px-1.5 py-0.5 text-[11px]"
                        title={t('encrypt.moveDown')}
                        disabled={encrypting || index === 0}
                        onClick={() => store.moveLayer(index, -1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="xq-btn xq-btn-ghost px-1.5 py-0.5 text-[11px]"
                        title={t('encrypt.moveUp')}
                        disabled={encrypting || index === layers.length - 1}
                        onClick={() => store.moveLayer(index, 1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="xq-btn xq-btn-ghost px-1.5 py-0.5 text-[11px]"
                        disabled={encrypting || layers.length <= 1}
                        onClick={() => store.removeLayer(index)}
                      >
                        ✕
                      </button>
                    </li>
                  )
                })}
              </ul>
              <button
                type="button"
                className="xq-btn mt-2 w-full text-[11px]"
                disabled={encrypting || layers.length >= 10}
                onClick={store.addLayer}
              >
                + {t('encrypt.layers')}（1~10）
              </button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Field label={t('encrypt.chunk')}>
                <select
                  className="xq-select"
                  value={chunkSize}
                  disabled={encrypting}
                  onChange={(event) => store.setChunkSize(Number(event.target.value))}
                >
                  {CHUNK_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('encrypt.expires')}>
                <input
                  type="datetime-local"
                  className="xq-input"
                  value={expiresAt}
                  disabled={encrypting}
                  onChange={(event) => store.setExpiresAt(event.target.value)}
                />
              </Field>
            </div>
            <p className="text-[11px] xq-muted">{t('encrypt.chunkHint')}</p>

            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={gzip} disabled={encrypting} onChange={(event) => store.setGzip(event.target.checked)} />
              <span>
                {t('encrypt.gzip')}
                <span className="block text-[11px] xq-muted">{t('encrypt.gzip.hint')}</span>
              </span>
            </label>

            <Field label={t('encrypt.note')}>
              <input
                className="xq-input"
                maxLength={200}
                value={note}
                disabled={encrypting}
                onChange={(event) => store.setNote(event.target.value)}
                placeholder="—"
              />
            </Field>

            {/* 加密声明：写入密文内容最开头，解密时精确剥离。
                留空 → 回退默认声明，所以"不写声明"不是一个可选项。 */}
            <Field label={`🔒 ${t('encrypt.notice')}`}>
              <textarea
                rows={3}
                data-testid="encrypt-notice"
                className="xq-textarea text-[11px]"
                maxLength={2000}
                value={notice}
                disabled={encrypting}
                onChange={(event) => store.setNotice(event.target.value)}
                placeholder={defaultBanner(lang)}
              />
            </Field>
            <div className="text-[11px] xq-muted">{t('encrypt.noticeHint')}</div>

            {files.length > 0 ? (
              <button
                type="button"
                className="xq-btn xq-btn-primary w-full"
                disabled={encrypting}
                onClick={() => void runEncryption()}
              >
                {encrypting ? t('common.working') : `${t('encrypt.start')}（${files.length}）`}
              </button>
            ) : null}

            {encrypting ? <Progress value={progress} label={t('encrypt.progress')} /> : null}
            {error ? <Alert tone="danger">{error}</Alert> : null}
            {lastRun ? (
              <Alert tone="ok" title={t('encrypt.done')}>
                {lastRun.count} · {formatBytes(lastRun.bytes)} · {formatDuration(lastRun.ms)}
                <div className="mt-1 text-[11px] xq-muted">
                  {t('key.tipAfter')}
                </div>
              </Alert>
            ) : null}
          </div>
        </div>
      </Panel>

      {files.some((item) => item.status === 'done') ? (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs xq-muted">
              {t('encrypt.done')}：
              {files.filter((item) => item.status === 'done').length} / {files.length}
            </div>
            <div className="flex flex-wrap gap-2">
              {files
                .filter((item) => item.status === 'done')
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="xq-btn text-[11px]"
                    onClick={() => saveBlob(item.outputBlob!, basenameOfOutput(item), 'application/octet-stream')}
                  >
                    {t('common.download')} {basenameOfOutput(item)}
                  </button>
                ))}
              {files.filter((item) => item.status === 'done').length > 1 ? (
                <button type="button" className="xq-btn xq-btn-primary text-[11px]" onClick={() => void downloadAll()}>
                  {t('common.download')} ZIP
                </button>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}

function basenameOfOutput(item: QueueItem): string {
  return sanitizeFileName(item.path + '.XUQIAN')
}

function sanitizePath(path: string): string {
  return path
    .split('/')
    .map((part) => sanitizeFileName(part))
    .join('/')
}

function StatusChip({ status, progress, detail }: { status: QueueItem['status']; progress: number; detail?: string }) {
  const map: Record<QueueItem['status'], { text: string; tone: string }> = {
    pending: { text: '待处理', tone: 'var(--text-dim)' },
    encrypting: { text: `${Math.round(progress)}%`, tone: 'var(--accent)' },
    done: { text: '完成', tone: 'var(--jade)' },
    error: { text: detail || '失败', tone: 'var(--seal-bright)' },
  }
  const info = map[status]
  return (
    <span className="xq-chip shrink-0" style={{ color: info.tone, borderColor: info.tone }}>
      {info.text}
    </span>
  )
}

export { dirOf, baseNameOf }
