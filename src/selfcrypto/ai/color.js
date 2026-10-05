/**
 * 色彩与纹理分析 —— SPEC 第 5 节阶段四「再写 color.js 做色彩纹理分析」。
 * 零第三方依赖（SPEC §7）。
 *
 * 三个量：
 *   · saturationMean：平均饱和度。生成模型常见"高饱和/过艳"或"整体灰"两种极端。
 *   · channelCorrelation：R/G/B 三通道之间的相关系数。自然图三通道高度相关（同一场景），
 *     过度处理或合成痕迹会降低这种相关性。
 *   · histogramSmoothness：亮度直方图的"锯齿度"。自然图直方图较平滑；
 *     重压缩/重采样/合成会产生尖刺。
 */
import { assertImage, channelPlane, mean, normalize, stdDev, toLuma } from './helpers.js'

function correlation(a, b) {
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma
    const y = b[i] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  const den = Math.sqrt(da * db)
  return den === 0 ? 0 : num / den
}

/** 直方图锯齿度：相邻 bin 计数差的平均绝对值 / 计数均值。 */
export function histogramRoughness(values, bins = 64) {
  const hist = new Float64Array(bins)
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((v / 256) * bins)))
    hist[idx] += 1
  }
  const m = mean(hist)
  if (m === 0) return 0
  let diff = 0
  for (let i = 1; i < bins; i++) diff += Math.abs(hist[i] - hist[i - 1])
  return diff / (bins - 1) / m
}

/** 色彩分析结果。 */
export function analyzeColor(image) {
  assertImage(image)
  const r = channelPlane(image, 0)
  const g = channelPlane(image, 1)
  const b = channelPlane(image, 2)
  const luma = toLuma(image)

  const saturations = new Float64Array(r.length)
  for (let i = 0; i < r.length; i++) {
    const max = Math.max(r[i], g[i], b[i])
    const min = Math.min(r[i], g[i], b[i])
    saturations[i] = max === 0 ? 0 : (max - min) / max
  }
  const saturationMean = mean(saturations)

  const rg = correlation(r, g)
  const rb = correlation(r, b)
  const gb = correlation(g, b)
  const channelCorrelation = (rg + rb + gb) / 3

  const roughness = histogramRoughness(luma)
  const lumaStd = stdDev(luma)

  // 分数：相关性偏低 或 直方图过粗糙 → 提高
  const lowCorrelation = normalize(0.92 - channelCorrelation, 0, 0.3)
  const spiky = normalize(roughness - 0.35, 0, 0.5)
  const score = Math.max(lowCorrelation * 0.7, spiky)

  return {
    saturationMean,
    channelCorrelation,
    channelCorrelationDetail: { rg, rb, gb },
    histogramRoughness: roughness,
    lumaStd,
    score,
    notes: { lowCorrelation, spiky },
  }
}
