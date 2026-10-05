/**
 * LSB 水印的嵌入与提取 —— SPEC 第 5 节阶段三「先写 lsb.js 实现 LSB 嵌入和提取」。
 * 零第三方依赖（SPEC §7）。
 *
 * 表示约定（**决策 D11**）：图片用普通对象 `{ data, width, height }` 表示，
 * `data` 是 RGBA 每像素 4 字节（与浏览器 ImageData 同形，但不必依赖浏览器 API，Node 里可测）。
 * 通道顺序按 SPEC §3 固定为 **R, G, B**（alpha 不动，避免影响不透明度语义）。
 *
 * 位置规则（SPEC §9 待确认项，用户授权按决策记录取值）：
 *   **D12** 位置序列 = `(start + k × step) mod N`（N = 可用槽位数）。
 *          只要 step 与 N 互质，前 N 项就互不重复 —— O(1) 内存、无需物化整张置换表
 *          （大图 N 可达数千万，物化会吃掉数百 MB）。
 *          编号 k 的槽位：像素 = floor(slot / 3)，通道 = slot % 3（0=R 1=G 2=B）。
 *   **D13** 公开层种子来自规则块（无需密钥即可复现）；私有层种子 =
 *          `HMAC(WK, "xq/v1/wm-private" ‖ 规则块字节)`，并且**跳过公开层已占用的槽位**，
 *          保证两层写入同一张图时不会互相覆盖。
 *   **D14** 每层载荷 = `u32 长度前缀 ‖ 内容`，比特按 MSB 优先写入 LSB。
 *
 * 种子 → 字节流用 HMAC-SHA256 计数器模式（构造，不是新算法；SPEC §7 只允许既定原语）。
 */
import { FormatError } from '../file/format.js'
import { hmacSha256 } from '../crypto/hmac.js'
import { concatBytes, utf8Encode } from '../common/bytes.js'
import { LSB_CHANNEL_ORDER } from '../common/constants.js'

export const PRIVATE_SEED_LABEL = 'xq/v1/wm-private'
/** 每层载荷头：u32 长度 */
export const LAYER_HEADER_LEN = 4

/** 造一张测试/演示用的图（RGBA）。 */
export function createImage(width, height, fill = 128) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('图片尺寸非法')
  }
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i++) data[i] = fill
  // alpha 固定为不透明，避免测试里因 alpha 变化产生歧义
  for (let p = 3; p < data.length; p += 4) data[p] = 255
  return { data, width, height }
}

function assertImage(image) {
  if (!image || !(image.data instanceof Uint8Array)) throw new TypeError('图片必须是 { data, width, height }')
  if (image.data.length !== image.width * image.height * 4) {
    throw new FormatError('IMAGE_INVALID', '图片字节数与尺寸不符')
  }
  return image
}

/** 可用槽位数 = 像素数 × 3（只用 RGB 三个通道，SPEC §3）。 */
export function slotCapacity(image) {
  assertImage(image)
  if (LSB_CHANNEL_ORDER.length !== 3) throw new FormatError('CHANNEL_ORDER_INVALID', '通道顺序必须是三个')
  return image.width * image.height * LSB_CHANNEL_ORDER.length
}

/** 槽位 → 字节偏移（RGBA 里 R/G/B 分别是 +0/+1/+2）。 */
export function slotToOffset(slot) {
  const pixel = Math.floor(slot / 3)
  const channel = slot % 3
  return pixel * 4 + channel
}

const gcd = (a, b) => {
  let x = a
  let y = b
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

/** 种子 → 确定性字节流（HMAC-SHA256 计数器模式）。 */
export function streamBytes(seed, label, count) {
  if (!(seed instanceof Uint8Array)) throw new TypeError('种子必须是字节串')
  const labelBytes = utf8Encode(label)
  const out = new Uint8Array(count)
  let off = 0
  let counter = 0
  while (off < count) {
    const block = hmacSha256(seed, concatBytes(labelBytes, u32be(counter)))
    const take = Math.min(block.length, count - off)
    out.set(block.subarray(0, take), off)
    off += take
    counter += 1
  }
  return out
}

function u32be(v) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v)
  return b
}

/** 由种子推出与 N 互质的步长（互质 ⇒ 序列前 N 项互不重复）。 */
export function deriveStep(seed, N, label = 'wm/step') {
  if (N <= 1) return 1
  const raw = new DataView(streamBytes(seed, label, 8).buffer, 0, 8)
  let step = Number(raw.getBigUint64(0) % BigInt(N - 1)) + 1
  for (let guard = 0; guard <= N; guard++) {
    if (gcd(step, N) === 1) return step
    step = (step % (N - 1)) + 1
  }
  return 1
}

/** 由种子推起点。 */
export function deriveStart(seed, N, label = 'wm/start') {
  if (N <= 1) return 0
  return Number(new DataView(streamBytes(seed, label, 8).buffer, 0, 8).getBigUint64(0) % BigInt(N))
}

/**
 * 生成位置序列。`skip` 里的槽位会被跳过（用于让私有层避开公开层）。
 * `framing` 为真时按"u32 长度前缀 + 内容"预留槽位；为假时只预留内容本身。
 */
export function planSlots({ image, seed, byteLen, skip = null, label = 'wm', framing = true }) {
  const N = slotCapacity(image)
  const needBits = (byteLen + (framing ? LAYER_HEADER_LEN : 0)) * 8
  if (needBits > N) {
    throw new FormatError('WM_CAPACITY_EXCEEDED', `图片容量不足：需要 ${needBits} 位，可用 ${N} 位`)
  }
  const step = deriveStep(seed, N, `${label}/step`)
  const start = deriveStart(seed, N, `${label}/start`)
  const slots = []
  let k = 0
  while (slots.length < needBits) {
    const slot = (start + k * step) % N
    k += 1
    if (skip && skip.has(slot)) continue
    slots.push(slot)
  }
  return slots
}

/** 把字节写进给定槽位的最低有效位（MSB 优先）。 */
export function writeBytesAtSlots(image, slots, bytes) {
  assertImage(image)
  if (slots.length < bytes.length * 8) throw new FormatError('WM_SLOTS_INSUFFICIENT', '槽位数不足')
  let index = 0
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const value = (byte >> bit) & 1
      const offset = slotToOffset(slots[index])
      image.data[offset] = (image.data[offset] & 0xfe) | value
      index += 1
    }
  }
  return image
}

/** 从给定槽位读出字节。 */
export function readBytesAtSlots(image, slots, byteLen) {
  assertImage(image)
  if (slots.length < byteLen * 8) throw new FormatError('WM_SLOTS_INSUFFICIENT', '槽位数不足')
  const out = new Uint8Array(byteLen)
  let index = 0
  for (let i = 0; i < byteLen; i++) {
    let byte = 0
    for (let bit = 7; bit >= 0; bit--) {
      byte = (byte << 1) | (image.data[slotToOffset(slots[index])] & 1)
      index += 1
    }
    out[i] = byte
  }
  return out
}

/** 写入一层（自动加 u32 长度前缀）。 */
export function embedLayer(image, payload, slots) {
  const len = new Uint8Array(LAYER_HEADER_LEN)
  new DataView(len.buffer).setUint32(0, payload.length)
  return writeBytesAtSlots(image, slots, concatBytes(len, payload))
}

/** 读出一层：先读长度前缀，再读内容；长度非法即报错（不静默截断）。 */
export function extractLayer(image, slots) {
  const head = readBytesAtSlots(image, slots, LAYER_HEADER_LEN)
  const len = new DataView(head.buffer, head.byteOffset).getUint32(0)
  if (len > slots.length / 8 - LAYER_HEADER_LEN) {
    throw new FormatError('WM_LENGTH_INVALID', `水印长度字段非法：${len}`)
  }
  // 注意：slots 是普通数组（不是 TypedArray），只能用 slice 不能用 subarray
  return readBytesAtSlots(image, slots.slice(LAYER_HEADER_LEN * 8), len)
}

/** 由私有密钥与规则块推出私有层种子（SPEC §9：私有层位置 = 规则文件 + WK 共同决定）。 */
export function derivePrivateSeed(keyWK, rulesBytes) {
  if (!(keyWK instanceof Uint8Array)) throw new TypeError('WK 必须是字节串')
  if (!(rulesBytes instanceof Uint8Array)) throw new TypeError('规则块必须是字节串')
  return hmacSha256(keyWK, concatBytes(utf8Encode(PRIVATE_SEED_LABEL), rulesBytes))
}

/** 计算某层写入后占用的槽位集合（供另一层避让）。 */
export function slotsToSet(slots) {
  return new Set(slots)
}
