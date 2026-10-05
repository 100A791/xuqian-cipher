/**
 * AI 检测各模块共用的图像统计助手。
 *
 * 说明：SPEC §2 的 ai 目录只列了 metadata_scan / frequency / noise / color / edge / report 六个文件，
 * 本文件是**额外新增**的（决策 D19）——六个分析模块都要做"灰度化 / 分块 / 卷积"，
 * 与其在六处各写一遍（必然随时间分叉），不如集中一处。
 *
 * 只做纯计算，不引入任何第三方库（SPEC §7）。
 */

/** 图片尺寸与字节数校验（与 watermark/lsb.js 相同的表示约定）。 */
export function assertImage(image) {
  if (!image || !(image.data instanceof Uint8Array)) throw new TypeError('图片必须是 { data, width, height }')
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new RangeError('图片尺寸非法')
  }
  if (image.data.length !== image.width * image.height * 4) throw new RangeError('图片字节数与尺寸不符')
  return image
}

/** 灰度（BT.601 权重），返回 width×height 的 Float64Array。 */
export function toLuma(image) {
  assertImage(image)
  const { data, width, height } = image
  const out = new Float64Array(width * height)
  for (let p = 0; p < width * height; p++) {
    const i = p * 4
    out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return out
}

/** 逐通道取平面（0=R 1=G 2=B）。 */
export function channelPlane(image, channel) {
  assertImage(image)
  if (channel < 0 || channel > 2) throw new RangeError('通道必须是 0/1/2')
  const { data, width, height } = image
  const out = new Float64Array(width * height)
  for (let p = 0; p < width * height; p++) out[p] = data[p * 4 + channel]
  return out
}

/** 均值。 */
export function mean(values) {
  let sum = 0
  for (const v of values) sum += v
  return values.length === 0 ? 0 : sum / values.length
}

/** 总体标准差。 */
export function stdDev(values) {
  if (values.length === 0) return 0
  const m = mean(values)
  let acc = 0
  for (const v of values) acc += (v - m) * (v - m)
  return Math.sqrt(acc / values.length)
}

/**
 * 8×8 分块迭代（跳过不满块）。JPEG 类压缩与生成模型的频域痕迹都在 8×8 网格上，
 * 因此频域分析统一以 8×8 为粒度。
 */
export function forEachBlock(luma, width, height, size, fn) {
  const bw = Math.floor(width / size)
  const bh = Math.floor(height / size)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const block = new Float64Array(size * size)
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          block[y * size + x] = luma[(by * size + y) * width + (bx * size + x)]
        }
      }
      fn(block, bx, by)
    }
  }
  return { blocksX: bw, blocksY: bh }
}

/**
 * 二维 DCT-II（可分离：先行后列）。size 固定为 8 时即 JPEG 用的变换。
 * 只做正变换——检测只需要频域能量分布，不需要逆变换。
 */
export function dct2d(block, size = 8) {
  const tmp = new Float64Array(size * size)
  const out = new Float64Array(size * size)
  const c = (u) => (u === 0 ? Math.SQRT1_2 : 1)
  // 行变换
  for (let y = 0; y < size; y++) {
    for (let u = 0; u < size; u++) {
      let sum = 0
      for (let x = 0; x < size; x++) {
        sum += block[y * size + x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size))
      }
      tmp[y * size + u] = 0.5 * c(u) * sum
    }
  }
  // 列变换
  for (let u = 0; u < size; u++) {
    for (let v = 0; v < size; v++) {
      let sum = 0
      for (let y = 0; y < size; y++) {
        sum += tmp[y * size + u] * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size))
      }
      out[v * size + u] = 0.5 * c(v) * sum
    }
  }
  return out
}

/** 高频能量占比：DCT 系数中"距直流越远"的能量占比。 */
export function highFrequencyRatio(coeffs, size = 8) {
  let total = 0
  let high = 0
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const e = coeffs[v * size + u] * coeffs[v * size + u]
      total += e
      // 以 u+v >= size 视为高频（经验界限，见决策 D21）
      if (u + v >= size) high += e
    }
  }
  return total === 0 ? 0 : high / total
}

/** Sobel 梯度幅值图（3×3），边界按复制处理。 */
export function sobelMagnitude(luma, width, height) {
  const out = new Float64Array(width * height)
  const at = (x, y) => luma[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
      out[y * width + x] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return out
}

/** 把 [0,1] 之外的分数夹回区间。 */
export const clamp01 = (v) => Math.min(1, Math.max(0, v))

/** 线性映射到 [0,1]（用于把原始指标转成分数）。 */
export function normalize(value, min, max) {
  if (max === min) return 0
  return clamp01((value - min) / (max - min))
}
