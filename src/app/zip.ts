/**
 * 最小 ZIP 打包器（仅 store 模式，无压缩）。
 *
 * 为什么自己写：批量加密需要"保持目录结构"的 ZIP 输出，而 .XUQIAN 密文本身已不可压缩，
 * 因此只需要 store 模式。实现遵循 PKZIP APPNOTE 4.3.6（本地文件头 / 中央目录 / EOCD），
 * 用 CRC-32 校验，不引入额外依赖。
 *
 * 限制：单文件 < 4 GiB，总大小 < 4 GiB（未使用 ZIP64）。
 */

export interface ZipEntry {
  /** 目录内的相对路径，使用 / 分隔 */
  path: string
  data: Uint8Array
  /** 修改时间（用于 ZIP 时间戳） */
  modified?: Date
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true)
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true)
}

/** 生成 ZIP 字节。 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path.replace(/\\/g, '/'))
    const data = entry.data
    const checksum = crc32(data)
    const { time, date } = dosDateTime(entry.modified ?? new Date())

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    writeU32(localView, 0, 0x04034b50) // local file header signature
    writeU16(localView, 4, 20) // version needed
    writeU16(localView, 6, 0x0800) // flags: UTF-8 文件名
    writeU16(localView, 8, 0) // method: store
    writeU16(localView, 10, time)
    writeU16(localView, 12, date)
    writeU32(localView, 14, checksum)
    writeU32(localView, 18, data.length)
    writeU32(localView, 22, data.length)
    writeU16(localView, 26, nameBytes.length)
    writeU16(localView, 28, 0) // extra length
    local.set(nameBytes, 30)

    chunks.push(local, data)

    const dir = new Uint8Array(46 + nameBytes.length)
    const dirView = new DataView(dir.buffer)
    writeU32(dirView, 0, 0x02014b50) // central directory signature
    writeU16(dirView, 4, 20) // version made by
    writeU16(dirView, 6, 20) // version needed
    writeU16(dirView, 8, 0x0800)
    writeU16(dirView, 10, 0)
    writeU16(dirView, 12, time)
    writeU16(dirView, 14, date)
    writeU32(dirView, 16, checksum)
    writeU32(dirView, 20, data.length)
    writeU32(dirView, 24, data.length)
    writeU16(dirView, 28, nameBytes.length)
    writeU16(dirView, 30, 0) // extra
    writeU16(dirView, 32, 0) // comment
    writeU16(dirView, 34, 0) // disk number
    writeU16(dirView, 36, 0) // internal attrs
    writeU32(dirView, 38, 0) // external attrs
    writeU32(dirView, 42, offset)
    dir.set(nameBytes, 46)
    central.push(dir)

    offset += local.length + data.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  writeU32(eocdView, 0, 0x06054b50)
  writeU16(eocdView, 4, 0)
  writeU16(eocdView, 6, 0)
  writeU16(eocdView, 8, entries.length)
  writeU16(eocdView, 10, entries.length)
  writeU32(eocdView, 12, centralSize)
  writeU32(eocdView, 16, offset)
  writeU16(eocdView, 20, 0)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of chunks) {
    out.set(part, cursor)
    cursor += part.length
  }
  for (const part of central) {
    out.set(part, cursor)
    cursor += part.length
  }
  out.set(eocd, cursor)
  return out
}
