/**
 * 自研路线界面层的浏览器粘合 —— 只做"文件 ↔ 字节 ↔ 图片 ↔ 下载"的搬运，
 * 不含任何算法（对应 SPEC §2 的 src/ui，决策 D25：用现有 React 栈而非原生 JS）。
 *
 * 失败提示统一走这里：内核失败已归一为同一句话，其它异常也收敛成同一口径，
 * 与 SPEC §5 阶段五「所有失败统一提示」一致（延迟由 common/fail.js 负责）。
 */

/** 自研路线统一使用的图片表示（与 watermark/lsb.js 的约定一致）。 */
export interface SelfImage {
  data: Uint8Array
  width: number
  height: number
}

/** 读文件为字节。 */
export async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

/** 触发浏览器下载。 */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), filename)
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立刻撤销会让部分浏览器取消下载，延迟撤销更稳
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 图片文件 → 像素。
 * 注意：拿到的是**解码后的像素**，与"原始文件字节"不同——元数据扫描要用后者。
 */
export async function imageFileToImageData(file: File): Promise<SelfImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = makeCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
    if (!ctx) throw new Error('无法获取 Canvas 2D 上下文')
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const copy = new Uint8Array(imageData.data.length)
    copy.set(imageData.data)
    return { data: copy, width: bitmap.width, height: bitmap.height }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

/**
 * 把像素画到画布上，随后可选地"装饰"（用于叠加有形水印）。
 * 预览与导出**共用这一个函数**，保证"看到的"就是"下载到的"。
 */
export function paintImageToCanvas(
  canvas: HTMLCanvasElement,
  image: SelfImage,
  decorate?: (ctx: CanvasRenderingContext2D, image: SelfImage) => void,
): void {
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null
  if (!ctx) throw new Error('无法获取 Canvas 2D 上下文')
  const clamped = new Uint8ClampedArray(image.data.length)
  clamped.set(image.data)
  ctx.putImageData(new ImageData(clamped, image.width, image.height), 0, 0)
  if (decorate) decorate(ctx, image)
}

/** 把像素导出为 PNG（PNG 无损，才不会毁掉 LSB 水印）。 */
export function imageDataToPngBlob(
  image: SelfImage,
  decorate?: (ctx: CanvasRenderingContext2D, image: SelfImage) => void,
): Promise<Blob> {
  const canvas = makeCanvas(image.width, image.height)
  paintImageToCanvas(canvas, image, decorate)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('导出 PNG 失败'))), 'image/png')
  })
}

/** 创建画布；无 DOM 时退回 OffscreenCanvas，两者都没有则明确报错。 */
export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('当前环境不支持 Canvas')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** 人类可读的字节数（界面展示用；二进制单位，与浏览器配额口径一致）。 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`
}

/** 内核层归一后的统一失败文案。 */
export const UNIFORM_FAILURE_TEXT = '解密失败'

export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === UNIFORM_FAILURE_TEXT) return UNIFORM_FAILURE_TEXT
  const code = (error as { code?: string } | null)?.code
  if (code === 'WM_ABSENT') return '未找到可识别的水印'
  if (code === 'WM_CAPACITY_EXCEEDED') return '这张图放不下这么多水印信息（换大一点的图或减少内容）'
  if (code === 'IMAGE_INVALID') return '图片数据不完整'
  if (message) return message
  return '操作失败'
}
