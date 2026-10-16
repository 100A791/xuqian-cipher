/**
 * 噪声与低位分析 —— SPEC 第 5 节阶段四「再写 noise.js 做传感器噪声和 PRNU 分析」，
 * 以及 SPEC §6 阶段四验收里的「能检测 LSB 异常」。
 * 零第三方依赖（SPEC §7）。
 *
 * 三个量：
 *   · lsbEntropy / lsbBias：最低有效位平面的熵与偏置。自然图低位接近随机（熵≈1、偏置≈0）；
 *     被 LSB 写入过、或被重度量化/重压缩的图会明显偏离 —— 这就是"LSB 异常"。
 *   · residualStd：拉普拉斯高通残差的标准差，近似传感器噪声水平（PRNU 思路的简化版）。
 *
 * **如实说明**：真正的 PRNU 需要多张同源图做相关分析才算数，单图只能给出残差强度这类
 * 弱指标。这里不做"假装是 PRNU"的计算（决策 D22）。
 */
import { assertImage, channelPlane, mean, normalize, stdDev, toLuma } from './helpers.js'

/** LSB 平面统计（三个颜色通道合起来）。 */
export function lsbPlaneStats(image) {
  assertImage(image)
  let ones = 0
  let count = 0
  let transitions = 0
  let prev = null
  for (let c = 0; c < 3; c++) {
    const plane = channelPlane(image, c)
    for (const v of plane) {
      const bit = v & 1
      ones += bit
      count += 1
      if (prev !== null && prev !== bit) transitions += 1
      prev = bit
    }
  }
  const p1 = count === 0 ? 0.5 : ones / count
  const p0 = 1 - p1
  const entropy = -(p0 > 0 ? p0 * Math.log2(p0) : 0) - (p1 > 0 ? p1 * Math.log2(p1) : 0)
  return {
    onesRatio: p1,
    bias: Math.abs(p1 - 0.5),
    entropy,
    transitionRatio: count > 1 ? transitions / (count - 1) : 0,
  }
}

/** 拉普拉斯高通残差的强度。 */
export function residualStrength(luma, width, height) {
  const residuals = new Float64Array(Math.max(0, (width - 2) * (height - 2)))
  let k = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = luma[y * width + x]
      residuals[k++] =
        4 * c -
        luma[(y - 1) * width + x] -
        luma[(y + 1) * width + x] -
        luma[y * width + x - 1] -
        luma[y * width + x + 1]
    }
  }
  return { std: stdDev(residuals), meanAbs: mean(Array.from(residuals, Math.abs)) }
}

/** SPEC §6 阶段四验收：LSB 异常检测。返回 { anomaly, score, stats }。 */
export function detectLsbAnomaly(image) {
  const stats = lsbPlaneStats(image)
  // 自然图：熵接近 1（≈0.99+）、偏置接近 0、相邻位翻转率接近 0.5
  const entropyDrop = normalize(0.98 - stats.entropy, 0, 0.3)
  const biasScore = normalize(stats.bias, 0.01, 0.15)
  const transitionAnomaly = normalize(Math.abs(stats.transitionRatio - 0.5), 0.02, 0.2)
  const score = Math.max(entropyDrop, biasScore, transitionAnomaly)
  return { anomaly: score > 0.5, score, stats }
}

/** 噪声分析结果。 */
export function analyzeNoise(image) {
  assertImage(image)
  const luma = toLuma(image)
  const lsb = detectLsbAnomaly(image)
  const residual = residualStrength(luma, image.width, image.height)
  // 残差过低 = 过度平滑（AI 常见）；过低/过高都提高分数，但主要盯"过低"
  const tooClean = normalize(1.5 - residual.std, 0, 1.5)
  const score = Math.max(tooClean * 0.6, lsb.score)
  return {
    lsbEntropy: lsb.stats.entropy,
    lsbBias: lsb.stats.bias,
    lsbTransitionRatio: lsb.stats.transitionRatio,
    lsbAnomaly: lsb.anomaly,
    residualStd: residual.std,
    residualMeanAbs: residual.meanAbs,
    score,
    notes: { tooClean, lsbScore: lsb.score },
  }
}
