/**
 * 有形水印 —— SPEC 第 5 节阶段三「再写 visible.js 实现有形水印绘制」。
 * SPEC §3：字号为图片宽度的 1%~2%、透明度 15%~30%、边距 3~8 像素。
 * §6 阶段三验收：「有形水印不仔细看看不见」→ 默认取区间内的**低端**。
 *
 * 拆分方式（重要）：
 *   · 几何与样式计算是**纯函数**，可在 Node 里断言（本文件前半部分）；
 *   · 真正把字画到像素上依赖 Canvas 2D，浏览器专属，故只在 `drawVisibleWatermark` 里调用
 *     `ctx`，并且**不引入任何第三方绘制库**（SPEC §7）。
 *     非浏览器环境调用它会抛出明确错误，而不是静默什么都不做。
 */
import { VISIBLE_FONT_WIDTH_RATIO, VISIBLE_MARGIN_PX, VISIBLE_OPACITY } from '../common/constants.js'

/** 默认字体栈：只用系统字体，不内嵌字体文件（决策 D17：避免体积与授权问题）。 */
export const DEFAULT_FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", Arial, sans-serif'

/**
 * 有形水印的样式（模式）。做成**可扩展的 mode**而不是硬编码两种：
 *   · `corner` —— 角落/居中的单个水印（SPEC §3 的"字号/透明度/边距"就是为它定的）
 *   · `tile`   —— **全图平铺**（用户要求的"传统水印一样斜着一排排"）
 * 将来加"居中大字""单条对角线"等只是再加一个 mode。
 */
export const VISIBLE_MODES = Object.freeze(['corner', 'tile'])

/** 全图平铺的参数（SPEC 只定了字号/透明度/边距，间距与角度属本项目决策 D35）。 */
export const TILE_ANGLE_DEG = -30
export const TILE_SPACING_X_RATIO = 8 // 横向间距 = 字号 × 8
export const TILE_SPACING_Y_RATIO = 4 // 纵向间距 = 字号 × 4
export const TILE_ANGLE_RANGE = [-45, 45]

const clampToRange = (value, [min, max]) => Math.min(max, Math.max(min, value))
const inRange = (value, [min, max]) => value >= min && value <= max

/**
 * 计算有形水印的绘制参数。
 * @param {{width: number, height: number}} image
 * @param {{text: string, position?: 'bottom-right'|'bottom-left'|'top-right'|'top-left'|'center', opacity?: number, fontRatio?: number, margin?: number, fontStack?: string}} options
 */
export function computeVisibleWatermarkStyle(image, options = {}) {
  const { width, height } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('图片尺寸非法')
  }
  const position = options.position ?? 'bottom-right'
  const fontStack = options.fontStack ?? DEFAULT_FONT_STACK

  // 字号：宽度百分比，严格落在 SPEC 区间内（默认取低端，"不仔细看看不见"）。
  // 刻意**不加最小字号下限**——加了就会在小图上违反 SPEC 的 1%~2%；
  // 小到看不清属于该设置本身的后果，用 legible 标记如实告知，而不是偷偷改比例。
  const ratio = clampToRange(options.fontRatio ?? VISIBLE_FONT_WIDTH_RATIO[0], VISIBLE_FONT_WIDTH_RATIO)
  let fontSize = Math.max(1, Math.round(width * ratio))
  // 四舍五入可能把字号挤出 SPEC 的占比区间（例：1920×1% = 19.2 → 19 → 占比 0.0099 < 0.01），
  // 这里做一次校正，确保 assertStyleWithinSpec 恒成立。
  while (fontSize / width < VISIBLE_FONT_WIDTH_RATIO[0]) fontSize += 1
  while (fontSize > 1 && fontSize / width > VISIBLE_FONT_WIDTH_RATIO[1]) fontSize -= 1

  // 透明度：SPEC 区间 15%~30%，默认低端
  const opacity = clampToRange(options.opacity ?? VISIBLE_OPACITY[0], VISIBLE_OPACITY)

  // 边距：SPEC 区间 3~8 像素，默认低端
  const margin = Math.round(clampToRange(options.margin ?? VISIBLE_MARGIN_PX[0], VISIBLE_MARGIN_PX))

  return {
    text: String(options.text ?? ''),
    fontSize,
    opacity,
    margin,
    position,
    fontStack,
    width,
    height,
    /** 如实标注：按 SPEC 比例算出的字号是否还看得清（<8px 基本不可辨）。 */
    legible: fontSize >= 8,
  }
}

/** SPEC §6 阶段三验收：这些取值必须落在 SPEC 声明区间内。 */
export function assertStyleWithinSpec(style) {
  const problems = []
  if (!inRange(style.opacity, VISIBLE_OPACITY))
    problems.push(`透明度 ${style.opacity} 不在 ${VISIBLE_OPACITY.join('~')}`)
  if (!inRange(style.margin, VISIBLE_MARGIN_PX))
    problems.push(`边距 ${style.margin} 不在 ${VISIBLE_MARGIN_PX.join('~')}`)
  const ratio = style.fontSize / style.width
  if (!inRange(ratio, VISIBLE_FONT_WIDTH_RATIO)) {
    problems.push(`字号占比 ${ratio.toFixed(4)} 不在 ${VISIBLE_FONT_WIDTH_RATIO.join('~')}`)
  }
  return problems
}

/**
 * 计算**全图平铺**水印的绘制参数。
 * 字号与透明度沿用 SPEC §3 的区间（默认取低端）；间距与角度 SPEC 未定，取决策 D35 的经验值。
 */
export function computeTileWatermarkStyle(image, options = {}) {
  const { width, height } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('图片尺寸非法')
  }
  const ratio = clampToRange(options.fontRatio ?? VISIBLE_FONT_WIDTH_RATIO[0], VISIBLE_FONT_WIDTH_RATIO)
  let fontSize = Math.max(1, Math.round(width * ratio))
  while (fontSize / width < VISIBLE_FONT_WIDTH_RATIO[0]) fontSize += 1
  while (fontSize > 1 && fontSize / width > VISIBLE_FONT_WIDTH_RATIO[1]) fontSize -= 1

  const opacity = clampToRange(options.opacity ?? VISIBLE_OPACITY[0], VISIBLE_OPACITY)
  const angle = clampToRange(options.angle ?? TILE_ANGLE_DEG, TILE_ANGLE_RANGE)
  const spacingX = Math.max(1, Math.round(fontSize * (options.spacingX ?? TILE_SPACING_X_RATIO)))
  const spacingY = Math.max(1, Math.round(fontSize * (options.spacingY ?? TILE_SPACING_Y_RATIO)))

  return {
    mode: 'tile',
    text: String(options.text ?? ''),
    fontSize,
    opacity,
    angle,
    spacingX,
    spacingY,
    fontStack: options.fontStack ?? DEFAULT_FONT_STACK,
    width,
    height,
    legible: fontSize >= 8,
  }
}

/** 平铺水印要画多少条：以"旋转后仍能盖满全图"为准（外接圆直径 / 间距）。 */
export function tileCounts(style) {
  const reach = Math.ceil(Math.hypot(style.width, style.height) / 2) + style.fontSize
  const cols = Math.max(1, Math.ceil((reach * 2) / style.spacingX))
  const rows = Math.max(1, Math.ceil((reach * 2) / style.spacingY))
  return { reach, cols, rows, total: cols * rows }
}

/** 由位置与字号算出绘制坐标（纯函数，Node 可测）。 */
export function computeTextAnchor(style, textWidth, textHeight) {
  const { width, height, margin, position } = style
  let x
  let y
  if (position === 'center') {
    x = Math.round((width - textWidth) / 2)
    y = Math.round((height + textHeight) / 2)
  } else {
    const right = position.endsWith('right')
    const bottom = position.startsWith('bottom')
    x = right ? width - margin - textWidth : margin
    y = bottom ? height - margin : margin + textHeight
  }
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }
}

/**
 * 在 Canvas 2D 上下文上绘制**全图平铺**水印（用户要求的"传统水印一样斜着一排排"）。
 *
 * 做法：把坐标系平移到图片中心并旋转 `angle`，然后在**旋转后的外接圆**范围内按网格重复绘制。
 * 用外接圆（对角线长度）而不是图片本身的宽高，才能保证旋转后四角也被盖满、不留空白带。
 * 奇数行横向错开半个间距，视觉上更像传统防盗图水印。
 */
export function drawTiledWatermark(ctx, image, options = {}) {
  if (!ctx || typeof ctx.fillText !== 'function') {
    throw new TypeError('drawTiledWatermark 需要 Canvas 2D 上下文（浏览器环境）')
  }
  const style = computeTileWatermarkStyle(image, options)
  if (style.text.length === 0) return style

  const { reach, cols, rows, total } = tileCounts(style)
  ctx.save()
  ctx.font = `${style.fontSize}px ${style.fontStack}`
  ctx.globalAlpha = style.opacity
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = options.color ?? '#ffffff'
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'
  ctx.lineWidth = 1
  ctx.translate(style.width / 2, style.height / 2)
  ctx.rotate((style.angle * Math.PI) / 180)

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const stagger = row % 2 === 1 ? style.spacingX / 2 : 0
      const x = -reach + col * style.spacingX + stagger
      const y = -reach + row * style.spacingY
      ctx.fillText(style.text, x, y)
      ctx.strokeText(style.text, x, y)
    }
  }
  ctx.restore()
  return { ...style, tiles: total }
}

/**
 * 在 Canvas 2D 上下文上绘制有形水印（浏览器专属）。
 * 按 `options.mode` 分派：`corner`（默认，角落/居中单个）或 `tile`（全图平铺）。
 * @param {CanvasRenderingContext2D} ctx
 */
export function drawVisibleWatermark(ctx, image, options = {}) {
  if (!ctx || typeof ctx.fillText !== 'function' || typeof ctx.measureText !== 'function') {
    throw new TypeError('drawVisibleWatermark 需要 Canvas 2D 上下文（浏览器环境）')
  }
  if (options.mode === 'tile') return drawTiledWatermark(ctx, image, options)

  const style = computeVisibleWatermarkStyle(image, options)
  if (style.text.length === 0) return style

  ctx.save()
  ctx.font = `${style.fontSize}px ${style.fontStack}`
  const metrics = ctx.measureText(style.text)
  const anchor = computeTextAnchor(style, metrics.width, style.fontSize)
  ctx.globalAlpha = style.opacity
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = options.color ?? '#ffffff'
  // 轻微描边保证浅色/深色底都能看见，但保持低透明度所以"不仔细看看不见"
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'
  ctx.lineWidth = 1
  ctx.fillText(style.text, anchor.x, anchor.y)
  ctx.strokeText(style.text, anchor.x, anchor.y)
  ctx.restore()
  return style
}
