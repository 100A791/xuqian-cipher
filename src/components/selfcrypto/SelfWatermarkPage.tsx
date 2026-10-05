/**
 * 图片水印页（对应 SPEC §2 的 watermark_page.js）。
 *
 * 两个层次：
 *   · 公开层 / 私有层 —— LSB 写入，肉眼不可见；
 *   · **有形水印** —— 画在像素上（SPEC §3：字号为宽度的 1%~2%、透明度 15%~30%、边距 3~8px、默认取区间低端）。
 *
 * 预览用**嵌入当时冻结的参数**绘制，与下载走同一条路径 —— 避免"嵌完再改参数，预览变了但文件没变"这种误导。
 */
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../app/store.ts'
import { Alert, Field, Stat } from '../ui.tsx'
import { embedWatermark, extractWatermark } from '../../selfcrypto/watermark/extract.js'
import {
  computeTileWatermarkStyle,
  computeVisibleWatermarkStyle,
  drawVisibleWatermark,
  tileCounts,
} from '../../selfcrypto/watermark/visible.js'
import type { SelfImage } from './browser.ts'
import { downloadBlob, describeFailure, imageDataToPngBlob, imageFileToImageData, paintImageToCanvas } from './browser.ts'
import { SelfShell } from './SelfShell.tsx'

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (text: string) => {
  const clean = text.trim().toLowerCase().replace(/[^0-9a-f]/g, '')
  if (clean.length !== 32) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'] as const
type Position = (typeof POSITIONS)[number]
const MODES = ['corner', 'tile'] as const
type VisibleMode = (typeof MODES)[number]

/** 嵌入时冻结下来的有形水印参数；null = 不加有形层。 */
interface AppliedVisible {
  mode: VisibleMode
  text: string
  position: Position
}

export function SelfWatermarkPage() {
  const t = useApp((s) => s.t)
  const [image, setImage] = useState<SelfImage | null>(null)
  const [publicInfo, setPublicInfo] = useState('')
  const [privateInfo, setPrivateInfo] = useState('')
  const [keyText, setKeyText] = useState('')
  const [visibleText, setVisibleText] = useState('')
  const [withVisible, setWithVisible] = useState(false)
  const [visibleMode, setVisibleMode] = useState<VisibleMode>('corner')
  const [position, setPosition] = useState<Position>('bottom-right')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<SelfImage | null>(null)
  const [applied, setApplied] = useState<AppliedVisible | null>(null)
  const [embedded, setEmbedded] = useState<{ keyHex: string; size: string; visible: string } | null>(null)
  const [extracted, setExtracted] = useState<{ publicInfo: string | null; privateInfo: string | null; locked: boolean } | null>(null)
  const previewRef = useRef<HTMLCanvasElement | null>(null)

  // 预览：与下载共用同一条绘制路径（putImageData → 按嵌入时冻结的参数叠加有形水印）
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas || !output) return
    paintImageToCanvas(canvas, output, applied ? makeDecorator(applied) : undefined)
  }, [output, applied])

  const pick = async (file: File | undefined) => {
    setError(null)
    setEmbedded(null)
    setExtracted(null)
    setOutput(null)
    setApplied(null)
    if (!file) {
      setImage(null)
      return
    }
    try {
      setImage(await imageFileToImageData(file))
    } catch (e) {
      setError(describeFailure(e))
      setImage(null)
    }
  }

  const runEmbed = async () => {
    if (!image) {
      setError(t('sc.err.needImage'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const provided = fromHex(keyText)
      const { outputImage, keyWK } = embedWatermark(image, {
        publicInfo: publicInfo || undefined,
        privateInfo: privateInfo || undefined,
        keyWK: provided ?? undefined,
      })
      const freeze: AppliedVisible | null =
        withVisible && visibleText.trim().length > 0 ? { mode: visibleMode, text: visibleText.trim(), position } : null
      const blob = await imageDataToPngBlob(outputImage, freeze ? makeDecorator(freeze) : undefined)
      downloadBlob(blob, 'watermarked.png')
      setOutput(outputImage)
      setApplied(freeze)

      // 如实标出实际使用的参数（并核对是否落在 SPEC 区间内）
      let visibleLabel = t('sc.wm.visibleNone')
      if (freeze) {
        if (freeze.mode === 'tile') {
          const style = computeTileWatermarkStyle(outputImage, { text: freeze.text })
          const counts = tileCounts(style)
          visibleLabel = `${style.fontSize}px / ${(style.opacity * 100).toFixed(0)}% / ${style.angle}° / ${counts.total} ${t(
            'sc.wm.tileUnit',
          )}${style.legible ? '' : `（${t('sc.wm.tooSmall')}）`}`
        } else {
          const style = computeVisibleWatermarkStyle(outputImage, { text: freeze.text, position: freeze.position })
          visibleLabel = `${style.fontSize}px / ${(style.opacity * 100).toFixed(0)}% / ${style.margin}px${
            style.legible ? '' : `（${t('sc.wm.tooSmall')}）`
          }`
        }
      }
      setEmbedded({ keyHex: hex(keyWK), size: `${outputImage.width}×${outputImage.height}`, visible: visibleLabel })
    } catch (e) {
      setError(describeFailure(e))
    } finally {
      setBusy(false)
    }
  }

  const runExtract = async () => {
    if (!image) {
      setError(t('sc.err.needImage'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await extractWatermark(image, fromHex(keyText) ?? null)
      setExtracted({ publicInfo: result.publicInfo, privateInfo: result.privateInfo, locked: result.privateLocked })
    } catch (e) {
      setError(describeFailure(e))
      setExtracted(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SelfShell title={t('sc.wm.title')} description={t('sc.wm.desc')}>
      <Field label={t('sc.wm.pick')}>
        <input type="file" accept="image/*" className="xq-input" data-testid="sc-wm-input" onChange={(e) => void pick(e.target.files?.[0])} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('sc.wm.public')}>
          <input type="text" className="xq-input" data-testid="sc-wm-public" value={publicInfo} onChange={(e) => setPublicInfo(e.target.value)} />
        </Field>
        <Field label={t('sc.wm.private')}>
          <input type="text" className="xq-input" data-testid="sc-wm-private" value={privateInfo} onChange={(e) => setPrivateInfo(e.target.value)} />
        </Field>
      </div>
      <Field label={t('sc.wm.key')} hint={t('sc.wm.keyHint')}>
        <input
          type="text"
          className="xq-input xq-mono"
          data-testid="sc-wm-key"
          placeholder={t('sc.wm.keyPlaceholder')}
          value={keyText}
          onChange={(e) => setKeyText(e.target.value)}
        />
      </Field>

      <div className="flex flex-col gap-2 rounded-lg p-3" style={{ border: '1px solid var(--line, #3333)' }}>
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            data-testid="sc-wm-visible-toggle"
            checked={withVisible}
            onChange={(e) => setWithVisible(e.target.checked)}
          />
          {t('sc.wm.visible')}
        </label>
        <p className="text-[11px] xq-muted">{t('sc.wm.visibleHint')}</p>
        {withVisible ? (
          <div className="flex flex-col gap-3">
            <Field label={t('sc.wm.mode')} hint={visibleMode === 'tile' ? t('sc.wm.tileHint') : undefined}>
              <select
                className="xq-input"
                data-testid="sc-wm-mode"
                value={visibleMode}
                onChange={(e) => setVisibleMode(e.target.value as VisibleMode)}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`sc.wm.mode.${m}` as 'sc.wm.mode.corner')}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('sc.wm.visibleText')}>
                <input
                  type="text"
                  className="xq-input"
                  data-testid="sc-wm-visible-text"
                  placeholder={t('sc.wm.visiblePlaceholder')}
                  value={visibleText}
                  onChange={(e) => setVisibleText(e.target.value)}
                />
              </Field>
              {visibleMode === 'corner' ? (
                <Field label={t('sc.wm.position')}>
                  <select
                    className="xq-input"
                    data-testid="sc-wm-position"
                    value={position}
                    onChange={(e) => setPosition(e.target.value as Position)}
                  >
                    {POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {t(`sc.wm.pos.${p}` as 'sc.wm.pos.center')}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="xq-btn" data-testid="sc-wm-embed" disabled={busy || !image} onClick={runEmbed}>
          {busy ? t('sc.working') : t('sc.wm.embed')}
        </button>
        <button type="button" className="xq-btn" data-testid="sc-wm-extract" disabled={busy || !image} onClick={runExtract}>
          {t('sc.wm.extract')}
        </button>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {embedded ? (
        <div className="grid gap-2 sm:grid-cols-3" data-testid="sc-wm-embed-result">
          <Stat label={t('sc.wm.wk')} value={embedded.keyHex} mono />
          <Stat label={t('sc.wm.size')} value={embedded.size} />
          <Stat label={t('sc.wm.visibleParams')} value={embedded.visible} />
        </div>
      ) : null}

      {output ? (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-semibold">{t('sc.wm.preview')}</span>
          <canvas ref={previewRef} className="max-w-full rounded" data-testid="sc-wm-preview" style={{ border: '1px solid #3333' }} />
        </div>
      ) : null}

      {extracted ? (
        <div className="flex flex-col gap-2" data-testid="sc-wm-extract-result">
          <Stat label={t('sc.wm.public')} value={extracted.publicInfo ?? t('sc.wm.none')} />
          <Stat
            label={t('sc.wm.private')}
            value={extracted.privateInfo ?? (extracted.locked ? t('sc.wm.locked') : t('sc.wm.none'))}
          />
        </div>
      ) : null}
    </SelfShell>
  )
}

/** 由冻结参数生成"装饰回调"（预览与下载共用）。 */
function makeDecorator(frozen: AppliedVisible) {
  return (ctx: CanvasRenderingContext2D, img: SelfImage) => {
    drawVisibleWatermark(ctx, img, {
      mode: frozen.mode,
      text: frozen.text,
      // 平铺模式用不到 position，传了也会被忽略；这里显式区分以免误读
      position: frozen.mode === 'corner' ? frozen.position : undefined,
    })
  }
}
