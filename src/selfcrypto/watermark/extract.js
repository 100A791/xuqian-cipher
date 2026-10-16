/**
 * 水印的公开提取与私有提取 —— SPEC 第 5 节阶段三「再写 extract.js 实现公开提取和私有提取」，
 * 也是 SPEC §4 模块 B（embedWatermark）与模块 C2（extractWatermark）的落地。
 * 零第三方依赖（SPEC §7）。
 *
 * 三层结构与"鸡生蛋"问题的解法（**决策 D16**）：
 *
 *   [公开头 80 字节]  ← 写在与密钥无关的**常量位置**上（种子是固定常量，不是秘密）
 *   [公开层 载荷]     ← 位置由"公开头里的 publicSeed"决定；**不需要密钥**即可读出
 *   [私有层 载荷]     ← 位置由 "HMAC(WK, 公开头字节)" 决定（SPEC §9：规则文件 + WK 共同定义），
 *                       并跳过公开头与公开层占用的槽位，保证三层互不覆盖
 *
 * 公开头是**定长结构**（不是 KV），这样提取时无需先知道长度就能读出来：
 *
 *   偏移  长度  字段
 *   0     1    版本（1）
 *   1     1    标志位（bit0 = 带形水印）
 *   2     4    公开层明文字节数（u32）
 *   6     4    私有层打包字节数（u32，0 表示没有私有层）
 *   10    32   公开层位置种子
 *   42    38   保留（必须为 0）
 */
import { FormatError } from '../file/format.js'
import { concatBytes, copyBytes, utf8Decode, utf8Encode } from '../common/bytes.js'
import { assertBytes } from '../common/validate.js'
import { fail } from '../common/fail.js'
import {
  LAYER_HEADER_LEN,
  embedLayer,
  extractLayer,
  planSlots,
  derivePrivateSeed,
  readBytesAtSlots,
  slotsToSet,
  writeBytesAtSlots,
} from './lsb.js'
import { decryptWatermarkPayload, encryptWatermarkPayload, generateWatermarkKey } from './watermark_crypto.js'
import { randomBytes } from '../crypto/random.js'

export const WM_VERSION = 1
export const WM_FLAG_VISIBLE = 0b0000_0001
export const PUBLIC_HEADER_LEN = 80
/** 公开头的位置种子：固定常量，任何人都能算出来——它只是"入口"，不含秘密。 */
export const PUBLIC_HEADER_SEED = utf8Encode('xq/v1/wm-public-header')

export function buildPublicHeader({ version = WM_VERSION, flags = 0, publicInfoLen, privatePackedLen, publicSeed }) {
  if (!(publicSeed instanceof Uint8Array) || publicSeed.length !== 32) throw new RangeError('公开种子必须 32 字节')
  const out = new Uint8Array(PUBLIC_HEADER_LEN)
  const dv = new DataView(out.buffer)
  out[0] = version
  out[1] = flags
  dv.setUint32(2, publicInfoLen)
  dv.setUint32(6, privatePackedLen)
  out.set(publicSeed, 10)
  return out
}

export function parsePublicHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== PUBLIC_HEADER_LEN) {
    throw new FormatError('WM_HEADER_INVALID', '公开头长度不对')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[0]
  if (version !== WM_VERSION) throw new FormatError('WM_VERSION_UNSUPPORTED', `不支持的水印版本：${version}`)
  const flags = bytes[1]
  if ((flags & ~WM_FLAG_VISIBLE) !== 0) throw new FormatError('WM_FLAGS_INVALID', '未知标志位')
  for (let i = 42; i < PUBLIC_HEADER_LEN; i++) {
    if (bytes[i] !== 0) throw new FormatError('WM_RESERVED_NONZERO', '保留字段必须为 0')
  }
  return {
    version,
    flags,
    hasVisible: (flags & WM_FLAG_VISIBLE) !== 0,
    publicInfoLen: dv.getUint32(2),
    privatePackedLen: dv.getUint32(6),
    publicSeed: copyBytes(bytes.subarray(10, 42)),
  }
}

/**
 * 三层位置规划（写入与读取共用，保证两边算出的槽位完全一致）。
 * `privateSeed` 由调用方显式传入（写入时 = HMAC(WK, 头字节)，读取时同理），
 * 不用模块级可变状态，避免"谁最后设过种子"这种隐蔽耦合。
 */
export function planWatermarkLayout(image, header, privateSeed = null) {
  const headerSlots = planSlots({
    image,
    seed: PUBLIC_HEADER_SEED,
    byteLen: PUBLIC_HEADER_LEN,
    framing: false,
    label: 'wm/hdr',
  })
  const headerSet = slotsToSet(headerSlots)
  const publicSlots =
    header.publicInfoLen > 0
      ? planSlots({ image, seed: header.publicSeed, byteLen: header.publicInfoLen, skip: headerSet, label: 'wm/pub' })
      : []
  const used = new Set([...headerSlots, ...publicSlots])
  const privateSlots =
    header.privatePackedLen > 0
      ? planSlots({ image, seed: privateSeed, byteLen: header.privatePackedLen, skip: used, label: 'wm/priv' })
      : []
  return { headerSlots, publicSlots, privateSlots }
}

/**
 * 嵌入水印（SPEC §4 模块 B）。
 * @param {{data: Uint8Array, width: number, height: number}} image 原图（会被复制，不就地改动）
 * @param {{publicInfo?: string, privateInfo?: string, keyWK?: Uint8Array, withVisible?: boolean}} info
 * @returns {{ outputImage: {data: Uint8Array, width: number, height: number}, keyWK: Uint8Array, header: object, layout: object }}
 */
export function embedWatermark(image, info = {}) {
  if (!image || !(image.data instanceof Uint8Array)) throw new TypeError('图片必须是 { data, width, height }')
  const outputImage = { data: copyBytes(image.data), width: image.width, height: image.height }

  const publicBytes = info.publicInfo ? utf8Encode(info.publicInfo) : new Uint8Array(0)
  const keyWK = info.keyWK ? copyBytes(info.keyWK) : generateWatermarkKey()
  const privatePacked = info.privateInfo
    ? encryptWatermarkPayload(utf8Encode(info.privateInfo), keyWK)
    : new Uint8Array(0)

  const header = {
    version: WM_VERSION,
    flags: info.withVisible ? WM_FLAG_VISIBLE : 0,
    publicInfoLen: publicBytes.length,
    privatePackedLen: privatePacked.length,
    publicSeed: randomBytes(32),
  }
  const headerBytes = buildPublicHeader(header)
  const layout = planWatermarkLayout(outputImage, header, derivePrivateSeed(keyWK, headerBytes))

  // 写入顺序：公开头 → 公开层 → 私有层（位置规划已保证互不重叠）
  writeBytesAtSlots(outputImage, layout.headerSlots, headerBytes)
  if (publicBytes.length > 0) embedLayer(outputImage, publicBytes, layout.publicSlots)
  if (privatePacked.length > 0) embedLayer(outputImage, privatePacked, layout.privateSlots)

  return { outputImage, keyWK, header: parsePublicHeader(headerBytes), layout }
}

/**
 * 提取水印（SPEC §4 模块 C2）。
 * 公开信息**不需要密钥**；私有信息需要 WK，WK 不对时走统一失败。
 *
 * `keyWK` 刻意**不给默认值**：给 `= null` 会让 TS 从实现推断出的参数类型收窄成 `null`，
 * 界面层（TS）传 Uint8Array 就会被判类型错误。内部一律用 `if (!keyWK)` 处理空值。
 *
 * @returns {Promise<{ publicInfo: string|null, privateInfo: string|null, hasVisible: boolean, header: object, privateLocked: boolean }>}
 */
export async function extractWatermark(image, keyWK) {
  if (!image || !(image.data instanceof Uint8Array)) throw new TypeError('图片必须是 { data, width, height }')

  // ① 公开头（常量位置，无需密钥）
  let header
  let headerSlots
  let headerBytes
  try {
    headerSlots = planSlots({
      image,
      seed: PUBLIC_HEADER_SEED,
      byteLen: PUBLIC_HEADER_LEN,
      framing: false,
      label: 'wm/hdr',
    })
    headerBytes = readBytesAtSlots(image, headerSlots, PUBLIC_HEADER_LEN)
    header = parsePublicHeader(headerBytes)
  } catch (error) {
    // 图里没有水印属"正常结论"而非"解密失败"，故不套统一延迟
    throw new FormatError('WM_ABSENT', `未找到可识别的水印（${error?.code ?? error?.message ?? 'unknown'}）`)
  }

  // ② 公开层（无需密钥）
  let publicInfo = null
  let publicSlots = []
  if (header.publicInfoLen > 0) {
    publicSlots = planSlots({
      image,
      seed: header.publicSeed,
      byteLen: header.publicInfoLen,
      skip: slotsToSet(headerSlots),
      label: 'wm/pub',
    })
    const bytes = extractLayer(image, publicSlots)
    publicInfo = utf8Decode(bytes)
  }

  // ③ 私有层（需要 WK）
  if (header.privatePackedLen === 0) {
    return { publicInfo, privateInfo: null, hasVisible: header.hasVisible, header, privateLocked: false }
  }
  if (!keyWK) {
    // 明确告知"需要密钥"，但不因此走失败延迟：这是查询结果，不是解密失败
    return { publicInfo, privateInfo: null, hasVisible: header.hasVisible, header, privateLocked: true }
  }

  // 关键：进入私有层后，**任何**失败都必须收敛成统一失败。
  // WK 不对时位置序列本身就是错的，会先撞上"长度字段非法"这类结构错误；
  // 若原样抛出，等于告诉攻击者"卡在哪一步"，与 SPEC §7「禁止提示解密失败的具体原因」、
  // §6 阶段三「错误 WK 统一失败」直接冲突。
  try {
    const privateSlots = planSlots({
      image,
      seed: derivePrivateSeed(assertBytes(keyWK, 'WK'), headerBytes),
      byteLen: header.privatePackedLen,
      skip: new Set([...headerSlots, ...publicSlots]),
      label: 'wm/priv',
    })
    const packed = extractLayer(image, privateSlots)
    const plain = await decryptWatermarkPayload(packed, keyWK)
    return { publicInfo, privateInfo: utf8Decode(plain), hasVisible: header.hasVisible, header, privateLocked: false }
  } catch (error) {
    if (error && error.code === 'XQ_UNIFORM_FAIL') throw error
    return fail(`wm-private:${error?.code ?? 'unknown'}`)
  }
}
