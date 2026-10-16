/**
 * 元数据扫描 —— SPEC 第 5 节阶段四「先写 metadata_scan.js 解析 EXIF XMP C2PA IPTC」。
 * 零第三方依赖（SPEC §7）：自己按容器规范逐段遍历，不引入 exif 解析库。
 *
 * 支持范围（如实说明）：
 *   · JPEG：APP1(Exif) / APP1(XMP) / APP13(IPTC/Photoshop) / JUMBF(C2PA) —— **按段结构解析**
 *   · PNG ：tEXt / iTXt / zTXt 文本块 —— **按块结构解析**
 *   · WebP：RIFF 容器里的 EXIF / XMP 块 —— **按块结构解析**
 *   · HEIC / AVIF：**只做"标记扫描"**（在字节流里找 `Exif\0\0` 与 XMP 命名空间字符串），
 *     不做 ISOBMFF 的 meta/iloc/iinf 盒树解析。含义：**扫到就算有；扫不到不能断言"一定没有"**
 *     （元数据可能被封在压缩/分段的盒里）。
 *
 * 为什么要查这些：AI 生成工具常在 EXIF/XMP 里留下 CreatorTool、软件名、C2PA 溯源断言；
 * 这是**唯一可以直接证实**（而非猜测）的一类信号，因此在加权里占最高权重。
 */
import { utf8Decode } from '../common/bytes.js'

/** 已知 AI 生成/编辑工具签名（大小写不敏感匹配）。 */
export const AI_TOOL_MARKERS = Object.freeze([
  'midjourney',
  'stable diffusion',
  'stablediffusion',
  'dall·e',
  'dall-e',
  'dall e',
  'adobe firefly',
  'firefly',
  'generative fill',
  'imagen',
  'flux.1',
  'flux ',
  'comfyui',
  'automatic1111',
  'novelai',
  'runwayml',
  'openai',
  'ai generated',
  'ai-generated',
  'synthetic',
  'gemini',
  'grok',
  'ideogram',
  'leonardo.ai',
])

const ascii = (bytes) => {
  let out = ''
  for (const b of bytes) out += b >= 32 && b < 127 ? String.fromCharCode(b) : ' '
  return out
}

const indexOfBytes = (haystack, needle, from = 0) => {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

const utf8 = (s) => new TextEncoder().encode(s)

/** 遍历 JPEG 段。返回 [{ marker, offset, payload }]。 */
export function readJpegSegments(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null // 不是 JPEG
  const segments = []
  let off = 2
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) break
    const marker = bytes[off + 1]
    if (marker === 0xd9 || marker === 0xda) break // EOI / SOS：后面是压缩数据
    const len = (bytes[off + 2] << 8) | bytes[off + 3]
    if (len < 2 || off + 2 + len > bytes.length) break
    segments.push({ marker, offset: off, payload: bytes.subarray(off + 4, off + 2 + len) })
    off += 2 + len
  }
  return segments
}

/** 从 Exif 载荷里取几个常见 ASCII 标签（不追 TIFF IFD 全解，够用且不易出错）。 */
export function extractExifTags(payload) {
  const out = {}
  // 两种形态都要认：① 带 "Exif\0\0" 前缀（JPEG APP1）② 直接就是 TIFF 头（WebP 的 EXIF 块常见）
  const marker = indexOfBytes(payload, utf8('Exif\0\0'))
  let tiffStart = marker >= 0 ? marker + 6 : -1
  if (tiffStart < 0) {
    const looksLikeTiff =
      payload.length > 8 &&
      ((payload[0] === 0x49 && payload[1] === 0x49) || (payload[0] === 0x4d && payload[1] === 0x4d))
    if (looksLikeTiff) tiffStart = 0
  }
  if (tiffStart < 0) return out
  const tiff = payload.subarray(tiffStart)
  // TIFF 头：II/MM + 0x2a + 首 IFD 偏移
  if (tiff.length < 8) return out
  const little = tiff[0] === 0x49 && tiff[1] === 0x49
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d
  if (!little && !big) return out
  const u16 = (o) => (little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1])
  const u32 = (o) =>
    little
      ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
      : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0
  if (u16(2) !== 0x2a) return out

  const NAMED = { 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x0132: 'DateTime' }
  const ifd0 = u32(4)
  const count = u16(ifd0)
  for (let i = 0; i < Math.min(count, 64); i++) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > tiff.length) break
    const tag = u16(entry)
    const name = NAMED[tag]
    if (!name) continue
    const type = u16(entry + 2)
    const num = u32(entry + 4)
    if (type !== 2 || num === 0) continue // 只处理 ASCII
    const valueOffset = num <= 4 ? entry + 8 : u32(entry + 8)
    if (valueOffset + num > tiff.length) continue
    out[name] = utf8Decode(tiff.subarray(valueOffset, valueOffset + num))
      .replace(/\0+$/, '')
      .trim()
  }
  return out
}

/** PNG 文本块（tEXt / iTXt / zTXt 的关键字与文本；zTXt 压缩内容不在此解压，只记关键字）。 */
export function readPngTextChunks(bytes) {
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (!isPng) return null
  const chunks = []
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]
    const type = ascii(bytes.subarray(off + 4, off + 8))
    if (len < 0 || off + 12 + len > bytes.length) break
    const data = bytes.subarray(off + 8, off + 8 + len)
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      let klen = 0
      while (klen < data.length && data[klen] !== 0) klen++
      chunks.push({
        type,
        keyword: ascii(data.subarray(0, klen)),
        text: type === 'zTXt' ? '' : ascii(data.subarray(klen + 1)),
      })
    }
    if (type === 'IEND') break
    off += 12 + len
  }
  return chunks
}

/**
 * WebP（RIFF 容器）块遍历。结构：
 *   "RIFF" + 文件长(4 LE) + "WEBP" + [FourCC(4) + 长度(4 LE) + 载荷 + 补齐到偶数字节]…
 * 与元数据相关的是 `EXIF` 与 `XMP `（注意 XMP 的 FourCC 带一个空格）。
 */
export function readWebpChunks(bytes) {
  if (bytes.length < 12) return null
  if (ascii(bytes.subarray(0, 4)) !== 'RIFF' || ascii(bytes.subarray(8, 12)) !== 'WEBP') return null
  const chunks = []
  let off = 12
  while (off + 8 <= bytes.length) {
    const fourcc = ascii(bytes.subarray(off, off + 4))
    const size = bytes[off + 4] | (bytes[off + 5] << 8) | (bytes[off + 6] << 16) | (bytes[off + 7] << 24)
    if (size < 0 || off + 8 + size > bytes.length) break
    chunks.push({ fourcc: fourcc.trim(), payload: bytes.subarray(off + 8, off + 8 + size) })
    off += 8 + size + (size % 2) // RIFF 规定奇数长度要补一个字节
  }
  return chunks
}

/**
 * 识别 ISOBMFF 家族（HEIC / AVIF）并返回统一格式名。
 * 只认 `ftyp` 盒的品牌，不做盒树解析 —— 见文件头的"标记扫描"说明。
 */
export function detectIsobmffBrand(bytes) {
  if (bytes.length < 12) return null
  if (ascii(bytes.subarray(4, 8)) !== 'ftyp') return null
  const brand = ascii(bytes.subarray(8, 12)).trim()
  const MAP = {
    heic: 'heic',
    heix: 'heic',
    hevc: 'heic',
    heim: 'heic',
    heis: 'heic',
    mif1: 'heic',
    msf1: 'heic',
    avif: 'avif',
    avis: 'avif',
  }
  return MAP[brand] ? { format: MAP[brand], brand } : null
}

/** 在字节流里找元数据标记（HEIC/AVIF 用；找不到 ≠ 一定没有）。 */
export function scanMetadataMarkers(bytes) {
  const exifAt = indexOfBytes(bytes, utf8('Exif\0\0'))
  const xmpAt = indexOfBytes(bytes, utf8('http://ns.adobe.com/xap/1.0/'))
  const c2pa = indexOfBytes(bytes, utf8('c2pa')) >= 0 || indexOfBytes(bytes, utf8('jumb')) >= 0
  const iptc = indexOfBytes(bytes, utf8('Photoshop 3.0')) >= 0
  return { exifAt, xmpAt, c2pa, iptc }
}

/** 从标记处截一段 XMP 文本（遇到结束标签就停，否则按上限截断）。 */
function sliceXmpFrom(bytes, start) {
  const body = bytes.subarray(start)
  const end = indexOfBytes(body, utf8('</x:xmpmeta>'))
  const slice = end >= 0 ? body.subarray(0, Math.min(end + 12, 8192)) : body.subarray(0, Math.min(body.length, 8192))
  return utf8Decode(slice).replace(/[^\x20-\x7e\u4e00-\u9fff]+/g, ' ')
}

/**
 * 扫描元数据。
 * @param {Uint8Array} bytes 原始文件字节（不是像素数据）
 * @returns {{ format: string, hasExif: boolean, exif: object, hasXmp: boolean, xmp: string|null, hasC2pa: boolean, hasIptc: boolean, textChunks: Array, aiMarkers: string[] }}
 */
export function scanMetadata(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('scanMetadata 需要文件的原始字节')

  const result = {
    format: 'unknown',
    hasExif: false,
    exif: {},
    hasXmp: false,
    xmp: null,
    hasC2pa: false,
    hasIptc: false,
    textChunks: [],
    aiMarkers: [],
  }

  const pngChunks = readPngTextChunks(bytes)
  const segments = readJpegSegments(bytes)
  const webpChunks = readWebpChunks(bytes)
  const isobmff = detectIsobmffBrand(bytes)

  if (pngChunks) {
    result.format = 'png'
    result.textChunks = pngChunks
    for (const chunk of pngChunks) {
      const blob = `${chunk.keyword} ${chunk.text}`.toLowerCase()
      if (/xml:com\.adobe\.xmp|xmp/.test(chunk.keyword.toLowerCase())) {
        result.hasXmp = true
        result.xmp = chunk.text
      }
      if (/c2pa|jumb/.test(blob)) result.hasC2pa = true
    }
  } else if (segments) {
    result.format = 'jpeg'
    for (const seg of segments) {
      const payload = seg.payload
      if (seg.marker === 0xe1) {
        if (indexOfBytes(payload, utf8('Exif\0\0')) >= 0) {
          result.hasExif = true
          Object.assign(result.exif, extractExifTags(payload))
        }
        const xmpStart = indexOfBytes(payload, utf8('http://ns.adobe.com/xap/1.0/'))
        if (xmpStart >= 0) {
          result.hasXmp = true
          const body = payload.subarray(xmpStart)
          const end = indexOfBytes(body, utf8('</x:xmpmeta>'))
          const slice = end >= 0 ? body.subarray(0, end + 12) : body
          result.xmp = utf8Decode(slice).replace(/[^\x20-\x7e\u4e00-\u9fff]+/g, ' ')
        }
        // C2PA 的 JUMBF 超箱标记
        if (indexOfBytes(payload, utf8('c2pa')) >= 0 || indexOfBytes(payload, utf8('jumb')) >= 0) {
          result.hasC2pa = true
        }
      }
      if (seg.marker === 0xed && indexOfBytes(payload, utf8('Photoshop 3.0')) >= 0) {
        result.hasIptc = true
      }
    }
  } else if (webpChunks) {
    // WebP：按 RIFF 块解析 EXIF / XMP
    result.format = 'webp'
    for (const chunk of webpChunks) {
      if (chunk.fourcc === 'EXIF') {
        const tags = extractExifTags(chunk.payload)
        if (Object.keys(tags).length > 0 || indexOfBytes(chunk.payload, utf8('Exif\0\0')) >= 0) {
          result.hasExif = true
          Object.assign(result.exif, tags)
        }
      }
      if (chunk.fourcc === 'XMP') {
        const xmp = sliceXmpFrom(chunk.payload, 0)
        if (xmp.trim().length > 0) {
          result.hasXmp = true
          result.xmp = xmp
        }
      }
      if (chunk.fourcc === 'ICCP') result.textChunks.push({ type: 'ICCP', keyword: 'icc', text: '' })
    }
  } else if (isobmff) {
    // HEIC / AVIF：**标记扫描**（不做盒树解析，见文件头说明）
    result.format = isobmff.format
    const markers = scanMetadataMarkers(bytes)
    if (markers.exifAt >= 0) {
      result.hasExif = true
      Object.assign(
        result.exif,
        extractExifTags(bytes.subarray(markers.exifAt, Math.min(bytes.length, markers.exifAt + 65536))),
      )
    }
    if (markers.xmpAt >= 0) {
      result.hasXmp = true
      result.xmp = sliceXmpFrom(bytes, markers.xmpAt)
    }
    if (markers.c2pa) result.hasC2pa = true
    if (markers.iptc) result.hasIptc = true
    result.markerScan = true
  }

  // AI 工具签名：在 EXIF 文本、XMP、PNG 文本块里找
  const haystack = [JSON.stringify(result.exif), result.xmp ?? '', JSON.stringify(result.textChunks)]
    .join(' ')
    .toLowerCase()
  for (const marker of AI_TOOL_MARKERS) {
    if (haystack.includes(marker.toLowerCase())) result.aiMarkers.push(marker)
  }
  return result
}
