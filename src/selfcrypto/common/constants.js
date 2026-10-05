/**
 * 核心常量表 —— 对应 SPEC 第 3 节「核心常量表」。
 *
 * 原则：只收录 SPEC 明文给出的值。SPEC 第 9 节的待确认项一律留 TODO，
 * 不自行假设（SPEC 第 8 节：遇到未定义参数应先列出问题再等待确认）。
 *
 * 路径说明：SPEC 原设计里这些文件位于 `src/crypto/` 与 `src/common/`；
 * 本仓库已存在 AEAD 版 `src/crypto/`（简单加密那一套），两条路线需并存，
 * 因此自研加密整体挂在 `src/selfcrypto/` 命名空间下，文件名与职责与 SPEC 1:1 对应。
 */

/** SPEC §3：MAGIC 建议用八个非打印字节。此处采用 SPEC 的建议值 —— 属于 §9 待确认项。 */
export const MAGIC = Uint8Array.from([0xda, 0x7a, 0x9f, 0x3c, 0x00, 0xff, 0x1b, 0x8e])

/** SPEC §3：VERSION 当前为 0x01 */
export const VERSION = 0x01

/** SPEC §3：PBKDF2 迭代次数默认 600000 */
export const ITER = 600000

export const SALT_LEN = 32
export const TIMESTAMP_LEN = 4
export const BOOT_NONCE_LEN = 16
export const KEY_CHECK_LEN = 16
export const MAC_LEN = 32
export const RULES_LEN_LEN = 4

/** SPEC §3：分块大小 1048576 字节（1 MiB） */
export const CHUNK_SIZE = 1048576

/** SPEC §3：段数 3；拆分方式默认按字节交错；三份顺序默认 2 0 1 */
export const SEGMENTS = 3
export const SEGMENT_ORDER = [2, 0, 1]
export const SPLIT_MODE = 'interleave-bytes'

/** SPEC §3：字段长度前缀统一大端 */
export const ENDIAN = 'big'

/** SPEC §3：水印 LSB 通道顺序 R G B */
export const LSB_CHANNEL_ORDER = ['R', 'G', 'B']

/** SPEC §3：有形水印字号为图片宽度的 1%~2%，透明度 15%~30%，边距 3~8 像素 */
export const VISIBLE_FONT_WIDTH_RATIO = [0.01, 0.02]
export const VISIBLE_OPACITY = [0.15, 0.3]
export const VISIBLE_MARGIN_PX = [3, 8]

/** SPEC §3：统一延迟 4~5 秒随机（失败路径专用，见 common/delay.js） */
export const UNIFORM_DELAY_MS = [4000, 5000]

/**
 * SPEC §9 的待确认项 —— 在用户确认前，以下参数**不设默认值**，
 * 相关代码必须显式接收它们而不是回退到某个"猜"的常量。
 *
 * 注：SPEC §9 原列的第 3 项「FK 包装后的字节布局」**已定案，不再列于此** ——
 * 用户确认该处的 FK 指国密 SM4 标准（GB/T 32907-2016）的系统参数，属算法内置常量，
 * 与文件格式无关；文件头偏移 10 的 2 字节已正名为普通保留位 RESERVED。
 */
export const UNCONFIRMED = Object.freeze([
  'MAGIC 的具体二进制值（当前用 SPEC 建议值）',
  '规则块编码用 JSON 还是自定义二进制',
  '整体 MAC 覆盖哪些字节',
  '公开层 LSB 的具体位置规则',
  '私有层 LSB 的具体位置规则',
  '有形水印的字体选择',
  'AI 检测的权重和阈值',
  '水印模块是否与文件加密共用规则文件',
])
