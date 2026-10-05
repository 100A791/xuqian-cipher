/**
 * AI 检测测试 —— SPEC §6 阶段四验收标准：
 *   「能读取元数据 / 能检测 LSB 异常 / 能输出检测报告 / 能给出 AI 生成置信度」
 * 运行：node tests/unit/test_ai_detect.js
 */
import {
  scanMetadata,
  readJpegSegments,
  readPngTextChunks,
  readWebpChunks,
  detectIsobmffBrand,
  scanMetadataMarkers,
  AI_TOOL_MARKERS,
} from '../../src/selfcrypto/ai/metadata_scan.js'
import { dct2d, highFrequencyRatio, toLuma } from '../../src/selfcrypto/ai/helpers.js'
import {
  analyzeFrequency,
  analyzeSpectral,
  computeBlockiness,
  cropPlane,
  dwtEnergyProfile,
  estimateSpectralSlope,
  fft1d,
  fft2dMagnitude,
  haarDwt2d,
  prepareSquare,
  radialPowerSpectrum,
  spectralPeakRatio,
} from '../../src/selfcrypto/ai/frequency.js'
import { analyzeNoise, detectLsbAnomaly, lsbPlaneStats } from '../../src/selfcrypto/ai/noise.js'
import { analyzeColor } from '../../src/selfcrypto/ai/color.js'
import { analyzeEdge } from '../../src/selfcrypto/ai/edge.js'
import {
  CALIBRATED,
  DISCLAIMER,
  THRESHOLDS,
  WEIGHTS,
  analyzeAll,
  buildReport,
  detectAIGenerated,
  detectAIWatermark,
} from '../../src/selfcrypto/ai/report.js'
import { createImage, streamBytes } from '../../src/selfcrypto/watermark/lsb.js'
import { embedWatermark, extractWatermark } from '../../src/selfcrypto/watermark/extract.js'
import { setUniformDelayRange } from '../../src/selfcrypto/common/delay.js'
import { assertEqual, assertTrue, bytesToHex, createRunner } from './_helpers.js'

const runner = createRunner('AI 检测（元数据 / 频域 / 噪声 / 色彩 / 边缘 / 报告）')
setUniformDelayRange([0, 0])

const utf8 = (s) => new TextEncoder().encode(s)
const u16be = (v) => Uint8Array.of((v >> 8) & 0xff, v & 0xff)
const u16le = (v) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff)
const u32le = (v) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
const u32be = (v) => Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
const concat = (...parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 手写一段 APP1 EXIF（小端 TIFF），足够被 metadata_scan 解析出 Make/Model/Software。 */
function buildExifSegment(tags) {
  const names = Object.keys(tags)
  const entries = []
  const dataArea = []
  let dataOffset = 8 + 2 + names.length * 12 + 4 // TIFF 头 + count + entries + nextIFD
  const TAG_IDS = { Make: 0x010f, Model: 0x0110, Software: 0x0131, DateTime: 0x0132 }
  for (const name of names) {
    const value = utf8(tags[name] + '\0')
    const tag = TAG_IDS[name]
    if (!tag) throw new Error('测试只支持这几个标签: ' + name)
    const entry = new Uint8Array(12)
    const dv = new DataView(entry.buffer)
    dv.setUint16(0, tag, true)
    dv.setUint16(2, 2, true)
    dv.setUint32(4, value.length, true)
    if (value.length <= 4) {
      entry.set(value, 8)
    } else {
      dv.setUint32(8, dataOffset, true)
      dataArea.push(value)
      dataOffset += value.length
    }
    entries.push(entry)
  }
  // TIFF 头是小端（II），所以这里必须用小端写入 —— 用大端会让整个 IFD 解析错位
  const tiffHead = concat(utf8('II'), u16le(0x2a), u32le(8))
  const count = new Uint8Array(2)
  new DataView(count.buffer).setUint16(0, names.length, true)
  const nextIfd = u32be(0)
  const tiff = concat(tiffHead, count, ...entries, nextIfd, ...dataArea)
  return concat(u8seg(0xe1, concat(utf8('Exif\0\0'), tiff)))
}

function u8seg(marker, payload) {
  const len = payload.length + 2
  return concat(Uint8Array.of(0xff, marker), u16be(len), payload)
}

function buildJpeg({ exif, xmp, c2pa } = {}) {
  const parts = [Uint8Array.of(0xff, 0xd8)]
  if (exif) parts.push(buildExifSegment(exif))
  if (xmp) parts.push(u8seg(0xe1, concat(utf8('http://ns.adobe.com/xap/1.0/\0'), utf8(xmp))))
  if (c2pa) parts.push(u8seg(0xe1, concat(utf8('jumb'), utf8('c2pa manifest'))))
  parts.push(Uint8Array.of(0xff, 0xd9))
  return concat(...parts)
}

function buildPng(textChunks) {
  const sig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  const chunk = (type, data) => concat(u32be(data.length), utf8(type), data, u32be(0))
  const parts = [sig, chunk('IHDR', concat(u32be(8), u32be(8), Uint8Array.of(8, 6, 0, 0, 0)))]
  for (const [keyword, text] of Object.entries(textChunks)) {
    parts.push(chunk('tEXt', concat(utf8(keyword), Uint8Array.of(0), utf8(text))))
  }
  parts.push(chunk('IEND', new Uint8Array(0)))
  return concat(...parts)
}

// ------------------------------------------------------------ 元数据

await runner.test('读取 JPEG 元数据：EXIF 标签 + XMP + C2PA 都能识别', () => {
  const jpeg = buildJpeg({
    exif: { Make: 'Canon', Model: 'EOS R5', Software: 'Adobe Firefly 1.0' },
    xmp: '<x:xmpmeta>crs:CreatorTool="Adobe Firefly"</x:xmpmeta>',
    c2pa: true,
  })
  assertTrue(readJpegSegments(jpeg) !== null, '应识别为 JPEG')
  const meta = scanMetadata(jpeg)
  assertEqual(meta.format, 'jpeg', '格式')
  assertTrue(meta.hasExif, '应发现 EXIF')
  assertEqual(meta.exif.Make, 'Canon', 'Make')
  assertEqual(meta.exif.Model, 'EOS R5', 'Model')
  assertEqual(meta.exif.Software, 'Adobe Firefly 1.0', 'Software')
  assertTrue(meta.hasXmp, '应发现 XMP')
  assertTrue(meta.hasC2pa, '应发现 C2PA')
  assertTrue(meta.aiMarkers.includes('adobe firefly') || meta.aiMarkers.includes('firefly'), `AI 签名：${meta.aiMarkers}`)
})

await runner.test('读取 PNG 文本块并识别 AI 签名', () => {
  const png = buildPng({ Software: 'Midjourney v6', Comment: 'generated by ComfyUI' })
  assertTrue(readPngTextChunks(png) !== null, '应识别为 PNG')
  const meta = scanMetadata(png)
  assertEqual(meta.format, 'png', '格式')
  assertTrue(meta.aiMarkers.includes('midjourney'), `应识别 Midjourney：${meta.aiMarkers}`)
  assertTrue(meta.aiMarkers.includes('comfyui'), `应识别 ComfyUI：${meta.aiMarkers}`)
})

await runner.test('没有元数据的原始字节 → format=unknown 且无签名（不误报）', () => {
  const meta = scanMetadata(Uint8Array.from({ length: 64 }, (_, i) => i))
  assertEqual(meta.format, 'unknown', '格式')
  assertEqual(meta.aiMarkers.length, 0, '不应有签名')
})

await runner.test('干净 JPEG（无 AI 签名）→ 不误报', () => {
  const meta = scanMetadata(buildJpeg({ exif: { Make: 'Nikon', Software: 'Nikon Transfer 2' } }))
  assertEqual(meta.aiMarkers.length, 0, `不应有签名：${meta.aiMarkers}`)
  assertTrue(meta.hasExif, 'EXIF 仍应被读到')
})

await runner.test('AI 工具签名表非空且覆盖 SPEC 提到的常见工具', () => {
  assertTrue(AI_TOOL_MARKERS.length >= 15, `签名表应有足够覆盖，实际 ${AI_TOOL_MARKERS.length}`)
  for (const needle of ['midjourney', 'stable diffusion', 'firefly', 'dall-e']) {
    assertTrue(AI_TOOL_MARKERS.includes(needle), `缺少 ${needle}`)
  }
})

// ------------------------------------------------- 其它容器（WebP / HEIC / AVIF）
// 注意：u32le 在文件上方（修 EXIF 小端时）已声明，这里不要重复声明。

/** 最小可用的小端 TIFF（单条 ASCII 标签），用于构造 EXIF 载荷。 */
function buildTiff(tagId, text) {
  const value = utf8(text + '\0')
  const entry = new Uint8Array(12)
  const dv = new DataView(entry.buffer)
  dv.setUint16(0, tagId, true)
  dv.setUint16(2, 2, true)
  dv.setUint32(4, value.length, true)
  dv.setUint32(8, 26, true) // 数据区偏移：8(头)+2(计数)+12(条目)+4(nextIFD)
  return concat(utf8('II'), Uint8Array.of(0x2a, 0x00), u32le(8), Uint8Array.of(1, 0), entry, u32le(0), value)
}

/** RIFF/WEBP 块（奇数长度补 1 字节）。 */
function webpChunk(fourcc, data) {
  const padding = data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0)
  return concat(utf8(fourcc), u32le(data.length), data, padding)
}
function buildWebp({ exif, xmp } = {}) {
  const parts = [utf8('WEBP'), webpChunk('VP8X', new Uint8Array(10))]
  if (exif) parts.push(webpChunk('EXIF', concat(utf8('Exif\0\0'), exif)))
  if (xmp) parts.push(webpChunk('XMP ', utf8(xmp)))
  const body = concat(...parts)
  return concat(utf8('RIFF'), u32le(body.length), body)
}
/** ISOBMFF 盒。 */
function box(type, data) {
  return concat(u32le(data.length + 8), utf8(type), data)
}
function buildIsobmff(brand, payload) {
  return concat(box('ftyp', concat(utf8(brand), u32le(0), utf8('mif1avif'))), box('mdat', payload))
}

await runner.test('WebP：按 RIFF 块解析 EXIF 与 XMP', () => {
  const webp = buildWebp({ exif: buildTiff(0x0131, 'Midjourney v6'), xmp: '<x:xmpmeta>CreatorTool="Adobe Firefly"</x:xmpmeta>' })
  assertTrue(readWebpChunks(webp) !== null, '应识别为 WebP')
  const meta = scanMetadata(webp)
  assertEqual(meta.format, 'webp', '格式')
  assertTrue(meta.hasExif, '应发现 EXIF')
  assertEqual(meta.exif.Software, 'Midjourney v6', 'Software 标签')
  assertTrue(meta.hasXmp, '应发现 XMP')
  assertTrue(meta.aiMarkers.includes('midjourney'), `AI 签名：${meta.aiMarkers}`)
  assertTrue(meta.aiMarkers.includes('adobe firefly') || meta.aiMarkers.includes('firefly'), `AI 签名：${meta.aiMarkers}`)
})

await runner.test('WebP：EXIF 块里直接放 TIFF（无 Exif 前缀）也能解析', () => {
  const webp = buildWebp({ exif: buildTiff(0x010f, 'Canon') })
  const meta = scanMetadata(webp)
  assertTrue(meta.hasExif, '应发现 EXIF')
  assertEqual(meta.exif.Make, 'Canon', 'Make 标签')
})

await runner.test('WebP：只有图像数据、没有元数据块时不误报', () => {
  const webp = buildWebp({})
  const meta = scanMetadata(webp)
  assertEqual(meta.format, 'webp', '格式')
  assertEqual(meta.hasExif, false, '不应有 EXIF')
  assertEqual(meta.hasXmp, false, '不应有 XMP')
  assertEqual(meta.aiMarkers.length, 0, '不应有 AI 签名')
})

await runner.test('非 RIFF/WEBP 的字节不会被当成 WebP（不误判容器）', () => {
  assertEqual(readWebpChunks(Uint8Array.from({ length: 32 }, (_, i) => i)), null, '普通字节')
  assertEqual(readWebpChunks(concat(utf8('RIFF'), u32le(4), utf8('WAVE'))), null, 'RIFF 但非 WEBP')
})

await runner.test('ISOBMFF：按 ftyp 品牌识别 AVIF / HEIC 并统一格式名', () => {
  assertEqual(detectIsobmffBrand(buildIsobmff('avif', new Uint8Array(4)))?.format, 'avif', 'avif 品牌')
  assertEqual(detectIsobmffBrand(buildIsobmff('heic', new Uint8Array(4)))?.format, 'heic', 'heic 品牌')
  assertEqual(detectIsobmffBrand(buildIsobmff('mif1', new Uint8Array(4)))?.format, 'heic', 'mif1 归入 heic')
  assertEqual(detectIsobmffBrand(Uint8Array.from({ length: 32 }, (_, i) => i)), null, '非 ISOBMFF')
  assertEqual(detectIsobmffBrand(concat(utf8('RIFF'), u32le(4), utf8('WEBP'))), null, 'WebP 不该被当成 ISOBMFF')
})

await runner.test('AVIF：标记扫描能找到 Exif 与 AI 签名', () => {
  const avif = buildIsobmff('avif', concat(utf8('Exif\0\0'), buildTiff(0x0131, 'ComfyUI')))
  const meta = scanMetadata(avif)
  assertEqual(meta.format, 'avif', '格式')
  assertTrue(meta.markerScan === true, '应标记"用的是标记扫描"（如实告知能力边界）')
  assertTrue(meta.hasExif, '应扫到 EXIF')
  assertEqual(meta.exif.Software, 'ComfyUI', 'Software')
  assertTrue(meta.aiMarkers.includes('comfyui'), `AI 签名：${meta.aiMarkers}`)
})

await runner.test('HEIC：标记扫描 + C2PA 标记', () => {
  const heic = buildIsobmff(
    'heic',
    concat(utf8('jumb'), utf8('c2pa manifest'), utf8('http://ns.adobe.com/xap/1.0/'), utf8('<x:xmpmeta>Midjourney</x:xmpmeta>')),
  )
  const meta = scanMetadata(heic)
  assertEqual(meta.format, 'heic', '格式')
  assertTrue(meta.hasC2pa, '应扫到 C2PA 标记')
  assertTrue(meta.hasXmp, '应扫到 XMP')
  assertTrue(meta.aiMarkers.includes('midjourney'), `AI 签名：${meta.aiMarkers}`)
})

await runner.test('HEIC/AVIF：扫不到标记时如实返回"没有"，且不伪装成全解析', () => {
  const avif = buildIsobmff('avif', new Uint8Array(64))
  const meta = scanMetadata(avif)
  assertEqual(meta.format, 'avif', '格式')
  assertEqual(meta.hasExif, false, '没有 EXIF')
  assertEqual(meta.hasXmp, false, '没有 XMP')
  assertTrue(meta.markerScan === true, '仍应标明是标记扫描（含义：扫不到 ≠ 一定没有）')
  const markers = scanMetadataMarkers(avif)
  assertEqual(markers.exifAt, -1, 'exifAt 应为 -1')
  assertEqual(markers.c2pa, false, 'c2pa 应为 false')
})

// ------------------------------------------------------------ 底层指标

await runner.test('DCT：常数块的系数只有直流分量，高频占比为 0', () => {
  const block = new Float64Array(64).fill(100)
  const coeffs = dct2d(block, 8)
  assertTrue(Math.abs(coeffs[0]) > 1, '直流分量非零')
  let acEnergy = 0
  for (let i = 1; i < 64; i++) acEnergy += Math.abs(coeffs[i])
  assertTrue(acEnergy < 1e-6, `交流分量应为 0，实际 ${acEnergy}`)
  assertTrue(highFrequencyRatio(coeffs, 8) < 1e-9, '常数块高频占比应为 0（允许浮点残差）')
})

await runner.test('灰度转换：纯色图 luma 正确', () => {
  const image = createImage(4, 4, 0)
  for (let p = 0; p < 16; p++) {
    image.data[p * 4] = 255
    image.data[p * 4 + 1] = 0
    image.data[p * 4 + 2] = 0
  }
  const luma = toLuma(image)
  assertTrue(Math.abs(luma[0] - 0.299 * 255) < 1e-6, `红纯色 luma=${luma[0]}`)
})

// ------------------------------------------------------------ 频域 / 噪声 / 色彩 / 边缘

const checker = (w, h, cell = 2) => {
  const image = createImage(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 20 : 235
      const i = (y * w + x) * 4
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v
    }
  }
  return image
}
/** 左半黑右半白的阶跃图：边缘明确。 */
const stepEdge = (w, h) => {
  const image = createImage(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < w / 2 ? 10 : 245
      const i = (y * w + x) * 4
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v
    }
  }
  return image
}
const gradient = (w, h) => {
  const image = createImage(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255)
      const i = (y * w + x) * 4
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v
    }
  }
  return image
}

await runner.test('频域：棋盘图高频占比显著高于平滑渐变图', () => {
  // 1 像素棋盘：能量落在 u=4（8×8 的奈奎斯特），属真正的高频
  const c = analyzeFrequency(checker(64, 64, 1))
  const g = analyzeFrequency(gradient(64, 64))
  assertTrue(c.highFreqRatio > g.highFreqRatio + 0.3, `棋盘 ${c.highFreqRatio.toFixed(3)} vs 渐变 ${g.highFreqRatio.toFixed(3)}`)
  assertTrue(c.blockCount > 0, '应统计到分块')
})

await runner.test('频域：8×8 对齐的块状图案 blockiness 高于平滑图', () => {
  const blocks = createImage(64, 64)
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const v = Math.floor(x / 8) % 2 === 0 ? 30 : 220
      const i = (y * 64 + x) * 4
      blocks.data[i] = blocks.data[i + 1] = blocks.data[i + 2] = v
    }
  }
  const b1 = computeBlockiness(toLuma(blocks), 64, 64, 8)
  const b2 = computeBlockiness(toLuma(gradient(64, 64)), 64, 64, 8)
  assertTrue(b1 > b2, `块状 ${b1.toFixed(3)} 应 > 渐变 ${b2.toFixed(3)}`)
})

await runner.test('LSB 异常：低位恒定的图被判为异常，低位随机的图不判异常', () => {
  const evenOnly = createImage(32, 32)
  for (let i = 0; i < evenOnly.data.length; i++) evenOnly.data[i] = 0x40 // 低位全 0
  const flat = detectLsbAnomaly(evenOnly)
  assertTrue(flat.anomaly, `低位恒定为 0 应判异常，score=${flat.score}`)
  assertEqual(flat.stats.bias, 0.5, '全 0 时 ones 比例为 0 → bias 0.5')

  const noisy = createImage(32, 32)
  const rand = streamBytes(utf8('lsb-random'), 'k', noisy.data.length)
  noisy.data.set(rand)
  for (let p = 3; p < noisy.data.length; p += 4) noisy.data[p] = 255
  const stats = lsbPlaneStats(noisy)
  assertTrue(stats.entropy > 0.98, `随机低位熵应接近 1，实际 ${stats.entropy.toFixed(4)}`)
  assertTrue(!detectLsbAnomaly(noisy).anomaly, '随机低位不应判异常')
})

await runner.test('噪声：平滑图残差强度低于棋盘图', () => {
  const smooth = analyzeNoise(gradient(64, 64))
  const busy = analyzeNoise(checker(64, 64, 1))
  assertTrue(busy.residualStd > smooth.residualStd, `棋盘残差 ${busy.residualStd.toFixed(2)} 应 > 渐变 ${smooth.residualStd.toFixed(2)}`)
})

await runner.test('色彩：灰度图三通道相关系数为 1；随机彩图明显更低', () => {
  const gray = analyzeColor(gradient(32, 32))
  assertTrue(Math.abs(gray.channelCorrelation - 1) < 1e-6, `灰度相关性应为 1，实际 ${gray.channelCorrelation}`)

  const colorful = createImage(32, 32)
  const rand = streamBytes(utf8('color'), 'k', colorful.data.length)
  colorful.data.set(rand)
  for (let p = 3; p < colorful.data.length; p += 4) colorful.data[p] = 255
  const c = analyzeColor(colorful)
  assertTrue(c.channelCorrelation < 0.9, `随机彩图相关性应明显低于 1，实际 ${c.channelCorrelation.toFixed(3)}`)
})

await runner.test('边缘：纯色无响应、阶跃响应集中、渐变响应弥散', () => {  const flat = analyzeEdge(createImage(48, 48, 128))
  const step = analyzeEdge(stepEdge(48, 48))
  const ramp = analyzeEdge(gradient(48, 48))

  assertTrue(flat.edgeMean < 1e-9, `纯色图不应有边缘响应，实际 ${flat.edgeMean}`)
  assertTrue(step.edgeMean > 0, '阶跃图应有边缘响应')
  assertTrue(ramp.edgeMean > 0, '渐变图也会有响应（Sobel 是微分算子，线性斜坡处处有响应）')

  // 关键区别不是"均值谁大"，而是**响应的集中度**：
  // 阶跃只在边缘一两列有强响应（弥散度极高）；线性渐变处处响应相近（弥散度接近 0）。
  const flatness = (m) => m.edgeStd / m.edgeMean
  assertTrue(
    flatness(step) > flatness(ramp) * 3,
    `阶跃弥散度 ${flatness(step).toFixed(2)} 应远高于渐变 ${flatness(ramp).toFixed(2)}`,
  )

  // 固化那条容易误判的性质：1 像素棋盘上 Sobel 对角相消，响应退化到接近 0
  assertTrue(analyzeEdge(checker(48, 48, 1)).edgeMean < 2, '1 像素棋盘上 Sobel 应退化到接近 0')
})

// ------------------------------------------------------------ FFT / DWT（G1）

/** 造一个常量平面。 */
const constPlane = (n, v) => Float64Array.from({ length: n * n }, () => v)
/** 造一个脉冲平面（只有一个非零）。 */
const impulsePlane = (n) => {
  const p = new Float64Array(n * n)
  p[0] = 1
  return p
}
/** 造一个余弦平面（在 x 方向频率为 k）。 */
const cosinePlane = (n, k) => {
  const p = new Float64Array(n * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) p[y * n + x] = Math.cos((2 * Math.PI * k * x) / n)
  return p
}
const planeEnergy = (arr) => {
  let s = 0
  for (const v of arr) s += v * v
  return s
}

await runner.test('FFT：逆变换能把正变换还原（往返是正确性的硬证据）', () => {
  const n = 32
  const original = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + Math.cos(i * 1.9) * 0.5)
  const re = Float64Array.from(original)
  const im = new Float64Array(n)
  fft1d(re, im, false)
  fft1d(re, im, true)
  let maxErr = 0
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - original[i]), Math.abs(im[i]))
  assertTrue(maxErr < 1e-9, `逆变换误差应接近 0，实际 ${maxErr}`)
})

await runner.test('FFT：能量守恒（Parseval：Σ|X|² = N·Σ|x|²）', () => {
  const n = 64
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.31) * 3 + 1)
  const re = Float64Array.from(x)
  const im = new Float64Array(n)
  fft1d(re, im, false)
  let spec = 0
  for (let i = 0; i < n; i++) spec += re[i] * re[i] + im[i] * im[i]
  const time = planeEnergy(x)
  const ratio = spec / (n * time)
  assertTrue(Math.abs(ratio - 1) < 1e-9, `能量比应等于 1，实际 ${ratio}`)
})

await runner.test('FFT：常量信号只有直流分量', () => {
  const n = 32
  const re = constPlane(n, 5)
  const im = new Float64Array(n * n)
  // 用一维来断言更直观
  const r1 = Float64Array.from({ length: n }, () => 5)
  const i1 = new Float64Array(n)
  fft1d(r1, i1, false)
  assertTrue(Math.abs(r1[0] - 5 * n) < 1e-9, `直流应等于 N×常量，实际 ${r1[0]}`)
  let ac = 0
  for (let i = 1; i < n; i++) ac += Math.abs(r1[i]) + Math.abs(i1[i])
  assertTrue(ac < 1e-9, `交流分量应为 0，实际 ${ac}`)
  assertEqual(im.length, n * n, '（占位断言：二维用同一实现）')
  assertEqual(re.length, n * n, '平面长度')
})

await runner.test('FFT：脉冲信号的幅度谱是平的', () => {
  const n = 32
  const r = Float64Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0))
  const i0 = new Float64Array(n)
  fft1d(r, i0, false)
  let min = Infinity
  let max = 0
  for (let i = 0; i < n; i++) {
    const mag = Math.hypot(r[i], i0[i])
    min = Math.min(min, mag)
    max = Math.max(max, mag)
  }
  assertTrue(max - min < 1e-9 && Math.abs(max - 1) < 1e-9, `脉冲谱应恒为 1，实际 ${min}~${max}`)
})

await runner.test('FFT：单频余弦的能量集中在对应频点（k 与 N−k）', () => {
  const n = 64
  const k = 5
  const r = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * k * i) / n))
  const i0 = new Float64Array(n)
  fft1d(r, i0, false)
  const mags = Array.from({ length: n }, (_, i) => Math.hypot(r[i], i0[i]))
  const peak = mags.indexOf(Math.max(...mags))
  assertTrue(peak === k || peak === n - k, `峰值应落在 ${k} 或 ${n - k}，实际 ${peak}`)
  const total = mags.reduce((s, v) => s + v * v, 0)
  const atPeaks = mags[k] * mags[k] + mags[n - k] * mags[n - k]
  assertTrue(atPeaks / total > 0.999, `两个频点应占几乎全部能量，实际 ${(atPeaks / total).toFixed(6)}`)
})

await runner.test('FFT：非 2 的幂长度明确报错（不静默算错）', () => {
  let message = ''
  try {
    fft1d(new Float64Array(30), new Float64Array(30), false)
  } catch (error) {
    message = error.message
  }
  assertTrue(/2 的幂/.test(message), `应提示长度要求，实际：${message}`)
})

await runner.test('FFT：二维幅度谱与裁剪都限制在 N×N（大图不会撑爆内存）', () => {
  const big = new Float64Array(64 * 64).fill(3)
  const cropped = cropPlane(big, 64, 64, 32)
  assertEqual(cropped.length, 32 * 32, '裁剪后固定为 N²')
  const windowed = prepareSquare(big, 64, 64, 32)
  assertEqual(windowed.length, 32 * 32, '加窗后同样是 N²')
  // 加窗会把边缘压到接近 0，不加窗保持原值
  assertTrue(Math.abs(cropped[0] - 3) < 1e-9, '不加窗应保持原值')
  assertTrue(Math.abs(windowed[0]) < 1e-9, 'Hann 窗在角上应压到 0')
  const mag = fft2dMagnitude(cropped, 32)
  assertEqual(mag.length, 1024, '二维幅度谱长度')
})

await runner.test('径向功率谱与谱斜率：白噪声平缓、线性斜坡陡峭', () => {
  const n = 64
  const noise = new Float64Array(n * n)
  const rand = streamBytes(utf8('fft-noise'), 'k', n * n)
  for (let i = 0; i < n * n; i++) noise[i] = rand[i]
  const ramp = new Float64Array(n * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ramp[y * n + x] = x + y

  const noiseSlope = estimateSpectralSlope(radialPowerSpectrum(fft2dMagnitude(prepareSquare(noise, n, n, n), n), n, 24)).slope
  const rampSlope = estimateSpectralSlope(radialPowerSpectrum(fft2dMagnitude(prepareSquare(ramp, n, n, n), n), n, 24)).slope
  assertTrue(noiseSlope > -1, `白噪声斜率应接近 0，实际 ${noiseSlope.toFixed(2)}`)
  assertTrue(rampSlope < -1.2, `斜坡斜率应明显为负，实际 ${rampSlope.toFixed(2)}`)
  assertTrue(rampSlope < noiseSlope, '斜坡应比白噪声陡')
})

await runner.test('谱峰占比：单频图远高于白噪声', () => {
  const n = 64
  const tone = fft2dMagnitude(cosinePlane(n, 4), n)
  const noise = new Float64Array(n * n)
  const rand = streamBytes(utf8('peak-noise'), 'k', n * n)
  for (let i = 0; i < n * n; i++) noise[i] = rand[i]
  const noiseMag = fft2dMagnitude(noise, n)
  const toneRatio = spectralPeakRatio(tone, n, 12)
  const noiseRatio = spectralPeakRatio(noiseMag, n, 12)
  assertTrue(toneRatio > noiseRatio * 5, `单频 ${toneRatio.toFixed(4)} 应远高于噪声 ${noiseRatio.toFixed(4)}`)
})

await runner.test('DWT：常量图能量全在 LL，HH ≈ 0', () => {
  const n = 32
  const { ll, lh, hl, hh } = haarDwt2d(constPlane(n, 4), n, n)
  assertTrue(planeEnergy(ll) > 0, 'LL 应有能量')
  assertTrue(planeEnergy(lh) < 1e-12 && planeEnergy(hl) < 1e-12 && planeEnergy(hh) < 1e-12, '三个细节子带都应为 0')
})

await runner.test('DWT：1 像素棋盘的能量落在 LL 与 HH，LH/HL ≈ 0', () => {
  const n = 32
  const p = new Float64Array(n * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) p[y * n + x] = (x + y) % 2 === 0 ? 1 : 0
  const { ll, lh, hl, hh } = haarDwt2d(p, n, n)
  const total = planeEnergy(ll) + planeEnergy(lh) + planeEnergy(hl) + planeEnergy(hh)
  const hhRatio = planeEnergy(hh) / total
  const lhRatio = planeEnergy(lh) / total
  const hlRatio = planeEnergy(hl) / total
  assertTrue(Math.abs(hhRatio - 0.5) < 1e-9, `HH 应占一半，实际 ${hhRatio}`)
  assertTrue(lhRatio < 1e-12 && hlRatio < 1e-12, 'LH/HL 应为 0')
})

await runner.test('DWT：正交归一化 ⇒ 各子带能量之和等于原图能量', () => {
  const n = 32
  const p = new Float64Array(n * n)
  const rand = streamBytes(utf8('dwt'), 'k', n * n)
  for (let i = 0; i < n * n; i++) p[i] = rand[i] - 128
  const { ll, lh, hl, hh } = haarDwt2d(p, n, n)
  const bands = planeEnergy(ll) + planeEnergy(lh) + planeEnergy(hl) + planeEnergy(hh)
  const original = planeEnergy(p)
  assertTrue(Math.abs(bands - original) / original < 1e-9, `能量应守恒：${bands} vs ${original}`)
})

await runner.test('DWT 多级：子带占比合计为 1，层级数与请求一致', () => {
  const n = 64
  const p = new Float64Array(n * n)
  const rand = streamBytes(utf8('dwt2'), 'k', n * n)
  for (let i = 0; i < n * n; i++) p[i] = rand[i]
  const bands = dwtEnergyProfile(p, n, n, 2)
  assertEqual(bands.length, 2, '两级')
  for (const band of bands) {
    const sum = band.ll + band.lh + band.hl + band.hh
    assertTrue(Math.abs(sum - 1) < 1e-9, `第 ${band.level} 级占比合计应为 1，实际 ${sum}`)
  }
})

await runner.test('analyzeSpectral：对真实图返回有限且在 [0,1] 的分', () => {
  const image = gradient(256, 256)
  const luma = toLuma(image)
  const result = analyzeSpectral(luma, 256, 256)
  assertTrue(Number.isFinite(result.slope) && Number.isFinite(result.peakRatio), '数值应为有限')
  assertTrue(result.score >= 0 && result.score <= 1, `分数应在 [0,1]，实际 ${result.score}`)
  assertEqual(result.size, 256, 'FFT 尺寸')
  assertEqual(result.levels, 2, 'DWT 级数')
  assertTrue(result.bands.length === 2, '两级子带')
})

await runner.test('analyzeFrequency：现在同时给出 DCT 与 FFT/DWT 的指标', () => {
  const result = analyzeFrequency(gradient(128, 128))
  assertTrue(typeof result.highFreqRatio === 'number', 'DCT 高频占比')
  assertTrue(typeof result.spectralSlope === 'number', 'FFT 谱斜率（G1 新增）')
  assertTrue(typeof result.spectralPeakRatio === 'number', 'FFT 谱峰占比（G1 新增）')
  assertTrue(typeof result.detailEnergyRatio === 'number', 'DWT 细节能量占比（G1 新增）')
  assertTrue(result.score >= 0 && result.score <= 1, '综合分在 [0,1]')
})

await runner.test('FFT：与朴素 DFT（O(N²) 独立实现）逐点一致', () => {
  // 自洽性质（往返/Parseval）能过，仍可能是"错的同一个变换"；
  // 用定义式直接算一遍做对照，才是真正的独立验证。
  const n = 16
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) * 2 + Math.cos(i * 1.1))
  const re = Float64Array.from(x)
  const im = new Float64Array(n)
  fft1d(re, im, false)

  let maxErr = 0
  for (let k = 0; k < n; k++) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n
      sr += x[t] * Math.cos(ang)
      si += x[t] * Math.sin(ang)
    }
    maxErr = Math.max(maxErr, Math.abs(re[k] - sr), Math.abs(im[k] - si))
  }
  assertTrue(maxErr < 1e-9, `与朴素 DFT 的最大偏差应接近 0，实际 ${maxErr}`)
})

// ------------------------------------------------------------ 报告

await runner.test('报告：权重合计为 1，各信号贡献之和等于总分，且恒带未标定声明', () => {
  const sum = Object.values(WEIGHTS).reduce((s, v) => s + v, 0)
  assertTrue(Math.abs(sum - 1) < 1e-9, `权重合计应为 1，实际 ${sum}`)
  const report = buildReport({
    kind: 'test',
    signals: { metadata: { score: 1 }, frequency: { score: 0 }, noise: { score: 0 }, color: { score: 0 }, edge: { score: 0 } },
    measurements: {},
  })
  assertTrue(Math.abs(report.score - WEIGHTS.metadata) < 1e-9, '总分应等于 1×metadata 权重')
  const contributionSum = report.signals.reduce((s, x) => s + x.contribution, 0)
  assertTrue(Math.abs(contributionSum - report.score) < 1e-9, '贡献之和应等于总分')
  assertEqual(report.calibrated, false, '必须标注未标定')
  assertTrue(DISCLAIMER.length > 20, '必须有免责声明')
  assertEqual(CALIBRATED, false, '模块级常量也应标明未标定')
})

await runner.test('报告：verdict 按阈值分档（总分是加权和）', () => {
  const mk = (metadataScore, frequencyScore) =>
    buildReport({
      kind: 't',
      signals: {
        metadata: { score: metadataScore },
        frequency: { score: frequencyScore },
        noise: { score: 0 },
        color: { score: 0 },
        edge: { score: 0 },
      },
      measurements: {},
    })
  const zero = mk(0, 0)
  assertEqual(zero.verdict, 'low', '总分 0 → low')

  // 0.35×0.5 + 0.25×0.5 = 0.30 → 仍低
  const lowish = mk(0.5, 0.5)
  assertTrue(lowish.score < THRESHOLDS.low, `总分 ${lowish.score.toFixed(3)} 应低于下阈值`)
  assertEqual(lowish.verdict, 'low', '低于下阈值 → low')

  // 两个信号都拉满 = 0.35 + 0.25 = 0.60 → 落在 [0.35, 0.65) → medium
  const med = mk(1, 1)
  assertTrue(Math.abs(med.score - 0.6) < 1e-9, `总分应为 0.60，实际 ${med.score}`)
  assertEqual(med.verdict, 'medium', '0.60 → medium')
  // 这正体现设计意图：单个信号即使满分也不足以达到 high
  assertTrue(med.score < THRESHOLDS.high, '两个信号拉满仍不到高阈值')
})

await runner.test('报告：分数始终夹在 [0,1]（越界的原始指标不会溢出）', () => {
  const report = buildReport({
    kind: 't',
    signals: { metadata: { score: 5 }, frequency: { score: -3 }, noise: { score: 0 }, color: { score: 0 }, edge: { score: 0 } },
    measurements: {},
  })
  assertTrue(report.score >= 0 && report.score <= 1, `分数应在 [0,1]，实际 ${report.score}`)
})

await runner.test('模块 E：带 AI 工具签名的图给出更高可能性，干净图更低', () => {
  const image = gradient(64, 64)
  const withMark = detectAIGenerated(image, { fileBytes: buildJpeg({ xmp: 'CreatorTool="Adobe Firefly"' }) })
  const clean = detectAIGenerated(image, { fileBytes: buildJpeg({ exif: { Software: 'Nikon Transfer 2' } }) })
  assertTrue(withMark.score > clean.score, `带签名 ${withMark.score.toFixed(3)} 应 > 干净 ${clean.score.toFixed(3)}`)
  assertTrue(withMark.verdict !== 'low', `带签名不应是 low，实际 ${withMark.verdict}`)
  assertTrue(withMark.evidence.some((e) => /firefly/i.test(e)), `证据里应提到 Firefly：${withMark.evidence}`)
  assertEqual(clean.calibrated, false, '干净图同样带未标定声明')
})

await runner.test('模块 E：不带字节时元数据信号为 0（不因为缺数据而乱猜）', () => {
  const report = detectAIGenerated(gradient(32, 32))
  const metadataSignal = report.signals.find((s) => s.name === 'metadata')
  assertEqual(metadataSignal.score, 0, '没有文件字节时元数据信号应为 0')
})

await runner.test('模块 D：嵌入本项目水印的图能被检出，且证据里带水印文本', async () => {
  const image = gradient(200, 150)
  const { outputImage } = embedWatermark(image, { publicInfo: '版权归 XUQIAN 所有' })
  const report = await detectAIWatermark(outputImage)
  const wmSignal = report.signals.find((s) => s.name === 'frequency')
  assertEqual(wmSignal.score, 1, '应直接读出本项目的 LSB 水印')
  assertTrue(report.watermark?.publicInfo === '版权归 XUQIAN 所有', '应取回公开水印文本')
  assertTrue(report.evidence.some((e) => e.includes('版权归 XUQIAN')), `证据：${report.evidence}`)
  assertTrue(report.verdict !== 'low', '检出真实水印不应是 low')
})

await runner.test('模块 D：无水印的图不会误报为"有水印"', async () => {
  const report = await detectAIWatermark(gradient(120, 90))
  assertEqual(report.watermark, null, '不应检出本项目水印')
  assertTrue(report.score < THRESHOLDS.high, `不应给出高可能性，实际 ${report.score.toFixed(3)}`)
})

await runner.test('analyzeAll 汇总五个模块且结构齐全', () => {
  const all = analyzeAll(gradient(32, 32), buildJpeg({ exif: { Make: 'X' } }))
  for (const key of ['metadata', 'frequency', 'noise', 'color', 'edge']) {
    assertTrue(all[key] !== null && typeof all[key] === 'object', `缺少 ${key}`)
  }
  assertTrue(typeof all.frequency.highFreqRatio === 'number', '频域应有具体指标')
  assertTrue(typeof all.noise.lsbEntropy === 'number', '噪声应有 LSB 熵')
})

runner.finish()
