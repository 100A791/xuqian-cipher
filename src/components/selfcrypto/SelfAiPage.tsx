/** AI 检测页（对应 SPEC §2 的 ai_page.js）。报告恒带"未标定"声明，结论只用"线索"措辞。 */
import { useState } from 'react'
import { useApp } from '../../app/store.ts'
import { Alert, Field, Stat } from '../ui.tsx'
import { detectAIGenerated, detectAIWatermark } from '../../selfcrypto/ai/report.js'
import { describeFailure, fileToBytes, imageFileToImageData } from './browser.ts'
import { SelfShell } from './SelfShell.tsx'

type Report = ReturnType<typeof detectAIGenerated>

export function SelfAiPage() {
  const t = useApp((s) => s.t)
  const [image, setImage] = useState<{ data: Uint8Array; width: number; height: number } | null>(null)
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<Report | null>(null)
  const [watermark, setWatermark] = useState<Report | null>(null)

  const pick = async (file: File | undefined) => {
    setError(null)
    setGenerated(null)
    setWatermark(null)
    if (!file) {
      setImage(null)
      setFileBytes(null)
      return
    }
    try {
      setFileBytes(await fileToBytes(file))
      setImage(await imageFileToImageData(file))
    } catch (e) {
      setError(describeFailure(e))
      setImage(null)
    }
  }

  const run = async () => {
    if (!image) {
      setError(t('sc.err.needImage'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const options = fileBytes ? { fileBytes } : {}
      setGenerated(detectAIGenerated(image, options))
      setWatermark(await detectAIWatermark(image, options))
    } catch (e) {
      setError(describeFailure(e))
    } finally {
      setBusy(false)
    }
  }

  const renderReport = (report: Report, testId: string, title: string) => (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <Stat label={t('sc.ai.score')} value={report.score.toFixed(3)} mono />
        <Stat label={t('sc.ai.verdict')} value={report.verdictText} />
        <Stat label={t('sc.ai.calibrated')} value={report.calibrated ? t('sc.ai.yes') : t('sc.ai.no')} />
      </div>
      {report.evidence.length > 0 ? (
        <Alert tone="info">
          <span className="font-semibold">{t('sc.ai.evidence')}</span>
          <ul className="mt-1 list-disc pl-4 text-[11px]">
            {report.evidence.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <table className="w-full text-[11px]">
        <tbody>
          {report.signals.map((signal) => (
            <tr key={signal.name} style={{ borderTop: '1px solid var(--xq-line)' }}>
              <td className="py-1 pr-2 xq-mono">{signal.name}</td>
              <td className="py-1 pr-2 xq-muted">{signal.note}</td>
              <td className="py-1 pr-2 text-right xq-mono">{signal.score.toFixed(2)}</td>
              <td className="py-1 text-right xq-mono xq-muted">×{signal.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] xq-muted">{report.disclaimer}</p>
    </div>
  )

  return (
    <SelfShell title={t('sc.ai.title')} description={t('sc.ai.desc')}>
      <Field label={t('sc.ai.pick')}>
        <input
          type="file"
          accept="image/*"
          className="xq-input"
          data-testid="sc-ai-input"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </Field>
      <button type="button" className="xq-btn w-fit" data-testid="sc-ai-run" disabled={busy || !image} onClick={run}>
        {busy ? t('sc.working') : t('sc.ai.run')}
      </button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {generated ? renderReport(generated, 'sc-ai-generated', t('sc.ai.generatedTitle')) : null}
      {watermark ? renderReport(watermark, 'sc-ai-watermark', t('sc.ai.watermarkTitle')) : null}
    </SelfShell>
  )
}
