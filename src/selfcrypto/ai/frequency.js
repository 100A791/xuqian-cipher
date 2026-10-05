/**
 * 频域分析 —— SPEC 第 5 节阶段四「再写 frequency.js 做 DCT FFT DWT 分析」。
 * 零第三方依赖（SPEC §7）。
 *
 * 三种变换都在这个文件里（SPEC 就是把它们划给 frequency.js 的）：
 *   · **DCT** 8×8（JPEG 同款网格）：块内高频占比、blockiness、平滑度
 *   · **FFT** 2D（基数-2 Cooley-Tukey，行-列分离）：径向功率谱 + 谱斜率 + 谱峰占比
 *   · **DWT** Haar 2 级：LL/LH/HL/HH 子带能量分布
 *
 * 为什么三种都要：它们看的是不同的东西 —— DCT 看 8×8 局部块、FFT 看全局频率分布、
 * DWT 看多尺度细节。只看一种容易把"过平滑"和"强压缩"混为一谈。
 */
import { assertImage, dct2d, forEachBlock, highFrequencyRatio, mean, normalize, stdDev, toLuma } from './helpers.js'

export const BLOCK = 8

/** 块间/块内梯度比：>1 说明 8×8 网格上留下了压缩痕迹。 */
export function computeBlockiness(luma, width, height, size = BLOCK) {
  let boundary = 0
  let boundaryCount = 0
  let inner = 0
  let innerCount = 0
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const d = Math.abs(luma[y * width + x] - luma[y * width + x - 1]) + Math.abs(luma[y * width + x] - luma[(y - 1) * width + x])
      if (x % size === 0 || y % size === 0) {
        boundary += d
        boundaryCount += 1
      } else {
        inner += d
        innerCount += 1
      }
    }
  }
  const b = boundaryCount ? boundary / boundaryCount : 0
  const i = innerCount ? inner / innerCount : 0
  return i === 0 ? (b === 0 ? 1 : 2) : b / i
}

/** 频域分析结果。 */
export function analyzeFrequency(image) {
  assertImage(image)
  const { width, height } = image
  const luma = toLuma(image)

  const highs = []
  const lows = []
  forEachBlock(luma, width, height, BLOCK, (block) => {
    const coeffs = dct2d(block, BLOCK)
    highs.push(highFrequencyRatio(coeffs, BLOCK))
    lows.push(1 - highFrequencyRatio(coeffs, BLOCK))
  })

  const highFreqRatio = mean(highs)
  const smoothness = mean(lows)
  const blockiness = computeBlockiness(luma, width, height, BLOCK)
  const lumaStd = stdDev(luma)
  const blockVariance = stdDev(highs)

  // 另外两种变换（见文件头说明）
  const spectral = analyzeSpectral(luma, width, height)

  // 分数：高频"过低"（过度平滑）或"过高"（噪声感）都偏离自然图经验区，取两者较大者；
  // 再叠加谱斜率与多尺度细节给的线索。
  const tooSmooth = normalize(0.12 - highFreqRatio, 0, 0.12)
  const tooNoisy = normalize(highFreqRatio - 0.45, 0, 0.3)
  const score = Math.max(tooSmooth, tooNoisy, spectral.score)

  return {
    highFreqRatio,
    smoothness,
    blockiness,
    lumaStd,
    blockVariance,
    blockCount: highs.length,
    spectralSlope: spectral.slope,
    spectralPeakRatio: spectral.peakRatio,
    detailEnergyRatio: spectral.detailEnergyRatio,
    fftSize: spectral.size,
    dwtLevels: spectral.levels,
    score,
    notes: {
      tooSmooth,
      tooNoisy,
      jpegLikely: blockiness > 1.15,
      slopeAbnormal: spectral.notes.slopeAbnormal,
      peakySpectrum: spectral.notes.peaky,
      dwtTooFlat: spectral.notes.tooFlat,
    },
  }
}

// ---------------------------------------------------------------------------
// FFT（基数-2，迭代 Cooley-Tukey）—— 原地、行-列分离做二维
// ---------------------------------------------------------------------------

/** 就地一维 FFT；长度必须是 2 的幂。inverse=true 时做逆变换（含 1/N 归一）。 */
export function fft1d(re, im, inverse = false) {
  const n = re.length
  if (n === 0 || (n & (n - 1)) !== 0) throw new RangeError('FFT 长度必须是 2 的幂')
  if (im.length !== n) throw new RangeError('实部与虚部长度必须一致')

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
  return { re, im }
}

/** 把平面裁剪/补零到 N×N（N 为 2 的幂）。**不加窗**，供 DWT 等需要保持信号原样的分析用。 */
export function cropPlane(luma, width, height, n) {
  const out = new Float64Array(n * n)
  const offsetX = Math.max(0, Math.floor((width - n) / 2))
  const offsetY = Math.max(0, Math.floor((height - n) / 2))
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const sx = offsetX + x
      const sy = offsetY + y
      out[y * n + x] = sx < width && sy < height ? luma[sy * width + sx] : 0
    }
  }
  return out
}

/** 裁剪到 N×N 并加 Hann 窗（抑制边界泄漏，供 FFT 用）。 */
export function prepareSquare(luma, width, height, n) {
  const out = cropPlane(luma, width, height, n)
  for (let y = 0; y < n; y++) {
    const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / (n - 1))
    for (let x = 0; x < n; x++) {
      const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / (n - 1))
      out[y * n + x] *= wx * wy
    }
  }
  return out
}

/** 二维 FFT（对 N×N 平面）；返回幅度谱（未移位，DC 在 [0]）。 */
export function fft2dMagnitude(plane, n) {
  const re = Float64Array.from(plane)
  const im = new Float64Array(n * n)
  const rowRe = new Float64Array(n)
  const rowIm = new Float64Array(n)
  // 行变换
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      rowRe[x] = re[y * n + x]
      rowIm[x] = 0
    }
    fft1d(rowRe, rowIm, false)
    for (let x = 0; x < n; x++) {
      re[y * n + x] = rowRe[x]
      im[y * n + x] = rowIm[x]
    }
  }
  // 列变换
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      rowRe[y] = re[y * n + x]
      rowIm[y] = im[y * n + x]
    }
    fft1d(rowRe, rowIm, false)
    for (let y = 0; y < n; y++) {
      re[y * n + x] = rowRe[y]
      im[y * n + x] = rowIm[y]
    }
  }
  const mag = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) mag[i] = Math.hypot(re[i], im[i])
  return mag
}

/** 径向平均功率谱：把 2D 谱按到中心的距离分桶并取平均。 */
export function radialPowerSpectrum(mag, n, bins = 32) {
  const power = new Float64Array(bins)
  const counts = new Float64Array(bins)
  const half = n / 2
  const maxR = Math.hypot(half, half)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // 把频率轴移到中心（fftshift）
      const fx = x < half ? x : x - n
      const fy = y < half ? y : y - n
      const r = Math.hypot(fx, fy)
      if (r < 1e-9) continue
      const bin = Math.min(bins - 1, Math.floor((r / maxR) * bins))
      power[bin] += mag[y * n + x] * mag[y * n + x]
      counts[bin] += 1
    }
  }
  const out = new Float64Array(bins)
  for (let i = 0; i < bins; i++) out[i] = counts[i] > 0 ? power[i] / counts[i] : 0
  return out
}

/**
 * 谱斜率：对 log(功率) ~ log(频率) 做线性拟合（只取非零桶）。
 * 自然图像通常接近 1/f²（斜率约 -2）；过度平滑会明显更陡，噪声化/锐化会更平。
 */
export function estimateSpectralSlope(radial) {
  const xs = []
  const ys = []
  for (let i = 1; i < radial.length; i++) {
    if (radial[i] > 0) {
      xs.push(Math.log(i))
      ys.push(Math.log(radial[i]))
    }
  }
  if (xs.length < 4) return { slope: 0, intercept: 0, samples: xs.length }
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) * (xs[i] - mx)
  }
  const slope = den === 0 ? 0 : num / den
  return { slope, intercept: my - slope * mx, samples: xs.length }
}

/** 谱峰占比：最大的少数几个频点占总能量的比例（合成图/上采样振铃会偏大）。 */
export function spectralPeakRatio(mag, n, topK = 12) {
  const values = Array.from(mag)
  values[0] = 0 // 排除 DC
  let total = 0
  for (const v of values) total += v * v
  if (total === 0) return 0
  const sorted = values.slice().sort((a, b) => b * b - a * a)
  let top = 0
  for (let i = 0; i < Math.min(topK, sorted.length); i++) top += sorted[i] * sorted[i]
  return top / total
}

// ---------------------------------------------------------------------------
// DWT（Haar，2 级）—— 多尺度细节能量
// ---------------------------------------------------------------------------

/**
 * 二维 Haar 小波一级分解：返回 { ll, lh, hl, hh }（各占 1/4）。
 * 用正交归一化系数（1/2），保证能量守恒，便于比较各子带占比。
 */
export function haarDwt2d(plane, width, height) {
  const hw = Math.floor(width / 2)
  const hh = Math.floor(height / 2)
  const ll = new Float64Array(hw * hh)
  const lh = new Float64Array(hw * hh)
  const hl = new Float64Array(hw * hh)
  const hhBand = new Float64Array(hw * hh)
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const a = plane[(2 * y) * width + 2 * x]
      const b = plane[(2 * y) * width + 2 * x + 1]
      const c = plane[(2 * y + 1) * width + 2 * x]
      const d = plane[(2 * y + 1) * width + 2 * x + 1]
      const i = y * hw + x
      ll[i] = (a + b + c + d) / 2
      lh[i] = (a - b + c - d) / 2
      hl[i] = (a + b - c - d) / 2
      hhBand[i] = (a - b - c + d) / 2
    }
  }
  return { ll, lh, hl, hh: hhBand, width: hw, height: hh }
}

const energy = (arr) => {
  let sum = 0
  for (const v of arr) sum += v * v
  return sum
}

/** 多级 Haar 分解的各子带能量占比。 */
export function dwtEnergyProfile(luma, width, height, levels = 2) {
  const bands = []
  let current = { ll: Float64Array.from(luma), width, height }
  for (let level = 0; level < levels; level++) {
    if (current.width < 4 || current.height < 4) break
    const decomposed = haarDwt2d(current.ll, current.width, current.height)
    const llE = energy(decomposed.ll)
    const lhE = energy(decomposed.lh)
    const hlE = energy(decomposed.hl)
    const hhE = energy(decomposed.hh)
    const total = llE + lhE + hlE + hhE
    bands.push({
      level: level + 1,
      ll: total ? llE / total : 0,
      lh: total ? lhE / total : 0,
      hl: total ? hlE / total : 0,
      hh: total ? hhE / total : 0,
      detail: total ? (lhE + hlE + hhE) / total : 0,
    })
    current = { ll: decomposed.ll, width: decomposed.width, height: decomposed.height }
  }
  return bands
}

/**
 * 合并 FFT 与 DWT 的线索（供 analyzeFrequency 使用）。
 * 全部是**经验判据**（未标定，同 D23），只作为线索分，不当作结论。
 */
export function analyzeSpectral(luma, width, height, options = {}) {
  const size = options.size ?? 256
  // FFT 用加窗的裁剪（抑制边界泄漏）；DWT 用**不加窗**的同一裁剪
  // —— 加窗会改信号，拿去做多尺度细节分析会得到错的子带能量。
  // 两者都限制在 size×size，避免大照片产生几百 MB 的中间数组。
  const plane = prepareSquare(luma, width, height, size)
  const mag = fft2dMagnitude(plane, size)
  const radial = radialPowerSpectrum(mag, size, options.bins ?? 32)
  const { slope } = estimateSpectralSlope(radial)
  const peakRatio = spectralPeakRatio(mag, size, options.topK ?? 12)
  const bands = dwtEnergyProfile(cropPlane(luma, width, height, size), size, size, options.levels ?? 2)
  const detailEnergyRatio = bands.length > 0 ? bands[0].detail : 0

  // 自然图斜率大致落在 [-2.6, -1.2]；偏离越多越可疑（经验区间）
  const slopeDeviation = slope > 0 ? 1 : Math.min(1, Math.abs(slope + 1.9) / 1.4)
  const peaky = normalize(peakRatio - 0.02, 0, 0.15)
  const tooFlat = normalize(0.06 - detailEnergyRatio, 0, 0.06)
  const score = Math.max(slopeDeviation * 0.8, peaky, tooFlat * 0.7)

  return {
    size,
    levels: bands.length,
    slope,
    peakRatio,
    detailEnergyRatio,
    bands,
    score,
    notes: { slopeAbnormal: slopeDeviation > 0.6, peaky: peaky > 0.5, tooFlat: tooFlat > 0.5 },
  }
}
