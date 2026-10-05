/** 文本模式：直接加密/解密文本，密文以 Base64 串呈现。 */
import { useState } from 'react'
import { ALL_ALGO_IDS, ALGO_SPECS, type AlgoId } from '../crypto/aead.ts'
import { encryptedFileName } from '../crypto/container.ts'
import { useApp } from '../app/store.ts'
import { errorMessageKey } from '../app/i18n.ts'
import { cryptoClient } from '../worker/client.ts'
import { bytesToUtf8, utf8ToBytes } from '../crypto/zeroize.ts'
import { bytesToBase64, base64ToBytes } from '../crypto/encoding.ts'
import { copyText, saveText } from '../app/utils.ts'
import { Alert, Field, Panel } from './ui.tsx'

const PREFIX = 'XUQIAN1:'

export function TextTab() {
  const t = useApp((s) => s.t)
  const layers = useApp((s) => s.layers)
  const chunkSize = useApp((s) => s.chunkSize)
  const notice = useApp((s) => s.notice)
  const lang = useApp((s) => s.lang)
  const store = useApp()

  const [plain, setPlain] = useState('')
  const [cipher, setCipher] = useState('')
  const [keyText, setKeyText] = useState('')
  const [gzip, setGzip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const textLayers: AlgoId[] = layers.length > 0 ? layers : ['AES-128-GCM']

  const doEncrypt = async () => {
    if (!plain.trim()) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await cryptoClient.generateKey()
      const result = await cryptoClient.encrypt({
        bytes: utf8ToBytes(plain).buffer as ArrayBuffer,
        name: 'text.txt',
        mime: 'text/plain;charset=utf-8',
        layers: textLayers,
        chunkSize,
        gzip,
        notice,
        lang,
        kind: 'text',
      })
      const encoded = PREFIX + bytesToBase64(new Uint8Array(result.bytes))
      setCipher(encoded)
      const view = await cryptoClient.viewKey()
      store.openKeyModal({
        view,
        fingerprint: view.fingerprint,
        copiedHex: false,
        copiedBase64: false,
        downloaded: false,
        contextLabel: 'text.txt',
        layers: [...textLayers],
        chunkSize,
        gzip,
      })
      store.logEvent('text', `加密文本 ${plain.length} 字符，密文 ${encoded.length} 字符`)
    } catch (err) {
      setError(t(errorMessageKey(err)))
    } finally {
      setBusy(false)
    }
  }

  const doDecrypt = async () => {
    const raw = cipher.trim()
    if (!raw) return
    if (!keyText.trim()) {
      setError(t('error.KEY_NOT_AVAILABLE'))
      return
    }
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const body = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw
      const bytes = base64ToBytes(body)
      const normalized = keyText.trim().replace(/[\s:]/g, '')
      await cryptoClient.importKey(/^[0-9a-fA-F]{32}$/.test(normalized) ? { hex: normalized } : { base64: normalized })
      const result = await cryptoClient.decrypt(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
      setPlain(bytesToUtf8(new Uint8Array(result.bytes)))
      setInfo(`${t('tools.hash')}：${result.hashMatched === null ? '—' : result.hashMatched ? '一致 ✓' : '不一致 ✗'}`)
      store.logEvent('text', '解密文本成功')
    } catch (err) {
      setError(t(errorMessageKey(err)))
    } finally {
      // 解密后立即销毁内存中的密钥
      await cryptoClient.destroyKey()
      setBusy(false)
    }
  }

  return (
    <Panel className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Field label={t('text.input')} hint={`${plain.length}`}>
            <textarea
              rows={10}
              data-testid="text-plain"
              className="xq-textarea text-sm"
              placeholder={t('text.placeholder')}
              value={plain}
              onChange={(event) => setPlain(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="xq-btn xq-btn-primary" disabled={busy || !plain.trim()} onClick={() => void doEncrypt()}>
              {t('text.encrypt')}
            </button>
            <button
              type="button"
              className="xq-btn"
              disabled={busy}
              onClick={async () => {
                try {
                  const text = await navigator.clipboard?.readText()
                  if (typeof text === 'string' && text) setPlain(text)
                } catch {
                  setError('浏览器不允许读取剪贴板，请手动粘贴（Ctrl+V）')
                }
              }}
            >
              {t('text.paste')}
            </button>
            <label className="flex items-center gap-1.5 text-[11px] xq-muted">
              <input type="checkbox" checked={gzip} onChange={(event) => setGzip(event.target.checked)} />
              gzip
            </label>
          </div>
        </div>

        <div className="space-y-2">
          <Field label={t('text.output')} hint={`${cipher.length}`}>
            <textarea
              rows={7}
              spellCheck={false}
              data-testid="text-cipher"
              className="xq-textarea xq-mono text-[11px]"
              value={cipher}
              onChange={(event) => setCipher(event.target.value)}
            />
          </Field>
          <Field label={t('decrypt.keyInput')} hint="32 Hex / 24 Base64">
            <textarea
              rows={2}
              spellCheck={false}
              data-testid="text-key"
              className="xq-textarea xq-mono text-[11px]"
              placeholder={t('decrypt.keyPlaceholder')}
              value={keyText}
              onChange={(event) => setKeyText(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="xq-btn xq-btn-primary" disabled={busy || !cipher.trim()} onClick={() => void doDecrypt()}>
              {t('text.decrypt')}
            </button>
            <button type="button" className="xq-btn" disabled={!cipher} onClick={() => void copyText(cipher)}>
              {t('common.copy')}
            </button>
            <button
              type="button"
              className="xq-btn"
              disabled={!cipher}
              onClick={() => saveText(cipher, encryptedFileName('text.txt'), 'text/plain;charset=utf-8')}
            >
              {t('text.saveFile')}
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('encrypt.algorithms')} hint={`${t('encrypt.layers')}：${textLayers.length}`}>
          <div className="xq-card space-y-1.5 p-2.5">
            <p className="text-[11px] xq-muted">{t('encrypt.order')}</p>
            {[...textLayers].reverse().map((algo, reversedIndex) => {
              const index = textLayers.length - 1 - reversedIndex
              return (
                <div key={`${algo}-${index}`} className="flex items-center gap-2 text-[11px]">
                  <span className="xq-mono w-4 text-center xq-muted">{index + 1}</span>
                  <select
                    className="xq-select flex-1 py-1 text-[11px]"
                    value={algo}
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
                    disabled={index === 0}
                    title={t('encrypt.moveDown')}
                    onClick={() => store.moveLayer(index, -1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="xq-btn xq-btn-ghost px-1.5 py-0.5 text-[11px]"
                    disabled={index === textLayers.length - 1}
                    title={t('encrypt.moveUp')}
                    onClick={() => store.moveLayer(index, 1)}
                  >
                    ↑
                  </button>
                </div>
              )
            })}
            <div className="flex gap-2 pt-0.5">
              <button type="button" className="xq-btn flex-1 text-[11px]" disabled={textLayers.length >= 10} onClick={store.addLayer}>
                + {t('encrypt.layers')}
              </button>
              <button
                type="button"
                className="xq-btn flex-1 text-[11px]"
                disabled={textLayers.length <= 1}
                onClick={() => store.removeLayer(textLayers.length - 1)}
              >
                − {t('encrypt.layers')}
              </button>
            </div>
          </div>
        </Field>
        <div className="space-y-2">
          {info ? <Alert tone="info">{info}</Alert> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Alert tone="warn">
            文本加密同样遵循“密钥只展示一次、关闭即销毁”的规则。密文串以 {PREFIX} 开头，复制给别人前请确认密钥的传递方式同样安全。
          </Alert>
          <Alert tone="info">文本模式与文件模式共用同一套算法层栈与主密钥规则：换顺序、换算法都会得到完全不同的密文。</Alert>
        </div>
      </div>
    </Panel>
  )
}
