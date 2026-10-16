/**
 * 图片水印测试 —— SPEC 第 6 节阶段三验收标准：
 *   「图片嵌入水印后肉眼正常 / 公开提取无需密钥可读 / 私有提取需要 WK 可读 / 错误 WK 统一失败」
 * 运行：node tests/unit/test_watermark.js
 */
import {
  createImage,
  deriveStep,
  planSlots,
  slotCapacity,
  slotToOffset,
  streamBytes,
} from '../../src/selfcrypto/watermark/lsb.js'
import {
  PUBLIC_HEADER_SEED,
  buildPublicHeader,
  embedWatermark,
  extractWatermark,
  parsePublicHeader,
} from '../../src/selfcrypto/watermark/extract.js'
import {
  checkWatermarkKey,
  decryptWatermarkPayload,
  encryptWatermarkPayload,
  generateWatermarkKey,
} from '../../src/selfcrypto/watermark/watermark_crypto.js'
import {
  VISIBLE_MODES,
  assertStyleWithinSpec,
  computeTextAnchor,
  computeTileWatermarkStyle,
  computeVisibleWatermarkStyle,
  drawTiledWatermark,
  drawVisibleWatermark,
  tileCounts,
} from '../../src/selfcrypto/watermark/visible.js'
import { setInternalDiagnostics } from '../../src/selfcrypto/common/fail.js'
import { setUniformDelayRange } from '../../src/selfcrypto/common/delay.js'
import { assertEqual, assertTrue, bytesToHex, createRunner } from './_helpers.js'

const runner = createRunner('图片水印（LSB / 公开层 / 私有层）')
setUniformDelayRange([0, 0])
const reasons = []
setInternalDiagnostics((reason) => reasons.push(reason))

const utf8 = (s) => new TextEncoder().encode(s)
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))

/** 逐通道最大差值：LSB 水印在肉眼上应当"看不出来"。 */
function channelDelta(before, after) {
  let max = 0
  let sum = 0
  let count = 0
  for (let i = 0; i < before.length; i++) {
    if (i % 4 === 3) continue // alpha 不动
    const d = Math.abs(before[i] - after[i])
    if (d > max) max = d
    sum += d
    count += 1
  }
  return { max, mean: sum / count }
}

// ------------------------------------------------------------------ LSB 基础

await runner.test('位置序列：step 与槽位数互质（保证序列不重复）', () => {
  for (const [w, h] of [
    [7, 5],
    [16, 16],
    [100, 1],
    [3, 3],
  ]) {
    const image = createImage(w, h)
    const N = slotCapacity(image)
    const seed = streamBytes(utf8('seed'), 'k', 32)
    const step = deriveStep(seed, N)
    assertEqual(gcd(step, N), 1, `${w}×${h} 的 step 互质`)
  }
})

await runner.test('位置序列：前 need 项互不重复', () => {
  const image = createImage(200, 150) // 90000 个槽位
  const N = slotCapacity(image)
  const seed = streamBytes(utf8('seed2'), 'k', 32)
  const slots = planSlots({ image, seed, byteLen: 500 })
  assertEqual(slots.length, (500 + 4) * 8, '槽位数 = (长度+4)×8')
  assertEqual(new Set(slots).size, slots.length, '不得重复')
  assertTrue(
    slots.every((s) => s >= 0 && s < N),
    '槽位在范围内',
  )
  assertTrue(slots.length <= N, '不得超过总容量')
})

await runner.test('容量不足 → 明确报错（不静默截断）', () => {
  const image = createImage(4, 4) // 48 位
  let code = null
  try {
    planSlots({ image, seed: streamBytes(utf8('s'), 'k', 32), byteLen: 100 })
  } catch (error) {
    code = error.code
  }
  assertEqual(code, 'WM_CAPACITY_EXCEEDED', '容量错误码')
})

await runner.test('slotToOffset 按 RGB 顺序落位，不动 alpha', () => {
  assertEqual(slotToOffset(0), 0, '第 0 槽 → R')
  assertEqual(slotToOffset(1), 1, '第 1 槽 → G')
  assertEqual(slotToOffset(2), 2, '第 2 槽 → B')
  assertEqual(slotToOffset(3), 4, '第 3 槽 → 下一像素的 R')
})

// ------------------------------------------------------------ 私有层加解密

await runner.test('私有层打包往返：随机 nonce 每次不同，WK 正确可解', async () => {
  const wk = generateWatermarkKey()
  const plain = utf8('内部备注：编号 A-1024')
  const a = encryptWatermarkPayload(plain, wk)
  const b = encryptWatermarkPayload(plain, wk)
  assertTrue(bytesToHex(a) !== bytesToHex(b), '同样明文两次加密应不同（nonce 随机）')
  assertEqual(bytesToHex(await decryptWatermarkPayload(a, wk)), bytesToHex(plain), '解出原文')
  assertTrue(checkWatermarkKey(a, wk), 'checkWatermarkKey 正确密钥为真')
  assertTrue(!checkWatermarkKey(a, generateWatermarkKey()), '错误密钥为假')
})

await runner.test('私有层：错误 WK / 篡改密文 → 统一失败且不返回内容', async () => {
  const wk = generateWatermarkKey()
  const packed = encryptWatermarkPayload(utf8('秘密'), wk)
  const wrong = generateWatermarkKey()
  reasons.length = 0
  let error = null
  let returned = null
  try {
    returned = await decryptWatermarkPayload(packed, wrong)
  } catch (e) {
    error = e
  }
  assertTrue(returned === null && error !== null, '错误 WK 必须抛错')
  assertEqual(error.message, '解密失败', '统一文案')
  assertTrue(reasons.includes('wm-mac-mismatch'), `内部原因应为 wm-mac-mismatch，实际 ${JSON.stringify(reasons)}`)

  const tampered = new Uint8Array(packed)
  tampered[20] ^= 0x01
  reasons.length = 0
  let e2 = null
  try {
    await decryptWatermarkPayload(tampered, wk)
  } catch (e) {
    e2 = e
  }
  assertEqual(e2?.message, '解密失败', '篡改也走统一失败')
})

// ------------------------------------------------------------ 公开头结构

await runner.test('公开头：定长 80 字节，往返一致，保留字段非零即拒绝', () => {
  const header = {
    version: 1,
    flags: 0,
    publicInfoLen: 12,
    privatePackedLen: 60,
    publicSeed: streamBytes(utf8('pub'), 'k', 32),
  }
  const bytes = buildPublicHeader(header)
  assertEqual(bytes.length, 80, '定长 80')
  const parsed = parsePublicHeader(bytes)
  assertEqual(parsed.publicInfoLen, 12, 'publicInfoLen')
  assertEqual(parsed.privatePackedLen, 60, 'privatePackedLen')
  assertEqual(bytesToHex(parsed.publicSeed), bytesToHex(header.publicSeed), 'publicSeed')

  const bad = new Uint8Array(bytes)
  bad[50] = 1
  let code = null
  try {
    parsePublicHeader(bad)
  } catch (error) {
    code = error.code
  }
  assertEqual(code, 'WM_RESERVED_NONZERO', '保留字段必须为 0')
})

// ------------------------------------------------------------------ 端到端

const photoLike = () => {
  // 造一张"有内容"的图：渐变 + 噪声，避免纯色导致的位置相关性
  const image = createImage(160, 120)
  for (let p = 0; p < image.width * image.height; p++) {
    const x = p % image.width
    const y = Math.floor(p / image.width)
    image.data[p * 4] = (x * 3 + y) & 0xff
    image.data[p * 4 + 1] = (y * 5) & 0xff
    image.data[p * 4 + 2] = (x ^ y) & 0xff
    image.data[p * 4 + 3] = 255
  }
  return image
}

await runner.test('嵌入后肉眼正常：逐通道最大差值 ≤ 1，且平均差值极小', () => {
  const image = photoLike()
  const { outputImage } = embedWatermark(image, { publicInfo: '版权归 XUQIAN 所有', privateInfo: '内部编号 2026-1004' })
  const delta = channelDelta(image.data, outputImage.data)
  assertTrue(delta.max <= 1, `最大通道差值 ${delta.max} 应 ≤ 1`)
  assertTrue(delta.mean < 0.5, `平均通道差值 ${delta.mean.toFixed(4)} 应 < 0.5`)
})

await runner.test('不就地改动原图（返回的是副本）', () => {
  const image = photoLike()
  const before = bytesToHex(image.data)
  embedWatermark(image, { publicInfo: 'x' })
  assertEqual(bytesToHex(image.data), before, '原图必须保持不变')
})

await runner.test('公开提取：不需要密钥即可读出', async () => {
  const image = photoLike()
  const { outputImage } = embedWatermark(image, { publicInfo: '版权归 XUQIAN 所有', privateInfo: '内部编号' })
  const result = await extractWatermark(outputImage) // 不传 WK
  assertEqual(result.publicInfo, '版权归 XUQIAN 所有', '公开信息')
  assertEqual(result.privateInfo, null, '没有 WK 时读不到私有信息')
  assertTrue(result.privateLocked, '应标记"私有层需要密钥"')
})

await runner.test('私有提取：提供正确 WK 可读', async () => {
  const image = photoLike()
  const { outputImage, keyWK } = embedWatermark(image, { publicInfo: '公开', privateInfo: '内部编号 2026-1004' })
  const result = await extractWatermark(outputImage, keyWK)
  assertEqual(result.publicInfo, '公开', '公开信息')
  assertEqual(result.privateInfo, '内部编号 2026-1004', '私有信息')
  assertTrue(!result.privateLocked, '不该标记为锁定')
})

await runner.test('私有提取：错误 WK → 统一失败（而不是给出乱码）', async () => {
  const image = photoLike()
  const { outputImage } = embedWatermark(image, { publicInfo: '公开', privateInfo: '内部编号' })
  reasons.length = 0
  let error = null
  try {
    await extractWatermark(outputImage, generateWatermarkKey())
  } catch (e) {
    error = e
  }
  assertEqual(error?.message, '解密失败', '统一文案')
  // 错误 WK 会让位置序列本身算错，因此往往先在"长度字段非法"处失败；
  // 关键不是失败在哪一步，而是**对外口径统一**、内部原因不外泄。
  assertTrue(
    reasons.length > 0 && (reasons[0] === 'wm-mac-mismatch' || reasons[0].startsWith('wm-private:')),
    `内部原因应落在私有层路径内，实际 ${JSON.stringify(reasons)}`,
  )
})

await runner.test('只写公开层时不产生私有层（长度字段为 0）', async () => {
  const image = photoLike()
  const { outputImage, header } = embedWatermark(image, { publicInfo: '只有公开信息' })
  assertEqual(header.privatePackedLen, 0, '私有层长度')
  const result = await extractWatermark(outputImage)
  assertEqual(result.publicInfo, '只有公开信息', '公开信息')
  assertTrue(!result.privateLocked, '没有私有层就不该说"需要密钥"')
})

await runner.test('未嵌入水印的图 → 报 WM_ABSENT（属"没有水印"而非"解密失败"）', async () => {
  const image = photoLike()
  let code = null
  try {
    await extractWatermark(image)
  } catch (error) {
    code = error.code
  }
  assertEqual(code, 'WM_ABSENT', '无水印错误码')
})

await runner.test('公开层与私有层位置互不重叠', async () => {
  const image = photoLike()
  const { outputImage, keyWK } = embedWatermark(image, {
    publicInfo: '公开信息' + 'x'.repeat(20),
    privateInfo: '私有信息' + 'y'.repeat(20),
  })
  // 通过公开头反推两层槽位
  const { planSlots } = await import('../../src/selfcrypto/watermark/lsb.js')
  const { derivePrivateSeed } = await import('../../src/selfcrypto/watermark/lsb.js')
  const headerSlots = planSlots({
    image: outputImage,
    seed: PUBLIC_HEADER_SEED,
    byteLen: 80,
    framing: false,
    label: 'wm/hdr',
  })
  const { readBytesAtSlots } = await import('../../src/selfcrypto/watermark/lsb.js')
  const headerBytes = readBytesAtSlots(outputImage, headerSlots, 80)
  const header = parsePublicHeader(headerBytes)
  const pubSlots = planSlots({
    image: outputImage,
    seed: header.publicSeed,
    byteLen: header.publicInfoLen,
    skip: new Set(headerSlots),
    label: 'wm/pub',
  })
  const privSlots = planSlots({
    image: outputImage,
    seed: derivePrivateSeed(keyWK, headerBytes),
    byteLen: header.privatePackedLen,
    skip: new Set([...headerSlots, ...pubSlots]),
    label: 'wm/priv',
  })
  const pubSet = new Set(pubSlots)
  assertTrue(
    privSlots.every((s) => !pubSet.has(s)),
    '私有层不得用到公开层槽位',
  )
  assertTrue(
    privSlots.every((s) => !new Set(headerSlots).has(s)),
    '私有层不得用到公开头槽位',
  )
})

await runner.test('容量不足的公开信息 → 明确报错', () => {
  const tiny = createImage(6, 6) // 108 位 = 13 字节可用
  let code = null
  try {
    embedWatermark(tiny, { publicInfo: 'x'.repeat(100) })
  } catch (error) {
    code = error.code
  }
  assertEqual(code, 'WM_CAPACITY_EXCEEDED', '容量错误码')
})

// ------------------------------------------------------------ 有形水印（纯函数部分）

await runner.test('有形水印样式：字号/透明度/边距都落在 SPEC 区间内', () => {
  for (const width of [200, 800, 1920, 4000]) {
    const style = computeVisibleWatermarkStyle({ width, height: Math.round(width * 0.75) }, { text: '许七安密匣' })
    const problems = assertStyleWithinSpec(style)
    assertTrue(typeof style.legible === 'boolean', '应如实标注字号是否可辨')
    assertEqual(problems.length, 0, `${width}px 宽：${problems.join('；')}`)
  }
})

await runner.test('有形水印样式：越界输入被夹回 SPEC 区间（不是照抄用户给的离谱值）', () => {
  const style = computeVisibleWatermarkStyle(
    { width: 1000, height: 800 },
    { text: 'x', opacity: 0.99, fontRatio: 0.5, margin: 100 },
  )
  assertEqual(assertStyleWithinSpec(style).length, 0, '越界值应被夹回区间')
  assertTrue(style.opacity <= 0.3, '透明度被夹到上限 30%')
  assertTrue(style.margin <= 8, '边距被夹到上限 8px')
})

await runner.test('有形水印锚点：右下/左下/居中位置计算正确且不越界', () => {
  const style = computeVisibleWatermarkStyle({ width: 100, height: 50 }, { text: 'x', position: 'bottom-right' })
  const br = computeTextAnchor(style, 20, 10)
  assertEqual(br.x, 100 - style.margin - 20, '右下 x')
  assertEqual(br.y, 50 - style.margin, '右下 y')
  const tl = computeTextAnchor({ ...style, position: 'top-left' }, 20, 10)
  assertEqual(tl.x, style.margin, '左上 x')
  assertEqual(tl.y, style.margin + 10, '左上 y')
  const c = computeTextAnchor({ ...style, position: 'center' }, 20, 10)
  assertEqual(c.x, 40, '居中 x')
  assertEqual(c.y, 30, '居中 y')
})

await runner.test('有形水印绘制在非浏览器环境 → 明确报错（不静默什么都不做）', () => {
  let threw = false
  try {
    drawVisibleWatermark(null, { width: 10, height: 10 }, { text: 'x' })
  } catch {
    threw = true
  }
  assertTrue(threw, '缺少 Canvas 上下文应抛错')
})

await runner.test('有形水印绘制：用假的 Canvas 上下文验证调用序列', () => {
  const calls = []
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    measureText: (text) => {
      calls.push(`measure:${text}`)
      return { width: 40 }
    },
    fillText: (text, x, y) => calls.push(`fill:${text}@${x},${y}`),
    strokeText: (text, x, y) => calls.push(`stroke:${text}@${x},${y}`),
    set font(v) {
      calls.push(`font:${v.includes('px') ? 'ok' : 'bad'}`)
    },
    get font() {
      return ''
    },
    set globalAlpha(v) {
      calls.push(`alpha:${v}`)
    },
    get globalAlpha() {
      return 1
    },
    set textBaseline(v) {
      calls.push(`baseline:${v}`)
    },
    get textBaseline() {
      return 'alphabetic'
    },
    set fillStyle(v) {
      calls.push(`fillStyle:${v}`)
    },
    get fillStyle() {
      return ''
    },
    set strokeStyle(v) {
      calls.push(`strokeStyle:${v}`)
    },
    get strokeStyle() {
      return ''
    },
    set lineWidth(v) {
      calls.push(`lineWidth:${v}`)
    },
    get lineWidth() {
      return 1
    },
  }
  const style = drawVisibleWatermark(ctx, { width: 1000, height: 800 }, { text: 'XUQIAN' })
  assertTrue(calls.includes('save') && calls.includes('restore'), '必须成对 save/restore')
  assertTrue(
    calls.some((c) => c.startsWith('fill:XUQIAN@')),
    '应绘制文字',
  )
  assertTrue(
    calls.some((c) => c === `alpha:${style.opacity}`),
    '应设置低透明度',
  )
  assertTrue(style.text === 'XUQIAN', '返回实际使用的样式')
})
/** 一个够用的假 Canvas 上下文：记录所有绘制调用。 */
function fakeCtx() {
  const calls = []
  const record =
    (name) =>
    (...args) =>
      calls.push({ name, args })
  return {
    calls,
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    rotate: record('rotate'),
    measureText: (text) => {
      calls.push({ name: 'measureText', args: [text] })
      return { width: text.length * 8 }
    },
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    set font(v) {
      calls.push({ name: 'font', args: [v] })
    },
    get font() {
      return ''
    },
    set globalAlpha(v) {
      calls.push({ name: 'globalAlpha', args: [v] })
    },
    get globalAlpha() {
      return 1
    },
    set textBaseline(v) {
      calls.push({ name: 'textBaseline', args: [v] })
    },
    get textBaseline() {
      return ''
    },
    set textAlign(v) {
      calls.push({ name: 'textAlign', args: [v] })
    },
    get textAlign() {
      return ''
    },
    set fillStyle(v) {
      calls.push({ name: 'fillStyle', args: [v] })
    },
    get fillStyle() {
      return ''
    },
    set strokeStyle(v) {
      calls.push({ name: 'strokeStyle', args: [v] })
    },
    get strokeStyle() {
      return ''
    },
    set lineWidth(v) {
      calls.push({ name: 'lineWidth', args: [v] })
    },
    get lineWidth() {
      return 1
    },
  }
}

// ------------------------------------------------ 全图平铺水印（用户新增需求）

await runner.test('平铺：字号与透明度仍落在 SPEC 区间（不因为是新模式就破例）', () => {
  for (const width of [200, 640, 1254, 1920, 4000]) {
    const style = computeTileWatermarkStyle({ width, height: Math.round(width * 0.75) }, { text: '许七安密匣' })
    const ratio = style.fontSize / width
    const okRatio = ratio >= 0.01 && ratio <= 0.02
    const okOpacity = style.opacity >= 0.15 && style.opacity <= 0.3
    assertTrue(okRatio && okOpacity, `${width}px：占比 ${ratio.toFixed(4)} 透明度 ${style.opacity}`)
  }
})

await runner.test('平铺：默认 -30°，且角度被夹在 [-45, 45]', () => {
  const image = { width: 800, height: 600 }
  assertEqual(computeTileWatermarkStyle(image, { text: 'x' }).angle, -30, '默认角度')
  assertEqual(computeTileWatermarkStyle(image, { text: 'x', angle: -80 }).angle, -45, '越界下界被夹')
  assertEqual(computeTileWatermarkStyle(image, { text: 'x', angle: 90 }).angle, 45, '越界上界被夹')
})

await runner.test('平铺：条数足以铺满（外接圆范围内的网格）', () => {
  const image = { width: 1254, height: 807 }
  const style = computeTileWatermarkStyle(image, { text: 'x' })
  const counts = tileCounts(style)
  assertTrue(counts.total > 100, `条数应足够多，实际 ${counts.total}`)
  // 外接圆直径要 ≥ 对角线（旋转后四角不留空白）
  const diagonal = Math.hypot(image.width, image.height)
  assertTrue(counts.reach * 2 >= diagonal, '覆盖半径应不小于对角线')
  // 网格步长必须小于覆盖范围，否则只有一条
  assertTrue(counts.cols >= 2 && counts.rows >= 2, `网格 ${counts.cols}×${counts.rows}`)
})

await runner.test('平铺：绘制会旋转坐标系，并画出 条数×2 次（填充 + 描边）', () => {
  const ctx = fakeCtx()
  const style = drawTiledWatermark(ctx, { width: 600, height: 400 }, { text: 'XUQIAN' })
  const rotates = ctx.calls.filter((c) => c.name === 'rotate')
  const fills = ctx.calls.filter((c) => c.name === 'fillText')
  const counts = tileCounts(style)
  assertEqual(rotates.length, 1, '应旋转一次坐标系')
  assertTrue(Math.abs(rotates[0].args[0] - (-30 * Math.PI) / 180) < 1e-9, '旋转角应为 -30°')
  assertEqual(fills.length, counts.total, `填充次数应等于条数 ${counts.total}`)
  assertTrue(
    ctx.calls.some((c) => c.name === 'translate'),
    '应先平移到中心',
  )
  assertTrue(
    ctx.calls[0].name === 'save' && ctx.calls[ctx.calls.length - 1].name === 'restore',
    'save/restore 必须成对',
  )
})

await runner.test('平铺：绘制坐标铺满旋转后的外接圆（不是只在角落）', () => {
  const ctx = fakeCtx()
  const image = { width: 600, height: 400 }
  drawTiledWatermark(ctx, image, { text: 'XUQIAN' })
  const points = ctx.calls.filter((c) => c.name === 'fillText').map((c) => ({ x: c.args[1], y: c.args[2] }))
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  // 坐标系已平移到中心，所以坐标应跨过正负两侧，且范围超出图片宽高的一半
  assertTrue(Math.min(...xs) < -image.width / 2, '向左应超出图片半宽')
  assertTrue(Math.max(...xs) > image.width / 2, '向右应超出图片半宽')
  assertTrue(Math.min(...ys) < -image.height / 2, '向上应超出图片半高')
  assertTrue(Math.max(...ys) > image.height / 2, '向下应超出图片半高')
})

await runner.test('平铺：奇数行横向错开半个间距（传统水印的参差感）', () => {
  const ctx = fakeCtx()
  const style = drawTiledWatermark(ctx, { width: 400, height: 400 }, { text: 'X' })
  const points = ctx.calls.filter((c) => c.name === 'fillText').map((c) => ({ x: c.args[1], y: c.args[2] }))
  const row0 = points.filter((p) => Math.abs(p.y - points[0].y) < 1e-6).map((p) => p.x)
  const row1Y = points.find((p) => Math.abs(p.y - (points[0].y + style.spacingY)) < 1e-6)?.y
  const row1 = points.filter((p) => row1Y !== undefined && Math.abs(p.y - row1Y) < 1e-6).map((p) => p.x)
  assertTrue(row0.length > 1 && row1.length > 1, '至少两行，每行多条')
  const shift = row1[0] - row0[0]
  assertTrue(Math.abs(shift - style.spacingX / 2) < 1e-6, `奇数行应右移半个间距，实际 ${shift}`)
})

await runner.test('mode 分派：corner 走原逻辑、tile 走平铺，两者互不影响', () => {
  const image = { width: 500, height: 400 }
  const cornerCtx = fakeCtx()
  const cornerStyle = drawVisibleWatermark(cornerCtx, image, { text: 'XUQIAN', position: 'bottom-right' })
  assertEqual(cornerStyle.mode, undefined, 'corner 样式不带 tile 的 mode 标记')
  assertTrue(!cornerCtx.calls.some((c) => c.name === 'rotate'), 'corner 不旋转')
  assertEqual(cornerCtx.calls.filter((c) => c.name === 'fillText').length, 1, 'corner 只画一条')

  const tileCtx = fakeCtx()
  const tileStyle = drawVisibleWatermark(tileCtx, image, { mode: 'tile', text: 'XUQIAN' })
  assertEqual(tileStyle.mode, 'tile', 'tile 样式带 mode 标记')
  assertTrue(tileCtx.calls.filter((c) => c.name === 'fillText').length > 10, 'tile 画很多条')
  assertTrue(VISIBLE_MODES.includes('tile') && VISIBLE_MODES.includes('corner'), '两种模式都在清单里')
})

await runner.test('平铺：空文字不画任何东西（不留下半张水印）', () => {
  const ctx = fakeCtx()
  const style = drawTiledWatermark(ctx, { width: 300, height: 200 }, { text: '' })
  assertEqual(ctx.calls.filter((c) => c.name === 'fillText').length, 0, '不应有填充')
  assertEqual(ctx.calls.filter((c) => c.name === 'save').length, 0, '也不该 save')
  assertEqual(style.text, '', '返回样式')
})

runner.finish()
