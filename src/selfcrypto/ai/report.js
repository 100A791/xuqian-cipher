/**
 * 检测报告 —— SPEC 第 5 节阶段四「再写 report.js 生成检测报告。模块D 和模块E 共用这些分析函数，各自加权求和」。
 * 零第三方依赖（SPEC §7）。
 *
 * 模块 D：detectAIWatermark —— 找"被嵌进图里的水印"（含本项目自己的 LSB 水印）
 * 模块 E：detectAIGenerated —— 判断"图是否像 AI 生成的"
 *
 * ⚠ 诚实边界（**决策 D23**，也是 SPEC §9 第 8 项的落地）：
 *   权重与阈值是**经验初始值，未经真实样本标定**。因此报告里恒带
 *   `calibrated: false` 与明确免责声明，措辞一律是"线索/疑似"，**不得当成结论**。
 *   元数据信号（EXIF/XMP/C2PA 里出现的 AI 工具签名）是唯一可以直接证实的证据，
 *   单独列出并给最高权重；其余都是统计启发式。
 */
import { assertImage } from './helpers.js'
import { analyzeFrequency } from './frequency.js'
import { analyzeNoise, detectLsbAnomaly } from './noise.js'
import { analyzeColor } from './color.js'
import { analyzeEdge } from './edge.js'
import { scanMetadata } from './metadata_scan.js'

/** 权重（SPEC §9 第 8 项；经验初始值，未标定）。合计必须为 1。 */
export const WEIGHTS = Object.freeze({
  metadata: 0.35,
  frequency: 0.25,
  noise: 0.2,
  color: 0.1,
  edge: 0.1,
})

/** 阈值：< low 视为低、low~high 视为中、> high 视为高。 */
export const THRESHOLDS = Object.freeze({ low: 0.35, high: 0.65 })

export const CALIBRATED = false

export const DISCLAIMER =
  '本检测为启发式统计，权重与阈值未经真实样本标定，只能作为线索提示，不能作为结论；' +
  '元数据中出现的工具签名属于可核实的证据，其余项均为统计推断。'

/** 跑全部五个分析模块（模块 D/E 共用）。 */
export function analyzeAll(image, fileBytes = null) {
  assertImage(image)
  const metadata = fileBytes ? scanMetadata(fileBytes) : null
  return {
    metadata,
    frequency: analyzeFrequency(image),
    noise: analyzeNoise(image),
    color: analyzeColor(image),
    edge: analyzeEdge(image),
  }
}

const verdictOf = (score) => (score >= THRESHOLDS.high ? 'high' : score >= THRESHOLDS.low ? 'medium' : 'low')

const VERDICT_TEXT = {
  high: '有较强线索（仍不足以定论）',
  medium: '有一些线索',
  low: '线索不明显',
}

/** 组装报告对象（统一结构，便于界面渲染）。 */
export function buildReport({ kind, signals, measurements, evidence = [], extra = {} }) {
  let score = 0
  const detail = []
  for (const [name, signal] of Object.entries(signals)) {
    const weight = WEIGHTS[name] ?? 0
    const value = Math.max(0, Math.min(1, signal.score ?? 0))
    const contribution = value * weight
    score += contribution
    detail.push({ name, score: value, weight, contribution, note: signal.note ?? '', raw: signal.raw ?? null })
  }
  score = Math.max(0, Math.min(1, score))
  const verdict = verdictOf(score)
  return {
    kind,
    score,
    verdict,
    verdictText: VERDICT_TEXT[verdict],
    calibrated: CALIBRATED,
    disclaimer: DISCLAIMER,
    weights: WEIGHTS,
    thresholds: THRESHOLDS,
    signals: detail,
    measurements,
    evidence,
    ...extra,
  }
}

/**
 * 模块 D：AI 水印检测（SPEC §4）。
 * 三个信号：① 能否直接读出本项目的 LSB 水印；② LSB 平面异常；③ 元数据里的水印/溯源标记。
 */
export async function detectAIWatermark(image, options = {}) {
  assertImage(image)
  const measurements = analyzeAll(image, options.fileBytes ?? null)

  // ① 直接读本项目的 LSB 水印（最硬的证据：能读出公开头就是真的嵌过）
  let found
  let watermarkScore
  try {
    const { extractWatermark } = await import('../watermark/extract.js')
    const result = await extractWatermark(image, options.keyWK ?? null)
    found = result
    watermarkScore = 1
  } catch (error) {
    found = null
    watermarkScore = error?.code === 'WM_ABSENT' ? 0 : 0.2 // 有头但解不开（可能是别人的水印方案或损坏）
  }

  // ② LSB 异常
  const lsb = detectLsbAnomaly(image)

  // ③ 元数据痕迹
  const metadataScore = measurements.metadata && measurements.metadata.aiMarkers.length > 0 ? 1 : 0

  const evidence = []
  if (found?.publicInfo) evidence.push(`图片内含可读水印：${found.publicInfo}`)
  if (measurements.metadata?.aiMarkers?.length)
    evidence.push(`元数据含 AI 工具签名：${measurements.metadata.aiMarkers.join('、')}`)

  return buildReport({
    kind: 'ai-watermark',
    signals: {
      // 水印检测复用与 AI 生成检测同一套权重名，保证报告结构一致；
      // 这里 metadata 记"元数据痕迹"，noise 记"LSB 异常"，frequency/color/edge 不参与水印判定
      metadata: {
        score: metadataScore,
        note: '元数据中出现溯源/工具签名',
        raw: measurements.metadata?.aiMarkers ?? [],
      },
      noise: { score: lsb.score, note: 'LSB 平面异常度', raw: lsb.stats },
      frequency: {
        score: watermarkScore,
        note: '是否直接读出本项目水印',
        raw: found ? { publicInfo: found.publicInfo } : null,
      },
    },
    measurements,
    evidence,
    extra: { watermark: found, lsbAnomaly: lsb.anomaly },
  })
}

/** 模块 E：AI 生成检测（SPEC §4）。五个信号加权求和。 */
export function detectAIGenerated(image, options = {}) {
  assertImage(image)
  const measurements = analyzeAll(image, options.fileBytes ?? null)

  const markers = measurements.metadata?.aiMarkers ?? []
  const c2pa = measurements.metadata?.hasC2pa === true
  const metadataScore = markers.length > 0 ? 1 : c2pa ? 0.7 : 0

  const evidence = []
  if (markers.length > 0) evidence.push(`元数据含 AI 工具签名：${markers.join('、')}`)
  if (c2pa) evidence.push('检测到 C2PA 溯源容器（说明经过可溯源工具处理）')
  if (measurements.metadata?.exif?.Software) evidence.push(`EXIF Software：${measurements.metadata.exif.Software}`)

  return buildReport({
    kind: 'ai-generated',
    signals: {
      metadata: { score: metadataScore, note: '元数据中的工具签名 / C2PA', raw: { markers, c2pa } },
      frequency: { score: measurements.frequency.score, note: '频域能量分布异常', raw: measurements.frequency.notes },
      noise: { score: measurements.noise.score, note: '噪声/低位异常', raw: measurements.noise.notes },
      color: { score: measurements.color.score, note: '色彩与直方图异常', raw: measurements.color.notes },
      edge: { score: measurements.edge.score, note: '边缘与细节异常', raw: measurements.edge.notes },
    },
    measurements,
    evidence,
  })
}
