/** 工具箱：随机密码、哈希校验、文件头查看、Shamir 恢复、设置、本地日志。 */
import { useMemo, useState } from 'react'
import { useApp } from '../app/store.ts'
import { copyText, formatTS, saveText } from '../app/utils.ts'
import { cryptoClient } from '../worker/client.ts'
import { combineShares, decodeShare, type ShamirShare } from '../crypto/shamir.ts'
import { bytesToHex } from '../crypto/encoding.ts'
import { MasterKey } from '../crypto/keys.ts'
import { buildPlainKeyFile, buildProtectedKeyFile, parseKeyFile, payloadFromBytes, serializeKeyFile } from '../crypto/keyfile.ts'
import { errorMessageKey } from '../app/i18n.ts'
import { describeHeader, parseHeader, EXT_KEYFILE, type XuqianHeader } from '../crypto/container.ts'
import { Alert, Field, Panel } from './ui.tsx'
import { PassphraseMeter } from './PassphraseMeter.tsx'

const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/'

function randomFrom(chars: string, length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length]
  return out
}



export function ToolsTab() {
  const t = useApp((s) => s.t)
  const log = useApp((s) => s.log)
  const theme = useApp((s) => s.theme)
  const lang = useApp((s) => s.lang)
  const clipboardClear = useApp((s) => s.clipboardClear)
  const autoLockMinutes = useApp((s) => s.autoLockMinutes)
  const store = useApp()

  const [length, setLength] = useState(20)
  const [useUpper, setUseUpper] = useState(true)
  const [useLower, setUseLower] = useState(true)
  const [useDigits, setUseDigits] = useState(true)
  const [useSymbols, setUseSymbols] = useState(true)
  const [password, setPassword] = useState('')

  const [hashInput, setHashInput] = useState('')
  const [hashResult, setHashResult] = useState<Record<string, string> | null>(null)
  const [hashName, setHashName] = useState('')

  const [header, setHeader] = useState<XuqianHeader | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [shareText, setShareText] = useState('')
  const [recovered, setRecovered] = useState<{ hex: string; base64: string; fingerprint: string } | null>(null)

  const [rotateFile, setRotateFile] = useState<File | null>(null)
  const [rotateOldPw, setRotateOldPw] = useState('')
  const [rotateNewPw, setRotateNewPw] = useState('')
  const [rotateNewPw2, setRotateNewPw2] = useState('')
  const [rotateDone, setRotateDone] = useState<string | null>(null)
  const headerRows = useMemo(() => (header ? describeHeader(header) : []), [header])

  const generatePassword = () => {
    let pool = ''
    if (useLower) pool += 'abcdefghijkmnopqrstuvwxyz'
    if (useUpper) pool += 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    if (useDigits) pool += '23456789'
    if (useSymbols) pool += SYMBOLS
    if (!pool) {
      setError('至少选择一种字符类型')
      return
    }
    setError(null)
    // 每个必选类别至少出现一次，其余随机补齐
    const required = [useLower && 'abcdefghijkmnopqrstuvwxyz', useUpper && 'ABCDEFGHJKLMNPQRSTUVWXYZ', useDigits && '23456789', useSymbols && SYMBOLS].filter(
      (item): item is string => typeof item === 'string',
    )
    let candidate = required.map((set) => randomFrom(set, 1)).join('')
    candidate += randomFrom(pool, Math.max(0, length - candidate.length))
    const chars = candidate.split('')
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint8Array(1))[0] % (i + 1)
      ;[chars[i], chars[j]] = [chars[j], chars[i]]
    }
    setPassword(chars.join(''))
  }

  const hashFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const buffer = await file.arrayBuffer()
      const digests = await cryptoClient.hash(buffer, ['SHA-256', 'SHA-512'])
      setHashResult(digests)
      setHashName(file.name)
      store.logEvent('hash', `计算哈希：${file.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'UNKNOWN')
    } finally {
      setBusy(false)
    }
  }

  const inspectFile = async (file: File) => {
    setError(null)
    try {
      const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
      setHeader(parseHeader(head).header)
      setHashName(file.name)
      store.logEvent('hash', `查看文件头：${file.name}`)
    } catch (err) {
      setHeader(null)
      setError(t('error.FORMAT_INVALID'))
      void err
    }
  }

  const recoverFromShares = async () => {
    setError(null)
    setRecovered(null)
    try {
      const shares: ShamirShare[] = shareText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => decodeShare(line).share)
      if (shares.length < 2) throw new Error('SHAMIR_NO_SHARES')
      const secret = combineShares(shares)
      const key = MasterKey.fromBytes(secret)
      const hex = bytesToHex(secret)
      const fingerprint = await key.fingerprint()
      key.destroy()
      const payload = await payloadFromBytes(secret)
      const encoded = new Uint8Array(secret)
      setRecovered({
        hex,
        base64: payload.keyB64,
        fingerprint,
      })
      saveText(serializeKeyFile(buildPlainKeyFile(payload)), `xuqian-recovered${EXT_KEYFILE}`)
      encoded.fill(0)
      secret.fill(0)
      store.logEvent('shamir', `由 ${shares.length} 份分片恢复密钥（指纹 ${fingerprint}）`)
    } catch {
      setError('分片格式不正确，或数量不足 / 不属于同一组')
    }
  }

  /**
   * 密钥轮换：只更换密钥文件的口令，不重加密数据。
   * 主密钥本身不变 → 已有 .XUQIAN 文件继续可用，指纹也不变（便于核验）。
   */
  const rotateKeyFile = async () => {
    if (!rotateFile) return
    setBusy(true)
    setError(null)
    setRotateDone(null)
    try {
      if (rotateNewPw !== rotateNewPw2) throw new Error('KEYFILE_PASSWORD_REQUIRED')
      if (rotateNewPw && rotateNewPw.length < 8) throw new Error('KEYFILE_PASSWORD_REQUIRED')
      const payload = await parseKeyFile(await rotateFile.text(), rotateOldPw || undefined)
      const rotated = rotateNewPw ? await buildProtectedKeyFile(payload, rotateNewPw) : buildPlainKeyFile(payload)
      const base = rotateFile.name.replace(/\.XUQIANKEY$/i, '') || 'xuqian-key'
      const outName = `${base}.rotated${EXT_KEYFILE}`
      saveText(serializeKeyFile(rotated), outName, 'application/json;charset=utf-8')
      store.logEvent('keyGen', `轮换密钥文件口令（指纹 ${payload.fingerprint}），主密钥未改变`)
      setRotateOldPw('')
      setRotateNewPw('')
      setRotateNewPw2('')
      setRotateDone(`${t('tools.rotate.done')} ${outName}（${t('key.fingerprint')} ${payload.fingerprint}）`)
    } catch (err) {
      setError(t(errorMessageKey(err)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel className="space-y-3">
        <h2 className="text-sm font-semibold">{t('tools.password')}</h2>
        <Field label={t('tools.passwordLength')} hint={String(length)}>
          <input
            type="range"
            min={8}
            max={64}
            value={length}
            onChange={(event) => setLength(Number(event.target.value))}
            className="w-full"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            { label: t('tools.upper'), value: useUpper, set: setUseUpper },
            { label: t('tools.lower'), value: useLower, set: setUseLower },
            { label: t('tools.digits'), value: useDigits, set: setUseDigits },
            { label: t('tools.symbols'), value: useSymbols, set: setUseSymbols },
          ].map((row) => (
            <label key={row.label} className="flex items-center gap-2">
              <input type="checkbox" checked={row.value} onChange={(event) => row.set(event.target.checked)} />
              {row.label}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" className="xq-btn xq-btn-primary flex-1" onClick={generatePassword}>
            {t('tools.generate')}
          </button>
          <button type="button" className="xq-btn" disabled={!password} onClick={() => void copyText(password)}>
            {t('common.copy')}
          </button>
        </div>
        {password ? (
          <div className="space-y-1">
            <div className="xq-input xq-mono break-all text-xs">{password}</div>
            <PassphraseMeter password={password} />
          </div>
        ) : null}
        <Alert tone="info">密码由 crypto.getRandomValues 生成，仅在你的浏览器内产生，不会被记录。</Alert>
      </Panel>

      <Panel className="space-y-3">
        <h2 className="text-sm font-semibold">{t('tools.hash')}</h2>
        <Field label={t('tools.hashFile')}>
          <input
            type="file"
            className="xq-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void hashFile(file)
              event.target.value = ''
            }}
          />
        </Field>
        <Field label={t('tools.hashText')}>
          <textarea
            className="xq-textarea text-xs"
            rows={3}
            value={hashInput}
            onChange={(event) => setHashInput(event.target.value)}
          />
        </Field>
        <button
          type="button"
          className="xq-btn"
          disabled={busy || !hashInput}
          onClick={async () => {
            setBusy(true)
            try {
              const bytes = new TextEncoder().encode(hashInput)
              const digests = await cryptoClient.hash(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
                ['SHA-256', 'SHA-512'],
              )
              setHashResult(digests)
              setHashName('text')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? t('common.working') : t('tools.hash')}
        </button>
        {hashResult ? (
          <div className="space-y-1 text-[11px]">
            <div className="xq-muted">{hashName}</div>
            {Object.entries(hashResult).map(([algo, value]) => (
              <div key={algo} className="space-y-0.5">
                <div className="font-medium">{algo}</div>
                <div className="xq-mono break-all">{value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel className="space-y-3">
        <h2 className="text-sm font-semibold">{t('tools.inspect')}</h2>
        <input
          type="file"
          accept=".XUQIAN"
          className="xq-input"
          // 标题在旁边不等于程序化关联 —— 无障碍审计抓到的缺口，加显式可访问名
          aria-label={t('tools.inspect')}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void inspectFile(file)
            event.target.value = ''
          }}
        />
        {header ? (
          <table className="xq-table">
            <tbody>
              {headerRows.map((row) => (
                <tr key={row.key}>
                  <th className="w-28 whitespace-nowrap">{row.key}</th>
                  <td className="xq-mono">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-[11px] xq-muted">选择一个 .XUQIAN 文件即可查看它的明文文件头（不含任何密钥）。</div>
        )}
      </Panel>

      <Panel className="space-y-3">
        <h2 className="text-sm font-semibold">{t('tools.shamirCombine')}</h2>
        <Field label={t('tools.shamirCombineHint')}>
          <textarea
            className="xq-textarea xq-mono text-[11px]"
            rows={5}
            placeholder="XUQIAN-SHARE-1of5-3-..."
            value={shareText}
            onChange={(event) => setShareText(event.target.value)}
          />
        </Field>
        <button type="button" className="xq-btn xq-btn-primary" disabled={!shareText.trim()} onClick={() => void recoverFromShares()}>
          {t('tools.shamirRecover')}
        </button>
        {recovered ? (
          <Alert tone="ok" title="恢复成功">
            <div className="xq-mono break-all text-[11px]">{recovered.hex}</div>
            <div className="xq-mono break-all text-[11px]">{recovered.base64}</div>
            <div className="text-[11px]">
              {t('key.fingerprint')}：{recovered.fingerprint}
            </div>
            <div className="mt-1 text-[11px] xq-muted">已同时下载 .XUQIANKEY 文件。恢复出的密钥请立即另存并妥善保管。</div>
          </Alert>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </Panel>

      <Panel className="space-y-3">
        <h2 className="text-sm font-semibold">{t('tools.rotate')}</h2>
        <p className="text-[11px] xq-muted">{t('tools.rotate.hint')}</p>
        <Field label={t('tools.rotate.file')}>
          <input
            type="file"
            accept=".XUQIANKEY,application/json"
            className="xq-input"
            onChange={(event) => {
              setRotateFile(event.target.files?.[0] ?? null)
              setRotateDone(null)
            }}
          />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('tools.rotate.old')}>
            <input
              type="password"
              className="xq-input"
              value={rotateOldPw}
              autoComplete="current-password"
              onChange={(event) => setRotateOldPw(event.target.value)}
            />
          </Field>
          <Field label={t('tools.rotate.new')} hint={t('tools.rotate.newHint')}>
            <input
              type="password"
              className="xq-input"
              value={rotateNewPw}
              autoComplete="new-password"
              onChange={(event) => setRotateNewPw(event.target.value)}
            />
          </Field>
        </div>
        <PassphraseMeter password={rotateNewPw} />
        <Field label={t('tools.rotate.newConfirm')}>
          <input
            type="password"
            className="xq-input"
            value={rotateNewPw2}
            autoComplete="new-password"
            onChange={(event) => setRotateNewPw2(event.target.value)}
          />
        </Field>
        <button type="button" className="xq-btn xq-btn-primary w-full" disabled={busy || !rotateFile} onClick={() => void rotateKeyFile()}>
          {t('tools.rotate.run')}
        </button>
        {rotateDone ? <Alert tone="ok">{rotateDone}</Alert> : null}
      </Panel>

      <Panel className="space-y-3">
        <h2 className="text-sm font-semibold">{t('tools.settings')}</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="xq-btn"
            onClick={() => {
              const next = theme === 'dark' ? 'light' : 'dark'
              store.setTheme(next)
              store.logEvent('settings', `切换主题为 ${next}`)
            }}
          >
            {theme === 'dark' ? t('theme.light') : t('theme.dark')}
          </button>
          <button
            type="button"
            className="xq-btn"
            onClick={() => {
              const next = lang === 'zh' ? 'en' : 'zh'
              store.setLang(next)
            }}
          >
            {lang === 'zh' ? 'English' : '中文'}
          </button>
          <label className="xq-btn cursor-pointer">
            <input
              type="checkbox"
              className="mr-1"
              checked={clipboardClear}
              onChange={(event) => store.setClipboardClear(event.target.checked)}
            />
            {t('key.copyClear')}
          </label>
          <label className="xq-btn cursor-pointer">
            {t('settings.autoLock')}
            <select
              className="xq-input ml-1 inline-block w-auto py-0.5"
              value={autoLockMinutes}
              onChange={(event) => store.setAutoLockMinutes(Number(event.target.value))}
            >
              <option value={0}>{t('settings.autoLock.off')}</option>
              <option value={1}>1 {t('settings.minutes')}</option>
              <option value={5}>5 {t('settings.minutes')}</option>
              <option value={15}>15 {t('settings.minutes')}</option>
              <option value={30}>30 {t('settings.minutes')}</option>
              <option value={60}>60 {t('settings.minutes')}</option>
            </select>
          </label>
        </div>
        <Alert tone="info" title={t('tools.about')}>
          {t('compliance')}
        </Alert>
        <div className="text-[11px] xq-muted">
          快捷键：1 / 2 / 3 / 4 切换标签页，Esc 关闭弹窗，Ctrl+Shift+L 切换主题。
        </div>
      </Panel>

      <Panel className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('tools.log')}</h2>
          <button type="button" className="xq-btn text-[11px]" onClick={store.clearLog}>
            {t('tools.logClear')}
          </button>
        </div>
        {log.length === 0 ? (
          <div className="text-[11px] xq-muted">{t('tools.logEmpty')}</div>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto text-[11px]">
            {[...log].reverse().map((entry) => (
              <li key={entry.id} className="xq-card flex items-start gap-2 px-2 py-1">
                <span className="xq-mono xq-muted shrink-0">{formatTS(entry.ts).slice(11)}</span>
                <span
                  className="xq-chip shrink-0"
                  style={{ color: entry.level === 'error' ? 'var(--seal-bright)' : entry.level === 'warn' ? 'var(--accent)' : 'var(--text-dim)' }}
                >
                  {entry.action}
                </span>
                <span className="flex-1 break-all">{entry.detail}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="text-[11px] xq-muted">日志只保存在本机 localStorage，且写入前会过滤疑似密钥内容，不会上传。</div>
      </Panel>
    </div>
  )
}
