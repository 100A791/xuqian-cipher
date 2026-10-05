/**
 * 边缘与细节分析 —— SPEC 第 5 节阶段四「再写 edge.js 做边缘细节分析」。
 * 零第三方依赖（SPEC §7）。
 *
 * 三个量：
 *   · edgeMean / edgeDensity：Sobel 梯度均值与"显著边缘"的占比。
 *   · detailRatio：高频细节（梯度）与低频结构（灰度标准差）的比值。
 *     生成模型常出现"结构完整但细节缺失"——比值偏低。
 *   · edgeUniformity：边缘强度的变异系数。过于均匀的边缘分布常见于合成图。
 */
import { assertImage, clamp01, mean, normalize, sobelMagnitude, stdDev, toLuma } from './helpers.js'

/** 边缘分析结果。 */
export function analyzeEdge(image) {
  assertImage(image)
  const { width, height } = image
  const luma = toLuma(image)
  const mag = sobelMagnitude(luma, width, height)

  const edgeMean = mean(mag)
  const edgeStd = stdDev(mag)
  const threshold = edgeMean * 2
  let strong = 0
  for (const v of mag) if (v > threshold) strong += 1
  const edgeDensity = strong / mag.length

  const lumaStd = stdDev(luma)
  const detailRatio = lumaStd === 0 ? 0 : edgeMean / lumaStd
  const edgeUniformity = edgeMean === 0 ? 0 : edgeStd / edgeMean

  // 分数：细节比偏低（结构在但细节少）→ 提高；边缘过于均匀 → 略微提高
  const lowDetail = normalize(0.06 - detailRatio, 0, 0.06)
  const uniform = normalize(0.55 - clamp01(edgeUniformity / 3), 0, 0.55)
  const score = Math.max(lowDetail * 0.8, uniform * 0.5)

  return {
    edgeMean,
    edgeStd,
    edgeDensity,
    detailRatio,
    edgeUniformity,
    score,
    notes: { lowDetail, uniform },
  }
}
