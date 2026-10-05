/**
 * 加密声明（明文前导区）专项测试。
 *
 * 新格式：文件 = [明文声明前导区] ‖ [加密容器]。
 * 声明是**明文**（不需密钥可读），其长度与 SHA-256 记在加密头部 → 删改声明会导致解密失败。
 *
 * 同时覆盖旧格式（声明曾前置在加密内容里）的兼容剥离。
 */
import { describe, expect, it } from 'vitest'
import {
  BANNER_MAX_BYTES,
  DEFAULT_BANNER_EN,
  DEFAULT_BANNER_ZH,
  PREAMBLE_HEADER_LEN,
  PREAMBLE_MARKER,
  bannerSkippingSink,
  buildPreamble,
  defaultBanner,
  normalizeBannerText,
  noticeExpectation,
  noticeHash,
  readPreamble,
  skippingSource,
  stripBanner,
} from './banner.ts'
import { bufferSource, collectingSink, decryptStream, encryptStream } from './stream.ts'
import { encryptContainer } from './container.ts'
import { MasterKey } from './keys.ts'
import { concatBytes } from './encoding.ts'

const te = new TextEncoder()

describe('加密声明（明文前导区）', () => {
  it('默认声明：中英各一份且非空', () => {
    expect(DEFAULT_BANNER_ZH.length).toBeGreaterThan(20)
    expect(DEFAULT_BANNER_EN.length).toBeGreaterThan(20)
    expect(defaultBanner('zh')).toBe(DEFAULT_BANNER_ZH)
    expect(defaultBanner('en')).toBe(DEFAULT_BANNER_EN)
  })

  it('留空 / 纯空白 → 回退默认声明（"不写声明"不是可选项）', () => {
    expect(normalizeBannerText('', DEFAULT_BANNER_ZH).text).toBe(DEFAULT_BANNER_ZH)
    expect(normalizeBannerText('   \n\t ', DEFAULT_BANNER_ZH).text).toBe(DEFAULT_BANNER_ZH)
    expect(normalizeBannerText(undefined, DEFAULT_BANNER_EN).text).toBe(DEFAULT_BANNER_EN)
  })

  it('超长声明抛错而不是静默截断', () => {
    expect(() => normalizeBannerText('x'.repeat(BANNER_MAX_BYTES + 1), DEFAULT_BANNER_ZH)).toThrow('BANNER_TOO_LONG')
    expect(() => normalizeBannerText('x'.repeat(BANNER_MAX_BYTES), DEFAULT_BANNER_ZH)).not.toThrow()
  })

  it('前导区往返：魔数 + 标记 + 长度 + 正文', () => {
    const text = '本件由 XUQIAN 测试加密\n任何改动都会导致解密失败'
    const bytes = te.encode(text)
    const preamble = buildPreamble(bytes)

    expect(new TextDecoder().decode(preamble.subarray(0, 6))).toBe('XUQIAN')
    expect(preamble[6]).toBe(PREAMBLE_MARKER)
    expect(new DataView(preamble.buffer).getUint32(7)).toBe(bytes.length)
    expect(preamble.length).toBe(PREAMBLE_HEADER_LEN + bytes.length)

    const parsed = readPreamble(concatBytes(preamble, te.encode('假装这是容器')))
    expect(parsed).not.toBeNull()
    expect(parsed?.noticeText).toBe(text)
    expect(parsed?.containerOffset).toBe(PREAMBLE_HEADER_LEN + bytes.length)
  })

  it('没有前导区的旧格式文件：readPreamble 返回 null（不误判）', () => {
    const legacy = new Uint8Array(64)
    legacy.set(te.encode('XUQIAN'), 0)
    legacy[6] = 1
    expect(readPreamble(legacy)).toBeNull()
    expect(readPreamble(new Uint8Array(0))).toBeNull()
    expect(readPreamble(te.encode('not a xuqian file at all'))).toBeNull()
  })

  it('前导区被截断 → 明确报 BANNER_TRUNCATED', () => {
    const preamble = buildPreamble(te.encode('声明内容'))
    const cut = preamble.subarray(0, preamble.length - 3)
    expect(() => readPreamble(cut)).toThrow('BANNER_TRUNCATED')
  })

  it('声明哈希稳定且随内容变化', () => {
    const a = noticeHash(te.encode('同样内容'))
    expect(noticeHash(te.encode('同样内容'))).toBe(a)
    expect(noticeHash(te.encode('不同内容'))).not.toBe(a)
    expect(a).toMatch(/^[0-9A-F]{64}$/)
  })

  it('noticeExpectation 只在头部含 nh 时返回期望值', () => {
    expect(noticeExpectation({ nh: 'AB'.repeat(32), nl: 10 })).toEqual({ length: 10, hash: 'AB'.repeat(32) })
    expect(noticeExpectation({ nl: 10 })).toBeNull()
    expect(noticeExpectation({})).toBeNull()
  })

  it('skippingSource 跨分块跳过开头字节；skip=0 原样透传', async () => {
    const data = new Uint8Array(50)
    for (let i = 0; i < data.length; i++) data[i] = i

    for (const skip of [0, 1, 7, 11, 49, 50]) {
      for (const chunkSize of [1, 4, 13, 100]) {
        const pieces: Uint8Array[] = []
        for (let off = 0; off < data.length; off += chunkSize) {
          pieces.push(data.subarray(off, Math.min(off + chunkSize, data.length)))
        }
        const out: number[] = []
        for await (const chunk of skippingSource(bufferSource(pieces), skip)) out.push(...chunk)
        expect(out, `skip=${skip} chunk=${chunkSize}`).toEqual([...data.subarray(Math.min(skip, data.length))])
      }
    }
  })

  it('端到端（新顺序）：先加密内容 → 再前置明文声明 → 解密时先校验并跳过前导区', async () => {
    const original = new Uint8Array(3000)
    for (let i = 0; i < original.length; i++) original[i] = (i * 13) & 0xff
    const notice = normalizeBannerText('明文声明：本文件由测试生成\n改动声明也会导致解密失败', DEFAULT_BANNER_ZH)
    const key = MasterKey.generate()

    // ① 只加密「内容」，声明不进加密负载
    const enc = collectingSink()
    await encryptStream(bufferSource([original]), enc.sink, key, {
      layers: ['AES-256-GCM', 'SM4-GCM'],
      plaintextLength: original.length,
      chunkSize: 1024,
      meta: { nl: notice.bytes.length, nh: noticeHash(notice.bytes), n: 'demo.bin' },
    })
    // ② 再把明文声明拼到文件最前面
    const file = concatBytes(buildPreamble(notice.bytes), concatBytes(...enc.parts))

    // ③ 解密前先读前导区（不需要密钥）
    const preamble = readPreamble(file)
    expect(preamble?.noticeText).toBe(notice.text)

    // ④ 从容器偏移处解密
    const dec = collectingSink()
    const result = await decryptStream(bufferSource([file.subarray(preamble!.containerOffset)]), dec.sink, key)
    expect(result.header.meta.nh).toBe(noticeHash(notice.bytes))
    expect(Array.from(concatBytes(...dec.parts))).toEqual(Array.from(original))
  })

  it('明文声明被改写 → 哈希不符（解密前即可判定）', () => {
    const notice = normalizeBannerText('原始声明文本', DEFAULT_BANNER_ZH)
    const tampered = normalizeBannerText('伪造的声明文本', DEFAULT_BANNER_ZH)
    const expected = noticeExpectation({ nh: noticeHash(notice.bytes), nl: notice.bytes.length })
    expect(expected).not.toBeNull()
    expect(noticeHash(tampered.bytes)).not.toBe(expected!.hash)
  })

  it('明文声明被删掉 → 头部有 nh 但读不到前导区（可判定"声明区被移除"）', () => {
    const notice = normalizeBannerText('声明', DEFAULT_BANNER_ZH)
    const meta = { nh: noticeHash(notice.bytes), nl: notice.bytes.length }
    const containerOnly = new Uint8Array(64)
    containerOnly.set(te.encode('XUQIAN'), 0)
    containerOnly[6] = 1
    expect(readPreamble(containerOnly)).toBeNull()
    // 头部仍声称应有声明 → 调用方据此报 NOTICE_MISSING
    expect(noticeExpectation(meta)).not.toBeNull()
  })

  it('旧格式兼容：加密内容内部前置的声明仍可被剥离', () => {
    const banner = normalizeBannerText('旧格式声明', DEFAULT_BANNER_ZH)
    const content = te.encode('real content')
    const payload = concatBytes(banner.bytes, content)
    const stripped = stripBanner(payload, { nl: banner.bytes.length, no: banner.text })
    expect(stripped.bannerBytes).toBe(banner.bytes.length)
    expect(new TextDecoder().decode(stripped.content)).toBe('real content')
    expect(stripBanner(payload, {}).bannerBytes).toBe(0)
  })

  it('旧格式流式剥离 bannerSkippingSink 跨分块正确', async () => {
    const payload = new Uint8Array(30)
    for (let i = 0; i < payload.length; i++) payload[i] = i
    for (const skip of [0, 3, 29, 30]) {
      const collecting = collectingSink()
      const sink = bannerSkippingSink(collecting.sink, skip)
      await sink.write(payload.subarray(0, 2))
      await sink.write(payload.subarray(2, 17))
      await sink.write(payload.subarray(17))
      expect(Array.from(concatBytes(...collecting.parts))).toEqual([...payload.subarray(Math.min(skip, 30))])
    }
  })

  it('**多层**加密时明文声明仍在文件最前面（层数不影响前导区）', async () => {
    // 网页端 Worker 的加密就是这两步：encryptContainer 产容器 → buildPreamble 前置明文声明。
    // 逐层数验证：无论 1 层、3 层还是 10 层，文件开头都必须是可读的明文声明。
    const notice = normalizeBannerText('多层加密测试声明\n层数不应影响文件开头的明文', DEFAULT_BANNER_ZH)
    const content = te.encode('payload')
    const layerSets: string[][] = [
      ['AES-128-GCM'],
      ['AES-256-GCM', 'CHACHA20-POLY1305', 'SM4-GCM'],
      Array.from({ length: 10 }, () => 'AES-128-GCM'),
    ]
    for (const layers of layerSets) {
      const key = MasterKey.generate()
      const result = await encryptContainer(content, key, {
        layers: layers as never,
        meta: { nl: notice.bytes.length, nh: noticeHash(notice.bytes), n: 'multi.bin' },
      })
      const file = concatBytes(buildPreamble(notice.bytes), concatBytes(...result.pieces))

      const parsed = readPreamble(file)
      expect(parsed, `${layers.length} 层`).not.toBeNull()
      expect(parsed?.noticeText).toBe(notice.text)
      expect(new TextDecoder().decode(file.subarray(0, 6))).toBe('XUQIAN')
      expect(file[6]).toBe(PREAMBLE_MARKER)
      expect(parsed?.containerOffset).toBe(PREAMBLE_HEADER_LEN + notice.bytes.length)

      // 交叉验证：从容器偏移处解密，字节一致
      const dec = collectingSink()
      const out = await decryptStream(bufferSource([file.subarray(parsed!.containerOffset)]), dec.sink, key)
      expect(Array.from(concatBytes(...dec.parts)), `${layers.length} 层`).toEqual(Array.from(content))
      expect(out.header.layers.length).toBe(layers.length)
      key.destroy()
    }
  })
})
