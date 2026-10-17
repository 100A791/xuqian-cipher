/**
 * 生成 PWA 图标（无第三方依赖）。
 *
 * 产出：
 *   public/icons/icon-192.png
 *   public/icons/icon-512.png
 *   public/favicon.svg
 *
 * 设计：深色底 + 朱红印章方块 + 金色描边 + 金色「X」。
 * 刻意不用文字渲染（没有字体依赖），只用线段与矩形，因此在任何机器上生成结果一致。
 *
 * 用法：node scripts/gen-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const BG = [11, 15, 20, 255]
const SEAL = [143, 29, 20, 255]
const GOLD = [216, 178, 106, 255]
const LIGHT = [242, 226, 189, 255]

/** 点到线段的距离（用于画带圆头的粗线）。 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(px, x1 - r))
  const cy = Math.max(y0 + r, Math.min(py, y1 - r))
  return (
    Math.hypot(px - cx, py - cy) <= r ||
    (px >= x0 && px <= x1 && py >= y0 + r && py <= y1 - r) ||
    (py >= y0 && py <= y1 && px >= x0 + r && px <= x1 - r)
  )
}

/** 在 size×size 的画布上返回 RGBA 像素（尺寸为最终尺寸，内部 3× 超采样抗锯齿）。 */
function render(size) {
  const S = 3 // 超采样倍数
  const n = size * S
  const scale = n / 512
  const out = new Uint8Array(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = (x * S + sx + 0.5) / scale
          const py = (y * S + sy + 0.5) / scale
          let color = BG
          // 印章方块
          if (inRoundedRect(px, py, 80, 80, 432, 432, 36)) color = SEAL
          // 内描边（画在方块内侧）
          if (inRoundedRect(px, py, 98, 98, 414, 414, 24) && !inRoundedRect(px, py, 106, 106, 406, 406, 18))
            color = GOLD
          // 金色 X
          if (distToSegment(px, py, 176, 176, 336, 336) <= 17 || distToSegment(px, py, 336, 176, 176, 336) <= 17) {
            color = LIGHT
          }
          r += color[0]
          g += color[1]
          b += color[2]
          a += color[3]
        }
      }
      const count = S * S
      const i = (y * size + x) * 4
      out[i] = Math.round(r / count)
      out[i + 1] = Math.round(g / count)
      out[i + 2] = Math.round(b / count)
      out[i + 3] = Math.round(a / count)
    }
  }
  return out
}

// ---- 最小 PNG 编码器（RGBA / 8bit / 无滤波）----
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of [192, 512]) {
  const png = encodePng(size, render(size))
  writeFileSync(join(outDir, `icon-${size}.png`), png)
  console.log(`[icons] icon-${size}.png ${png.length} bytes`)
}

// 矢量版 favicon：与 PNG 同一套几何，浏览器缩放时更清晰
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0b0f14"/>
  <rect x="80" y="80" width="352" height="352" rx="36" fill="#8f1d14"/>
  <rect x="102" y="102" width="308" height="308" rx="20" fill="none" stroke="#d8b26a" stroke-width="8"/>
  <g stroke="#f2e2bd" stroke-width="34" stroke-linecap="round">
    <line x1="176" y1="176" x2="336" y2="336"/>
    <line x1="336" y1="176" x2="176" y2="336"/>
  </g>
</svg>
`
writeFileSync(join(root, 'public', 'favicon.svg'), svg)
console.log('[icons] favicon.svg')
