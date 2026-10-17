/** 解密面板：上传 .XUQIAN、输入密钥或上传 .XUQIANKEY、进度、哈希校验。 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { parseHeader, describeHeader, originalFileName, planChunks, type XuqianHeader } from '../crypto/container.ts'
import { parseKeyFile, masterKeyFromPayload, KEYFILE_WARNING } from '../crypto/keyfile.ts'
import { bytesToHex } from '../crypto/encoding.ts'
import { zeroize } from '../crypto/zeroize.ts'
import { readPreamble } from '../crypto/banner.ts'
import { useApp } from '../app/store.ts'
import { errorMessageKey, type MessageKey } from '../app/i18n.ts'
import { cryptoClient } from '../worker/client.ts'
import { formatBytes, readFileAsText, saveBlob, sanitizeFileName, type DroppedEntry } from '../app/utils.ts'
import { Alert, DropZone, Field, Panel, Progress } from './ui.tsx'

type KeyMode = 'input' | 'file'

export function DecryptTab() {
  const t = useApp((s) => s.t)
  const item = useApp((s) => s.decryptFile)
  const decrypting = useApp((s) => s.decrypting)
  const progress = useApp((s) => s.decryptProgress)
  const store = useApp()

  const [keyMode, setKeyMode] = useState<KeyMode>('input')
  const [keyInput, setKeyInput] = useState('')
  const [keyFileText, setKeyFileText] = useState('')
  const [keyFileName, setKeyFileName] = useState('')
  const [keyPassword, setKeyPassword] = useState('')
  const [keyFileLoading, setKeyFileLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [header, setHeader] = useState<XuqianHeader | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [bannerNotice, setBannerNotice] = useState<string | null>(null)
  /** 文件开头的明文声明（无需密钥即可读） */
  const [preambleNotice, setPreambleNotice] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState<{
    matched: boolean
    fingerprint: string
    hashVerified: boolean
    timelock?: { enforced: boolean; exp?: number; nbf?: number }
  } | null>(null)
  const filesRef = useRef<File | null>(null)

  /**
   * 最新值 ref：用户在输入框里敲入密钥 / 选完 .XUQIANKEY 后可能立刻点「开始解密」，
   * 此时 React 可能还没重渲染，处理函数闭包里仍是旧 state（表现为"密钥明明填了却报没有密钥"）。
   * 关键路径一律读 ref，保证拿到的是当前真实值。
   */
  const keyModeRef = useRef<KeyMode>('input')
  const keyInputRef = useRef('')
  const keyPasswordRef = useRef('')
  /**
   * 选中的密钥文件本身（而非它的文本）。
   *
   * 为什么存 File 而不是文本：`File.text()` 是异步的，而用户完全可能在读取完成前
   * 就点「开始解密」。只存文本会读到空值 → 误报"没有可用密钥"。
   * 这里保存 File，并在解密前按需 `await` 读取，时序问题彻底消失。
   */
  const keyFileRef = useRef<File | null>(null)
  const cachedKeyTextRef = useRef('')

  const headerRows = useMemo(() => (header ? describeHeader(header) : []), [header])

  const acceptFiles = useCallback(
    async (entries: DroppedEntry[]) => {
      const first = entries.find((entry) => entry.file.name.toUpperCase().endsWith('.XUQIAN')) ?? entries[0]
      if (!first) return
      setError(null)
      setNotice(null)
      store.setDecryptFile({
        id: `${first.path}-${first.file.size}-${first.file.lastModified}`,
        name: first.file.name,
        size: first.file.size,
        status: 'pending',
        progress: 0,
      })
      // 先读文件开头的**明文**声明（不需要密钥即可读），再按偏移解析加密头部
      try {
        const head = new Uint8Array(await first.file.slice(0, 64 * 1024).arrayBuffer())
        const preamble = readPreamble(head)
        setPreambleNotice(preamble?.noticeText ?? null)
        setHeader(parseHeader(preamble ? head.subarray(preamble.containerOffset) : head).header)
      } catch {
        setPreambleNotice(null)
        setHeader(null)
      }
      filesRef.current = first.file
      void entries
    },
    [store],
  )

  const importKeyFromFile = (file: File) => {
    // 全程只依赖 File 对象；文本在真正解密前才读取，因此不存在时序竞争
    keyFileRef.current = file
    cachedKeyTextRef.current = ''
    keyModeRef.current = 'file'
    setKeyMode('file')
    setKeyFileName(file.name)
    setKeyFileText('')
    setKeyFileLoading(true)
    void readFileAsText(file)
      .then((text) => {
        if (keyFileRef.current !== file) return
        cachedKeyTextRef.current = text
        setKeyFileText(text)
      })
      .catch(() => {
        if (keyFileRef.current !== file) return
        cachedKeyTextRef.current = ''
        setKeyFileText('')
      })
      .finally(() => {
        if (keyFileRef.current === file) setKeyFileLoading(false)
      })
  }

  /** 从 DOM 读取当前真实输入值（防止 React 状态尚未刷新 / 自动填充未触发 onChange）。 */
  const readLiveInputs = () => {
    const read = (testId: string): string => {
      const node = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`)
      return node?.value ?? ''
    }
    const domValue = read('decrypt-key')
    const domPassword = read('keyfile-password')
    const useDomKey = domValue.length > 0 || keyInputRef.current.length === 0
    return {
      mode: keyModeRef.current,
      keyInput: useDomKey ? domValue : keyInputRef.current,
      keyPassword: domPassword || keyPasswordRef.current,
    }
  }

  /** 取得密钥文件文本：优先用缓存，否则从 File 现场读取（此时即使还没读完也只是等一下）。 */
  const resolveKeyFileText = async (): Promise<string> => {
    if (cachedKeyTextRef.current) return cachedKeyTextRef.current
    const file = keyFileRef.current
    if (!file) return ''
    const text = await readFileAsText(file)
    cachedKeyTextRef.current = text
    setKeyFileText(text)
    return text
  }

  /** 把当前选中的密钥（手动输入或密钥文件）导入 Worker。返回是否成功。 */
  const importCurrentKey = async (): Promise<boolean> => {
    const live = readLiveInputs()
    if (live.mode === 'input') {
      const raw = live.keyInput.trim()
      if (!raw) return false
      const normalized = raw.replace(/[\s:]/g, '')
      const isHex = /^[0-9a-fA-F]{32}$/.test(normalized)
      await cryptoClient.importKey(isHex ? { hex: normalized } : { base64: normalized })
      return true
    }
    const keyFileText = await resolveKeyFileText()
    if (!keyFileText) return false
    const payload = await parseKeyFile(keyFileText, live.keyPassword || undefined)
    const master = masterKeyFromPayload(payload)
    const bytes = master.clone()
    master.destroy()
    try {
      await cryptoClient.importKey({ hex: bytesToHex(bytes) })
    } finally {
      zeroize(bytes)
    }
    return true
  }

  /**
   * 密钥自检：只读文件头 + 第一块交给 Worker 认证，用来回答"这把密钥能不能开这个文件"。
   * 不写文件、不改动密钥状态，因此可以放心用来确认刚抄下来的密钥有没有抄错。
   */
  const runKeyCheck = async () => {
    const file = filesRef.current
    if (!file) {
      setError(t('check.needFile'))
      return
    }
    setChecking(true)
    setError(null)
    setCheckResult(null)
    try {
      // 只读"容器头部 + 第一块"：AEAD 逐块独立，任意一块即可判定密钥对错。
      // 先读 64 KiB 拿到明文声明区与容器头部，再按需精确取到首块末尾。
      let from = 0
      let need = file.size
      try {
        const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
        from = readPreamble(head)?.containerOffset ?? 0
        const parsed = parseHeader(from > 0 ? head.subarray(from) : head)
        const plan = planChunks(Number(parsed.header.meta.s ?? 0), parsed.header.cs, parsed.header.layers.length)
        need = Math.min(file.size, from + parsed.headerLength + plan.blockTotals[0])
      } catch {
        from = 0
        need = file.size
      }
      // 交给 Worker 的是"加密容器"（跳过明文声明区）
      const bytes = await file.slice(from, need).arrayBuffer()
      const imported = await importCurrentKey()
      if (!imported) {
        setError(t('check.needKey'))
        return
      }
      const result = await cryptoClient.keyCheck(bytes)
      setCheckResult({
        matched: result.matched,
        fingerprint: result.fingerprint,
        hashVerified: result.hashVerified,
        timelock: result.timelock,
      })
    } catch (checkError) {
      const code = errorMessageKey(checkError)
      setError(t(code))
      // 即便判定失败也要展示指纹，便于用户核对
      try {
        const view = await cryptoClient.viewKey()
        setCheckResult({ matched: false, fingerprint: view.fingerprint, hashVerified: false })
      } catch {
        /* 密钥不可读则只显示错误 */
      }
    } finally {
      setChecking(false)
    }
  }

  const runDecryption = async () => {
    // 关键路径一律读取"当前真实值"，避免过期闭包快照
    const live = readLiveInputs()
    const mode = live.mode
    const currentPassword = live.keyPassword
    const file = filesRef.current
    if (!file) {
      setError(t('drop.hint'))
      return
    }
    setError(null)
    setNotice(null)
    store.setDecrypting(true)
    store.setDecryptProgress(5)
    store.patchDecryptFile({ status: 'decrypting', progress: 5 })

    try {
      // 1) 取得密钥：手动输入 或 .XUQIANKEY（都用 ref 里的最新值，避免渲染快照过期）
      const imported = await importCurrentKey()
      if (!imported) throw new Error('KEY_NOT_AVAILABLE')
      if (mode === 'file') {
        const payload = await parseKeyFile(await resolveKeyFileText(), currentPassword || undefined)
        setNotice(`${t('key.fingerprint')}: ${payload.fingerprint}`)
      }

      store.setDecryptProgress(30)
      store.patchDecryptFile({ progress: 30 })
      const buffer = await file.arrayBuffer()
      const result = await cryptoClient.decrypt(buffer)
      store.setDecryptProgress(95)
      store.patchDecryptFile({ progress: 95 })

      const outputName = sanitizeFileName(result.name || originalFileName(file.name))
      const blob = new Blob([result.bytes], { type: result.mime || 'application/octet-stream' })
      store.patchDecryptFile({
        status: 'done',
        progress: 100,
        outputName,
        outputBlob: blob,
        hashMatched: result.hashMatched,
        headerJson: result.header,
      })
      try {
        setHeader(JSON.parse(result.header) as XuqianHeader)
      } catch {
        /* ignore */
      }
      store.setDecryptProgress(100)
      store.logEvent(
        'decrypt',
        `解密 ${file.name} → ${outputName}（哈希校验 ${result.hashMatched === null ? '无记录' : result.hashMatched ? '一致' : '不一致'}）`,
      )

      if (result.expiresAt && Date.now() > result.expiresAt) {
        setNotice(`该文件设置了到期提醒：${new Date(result.expiresAt).toLocaleString()}（纯前端无法强制自毁，仅提示）`)
      }
      // 告知用户：开头的加密声明已按文件头记录的长度被剥离，下载到的才是原文件
      if (result.bannerBytes > 0) {
        setBannerNotice(t('decrypt.bannerStripped').replace('{n}', String(result.bannerBytes)))
      }
      // 2) 解密完成后立即销毁内存中的密钥与子密钥
      await cryptoClient.destroyKey()
      keyInputRef.current = ''
      keyPasswordRef.current = ''
      cachedKeyTextRef.current = ''
      setKeyInput('')
      setKeyFileText('')
      setKeyPassword('')
    } catch (err) {
      const key = errorMessageKey(err)
      setError(t(key))
      store.patchDecryptFile({ status: 'error', message: t(key) })
      store.logEvent('decrypt', `解密失败：${key}`, 'error')
      await cryptoClient.destroyKey()
    } finally {
      store.setDecrypting(false)
    }
  }

  return (
    <div className="space-y-4">
      <Panel>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <DropZone onFiles={acceptFiles} disabled={decrypting} />
            {item ? (
              <div className="xq-card flex items-center gap-2 px-3 py-2 text-xs">
                <div className="flex-1 truncate" title={item.name}>
                  {item.name}
                </div>
                <span className="xq-mono xq-muted">{formatBytes(item.size)}</span>
                <button
                  type="button"
                  className="xq-btn xq-btn-ghost px-1.5 py-0.5 text-[11px]"
                  disabled={decrypting}
                  onClick={() => {
                    store.setDecryptFile(null)
                    setHeader(null)
                    filesRef.current = null
                  }}
                >
                  ✕
                </button>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  className="xq-tab flex-1"
                  data-active={keyMode === 'input'}
                  onClick={() => {
                    keyModeRef.current = 'input'
                    setKeyMode('input')
                  }}
                >
                  {t('decrypt.keyInput')}
                </button>
                <button
                  type="button"
                  className="xq-tab flex-1"
                  data-active={keyMode === 'file'}
                  onClick={() => {
                    keyModeRef.current = 'file'
                    setKeyMode('file')
                  }}
                >
                  {t('decrypt.keyFile')}
                </button>
              </div>

              {keyMode === 'input' ? (
                <Field label={t('decrypt.keyInput')} hint="32 Hex / 24 Base64">
                  <textarea
                    rows={2}
                    spellCheck={false}
                    data-testid="decrypt-key"
                    className="xq-textarea xq-mono text-sm"
                    placeholder={t('decrypt.keyPlaceholder')}
                    value={keyInput}
                    onChange={(event) => {
                      keyInputRef.current = event.target.value
                      setKeyInput(event.target.value)
                    }}
                    autoComplete="off"
                  />
                </Field>
              ) : (
                <div className="space-y-2">
                  <Field label={t('decrypt.keyFile')}>
                    <input
                      type="file"
                      data-testid="keyfile-input"
                      accept=".XUQIANKEY,application/json"
                      className="xq-input"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (file) void importKeyFromFile(file)
                        event.target.value = ''
                      }}
                    />
                  </Field>
                  {keyFileLoading ? (
                    <div className="text-[11px]" style={{ color: 'var(--accent)' }}>
                      正在读取密钥文件…
                    </div>
                  ) : null}
                  {keyFileName ? (
                    <div className="text-[11px] xq-muted">
                      已载入：{keyFileName}
                      {keyFileText ? ` · ${keyFileText.length} 字节` : ''}
                    </div>
                  ) : null}
                  <Field label={t('decrypt.password')}>
                    <input
                      type="password"
                      data-testid="keyfile-password"
                      className="xq-input"
                      value={keyPassword}
                      autoComplete="off"
                      onChange={(event) => {
                        keyPasswordRef.current = event.target.value
                        setKeyPassword(event.target.value)
                      }}
                    />
                  </Field>
                  <Alert tone="warn">{KEYFILE_WARNING}</Alert>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  className="xq-btn flex-1"
                  data-testid="decrypt-key-check"
                  disabled={decrypting || keyFileLoading || checking || !filesRef.current}
                  onClick={() => void runKeyCheck()}
                >
                  {checking ? t('check.running') : t('check.button')}
                </button>
              </div>

              {checkResult && !checking ? (
                <div data-testid="decrypt-check-result">
                  <Alert tone={checkResult.matched ? 'info' : 'danger'}>
                    <span className="font-semibold">
                      {checkResult.matched ? `✓ ${t('check.match')}` : `✕ ${t('check.mismatch')}`}
                    </span>
                    <span className="mt-1 block text-[11px]">
                      {t('check.fingerprint')}：<span className="xq-mono">{checkResult.fingerprint}</span>
                    </span>
                    <span className="mt-1 block text-[11px] xq-muted">
                      {!checkResult.matched
                        ? t('check.mismatchHint')
                        : checkResult.hashVerified
                          ? t('check.hashVerified')
                          : t('check.firstBlockOnly')}
                    </span>
                    {checkResult.timelock?.enforced ? (
                      <span className="mt-1 block text-[11px]" data-testid="check-timelock">
                        {timelockText(t, checkResult.timelock)}
                      </span>
                    ) : null}
                  </Alert>
                </div>
              ) : null}
              <div className="text-[11px] xq-muted">{t('check.hint')}</div>

              <button
                type="button"
                className="xq-btn xq-btn-primary w-full"
                disabled={decrypting || keyFileLoading || !filesRef.current}
                onClick={() => void runDecryption()}
              >
                {decrypting ? t('common.working') : t('decrypt.start')}
              </button>

              {decrypting ? <Progress value={progress} label={t('decrypt.progress')} /> : null}
              {error ? <Alert tone="danger">{error}</Alert> : null}
              {preambleNotice ? (
                <div data-testid="decrypt-preamble-notice">
                  <Alert tone="info">
                    <span className="font-semibold">{t('decrypt.plainNotice')}</span>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                      {preambleNotice}
                    </pre>
                    <span className="mt-1 block text-[11px] xq-muted">{t('decrypt.plainNoticeHint')}</span>
                  </Alert>
                </div>
              ) : null}
              {bannerNotice ? <Alert tone="info">{bannerNotice}</Alert> : null}
              {notice ? <Alert tone="info">{notice}</Alert> : null}
              {item?.status === 'done' ? (
                <Alert tone={item.hashMatched === false ? 'danger' : 'ok'} title={t('decrypt.done')}>
                  <div className="space-y-1">
                    <div>
                      {t('tools.hash')}：
                      {item.hashMatched === null ? '—' : item.hashMatched ? 'SHA-256 一致 ✓' : 'SHA-256 不一致 ✗'}
                    </div>
                    <div className="text-[11px] xq-muted">{t('decrypt.destroyed')}</div>
                    <button
                      type="button"
                      className="xq-btn xq-btn-primary mt-1 text-[11px]"
                      onClick={() =>
                        saveBlob(item.outputBlob!, item.outputName || 'restored.bin', 'application/octet-stream')
                      }
                    >
                      {t('decrypt.restore')} · {item.outputName}
                    </button>
                  </div>
                </Alert>
              ) : null}
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <div className="mb-1 text-xs font-medium">{t('decrypt.headerInfo')}</div>
              {header ? (
                <div className="xq-card p-3">
                  <table className="xq-table">
                    <tbody>
                      {headerRows.map((row) => (
                        <tr key={row.key}>
                          <th className="w-32 whitespace-nowrap">{row.key}</th>
                          <td className="xq-mono">{row.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="xq-card p-3 text-[11px] xq-muted">—</div>
              )}
            </div>
            <Alert tone="info" title={t('common.notice')}>
              密钥错误或文件被篡改时，本工具只会提示“密钥错误或文件损坏”，不会区分具体原因，避免泄露校验信息。
            </Alert>
          </div>
        </div>
      </Panel>
    </div>
  )
}

/** 把时间锁信息转成用户可读的一行（自检结果显示用）。 */
function timelockText(t: (key: MessageKey) => string, lock: { exp?: number; nbf?: number }): string {
  const fmt = (v?: number) => (typeof v === 'number' ? new Date(v).toLocaleString() : '?')
  const nbf = typeof lock.nbf === 'number' ? fmt(lock.nbf) : undefined
  const exp = typeof lock.exp === 'number' ? fmt(lock.exp) : undefined
  if (nbf && exp) return t('check.timelock.window').replace('{nbf}', nbf).replace('{exp}', exp)
  if (nbf) return t('check.timelock.nbf').replace('{time}', nbf)
  if (exp) return t('check.timelock.exp').replace('{time}', exp)
  return t('check.timelock.nbf').replace('{time}', '?')
}
