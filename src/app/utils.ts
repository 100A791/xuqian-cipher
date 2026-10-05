/** 通用前端工具：文件读写、下载、格式化、剪贴板。 */
import { decryptContainer, parseHeader, type XuqianHeader } from '../crypto/container.ts'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`
}

export function formatPercent(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} min ${seconds} s`
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer()
}

export function readFileAsText(file: File): Promise<string> {
  return file.text()
}

export function saveBlob(data: BlobPart, fileName: string, mime = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 交给浏览器完成下载后再释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function saveText(text: string, fileName: string, mime = 'text/plain;charset=utf-8'): void {
  saveBlob(text, fileName, mime)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 回退到 execCommand */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/** 尽力清除剪贴板（需要页面处于聚焦状态；失败时静默）。 */
export async function clearClipboard(): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && document.hasFocus()) {
      await navigator.clipboard.writeText(' ')
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

export interface DroppedEntry {
  file: File
  /** 相对于拖入根目录的路径（含文件名） */
  path: string
}

const IGNORED_DIR_NAMES = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db'])

/** 把拖入的 DataTransfer 展开为文件列表（支持文件夹递归）。 */
export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedEntry[]> {
  const out: DroppedEntry[] = []
  const items = Array.from(dataTransfer.items ?? [])
  const entries: FileSystemEntry[] = []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  if (entries.length === 0) {
    for (const file of Array.from(dataTransfer.files ?? [])) {
      if (!IGNORED_DIR_NAMES.has(file.name)) out.push({ file, path: file.name })
    }
    return out
  }

  for (const entry of entries) await walkEntry(entry, '', out)
  return out
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: DroppedEntry[]): Promise<void> {
  if (IGNORED_DIR_NAMES.has(entry.name)) return
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry)
    out.push({ file, path: prefix + entry.name })
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    let batch: FileSystemEntry[] = []
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      )
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out)
    } while (batch.length > 0)
  }
}

/** 读取 .XUQIAN 文件头（只读前 64 KiB），用于展示算法与层数。 */
export async function peekHeader(file: File): Promise<XuqianHeader | null> {
  try {
    const slice = file.slice(0, 64 * 1024)
    const buf = new Uint8Array(await slice.arrayBuffer())
    return parseHeader(buf).header
  } catch {
    return null
  }
}

/** 完整的解密（主线程，仅用于小文件/自检；正常流程走 Worker）。 */
export async function decryptInMainThread(file: File, key: Parameters<typeof decryptContainer>[1]) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return decryptContainer(bytes, key)
}

/** 输出文件名安全化：去掉路径分隔符与危险字符。 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200)
}

/** 从相对路径取目录部分（含结尾斜杠，没有则为空串）。 */
export function dirOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index + 1)
}

export function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

export function bytesToBlobPart(bytes: ArrayBuffer | Uint8Array): BlobPart {
  return bytes instanceof Uint8Array ? (bytes.slice().buffer as ArrayBuffer) : bytes
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** 本地时间格式化（日志展示用）。 */
export function formatTS(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
