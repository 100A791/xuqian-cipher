import { describe, expect, it } from 'vitest'
import { describeHeader, decryptContainer, encryptContainer, hasMagic, parseHeader, EXT_ENCRYPTED, encryptedFileName, originalFileName, HEADER_FIXED_LEN, HEADER_LEN_OFFSET } from './container.ts'
import { MasterKey } from './keys.ts'
import { bytesToBase64, hexToBytes, bytesToHex, concatBytes } from './encoding.ts'
import type { AlgoId } from './aead.ts'

const te = new TextEncoder()

async function roundTrip(plaintext: Uint8Array, layers: AlgoId[], key?: MasterKey) {
  const mk = key ?? MasterKey.generate()
  const enc = await encryptContainer(plaintext, mk, { layers, meta: { n: 'a.bin', m: 'application/octet-stream', t: 1700000000000 } })
  const file = concatBytes(...enc.pieces)
  const dec = await decryptContainer(file, mk)
  return { mk, enc, file, dec }
}

describe('XUQIAN 容器格式', () => {
  it('单层 AES-128-GCM 往返一致', async () => {
    const data = te.encode('许七安密匣 · hello world')
    const { dec } = await roundTrip(data, ['AES-128-GCM'])
    expect(bytesToHex(dec.plaintext)).toBe(bytesToHex(data))
  })

  it('文件以 XUQIAN 魔数开头，且头部不含密钥', async () => {
    const mk = MasterKey.generate()
    const keyHex = bytesToHex(mk.clone())
    const data = te.encode('secret payload')
    const enc = await encryptContainer(data, mk, { layers: ['AES-128-GCM', 'CHACHA20-POLY1305'] })
    const file = concatBytes(...enc.pieces)
    expect(hasMagic(file)).toBe(true)
    const text = new TextDecoder().decode(file.subarray(0, 600))
    expect(text).not.toContain(keyHex)
    expect(text).not.toContain(keyHex.toUpperCase())
    expect(text.startsWith('XUQIAN')).toBe(true)
  })

  it('多层（AES-128 → ChaCha20 → SM4）逆序解密成功', async () => {
    const data = new Uint8Array(200_000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff
    const { dec, enc } = await roundTrip(data, ['AES-128-GCM', 'CHACHA20-POLY1305', 'SM4-GCM'])
    expect(enc.header.lc).toBe(3)
    expect(bytesToHex(dec.plaintext)).toBe(bytesToHex(data))
  })

  it('支持全部 5 种算法各自单层往返', async () => {
    const algos: AlgoId[] = ['AES-128-GCM', 'AES-256-GCM', 'CHACHA20-POLY1305', 'XCHACHA20-POLY1305', 'SM4-GCM']
    for (const algo of algos) {
      const data = te.encode(`payload for ${algo}`)
      const { dec } = await roundTrip(data, [algo])
      expect(bytesToHex(dec.plaintext), algo).toBe(bytesToHex(data))
    }
  })

  it('10 层加密可用，11 层被拒绝', async () => {
    const data = te.encode('deep')
    const ten: AlgoId[] = Array.from({ length: 10 }, () => 'AES-128-GCM')
    const { dec } = await roundTrip(data, ten)
    expect(dec.plaintext.length).toBe(data.length)
    await expect(roundTrip(data, Array.from({ length: 11 }, () => 'AES-128-GCM'))).rejects.toThrow(/LAYER_COUNT/)
  })

  it('错误密钥无法解密，且错误信息统一为 AUTH_FAILED', async () => {
    const data = te.encode('only the right key works')
    const mk = MasterKey.generate()
    const wrong = MasterKey.generate()
    const enc = await encryptContainer(data, mk, { layers: ['AES-128-GCM', 'SM4-GCM'] })
    const file = concatBytes(...enc.pieces)
    await expect(decryptContainer(file, wrong)).rejects.toThrow('AUTH_FAILED')
    const ok = await decryptContainer(file, mk)
    expect(bytesToHex(ok.plaintext)).toBe(bytesToHex(data))
  })

  it('篡改密文/头部/元数据都会被检测到', async () => {
    const data = te.encode('tamper me please, this is a longer payload')
    const mk = MasterKey.generate()
    const enc = await encryptContainer(data, mk, { layers: ['AES-128-GCM'], meta: { n: 'x.txt' } })
    const file = concatBytes(...enc.pieces)

    const flipLast = file.slice()
    flipLast[flipLast.length - 1] ^= 0x01
    await expect(decryptContainer(flipLast, mk)).rejects.toThrow('AUTH_FAILED')

    const flipBody = file.slice()
    flipBody[file.length - 40] ^= 0x80
    await expect(decryptContainer(flipBody, mk)).rejects.toThrow('AUTH_FAILED')

    // 头部元数据被改：CRC 先报错
    const tamperMeta = file.slice()
    const at = new TextDecoder().decode(tamperMeta.subarray(0, 400)).indexOf('x.txt')
    expect(at).toBeGreaterThan(0)
    tamperMeta[at] = 'y'.charCodeAt(0)
    await expect(decryptContainer(tamperMeta, mk)).rejects.toThrow(/HEADER_CRC_MISMATCH|AUTH_FAILED/)
  })

  it('空文件也被认证（tag 存在）', async () => {
    const empty = new Uint8Array(0)
    const { dec, file } = await roundTrip(empty, ['AES-128-GCM', 'SM4-GCM'])
    expect(dec.plaintext.length).toBe(0)
    expect(file.length).toBeGreaterThan(64)
  })

  it('小分块触发多分块路径，且每块 nonce 不同', async () => {
    const data = new Uint8Array(5000)
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff
    const mk = MasterKey.generate()
    const enc = await encryptContainer(data, mk, { layers: ['AES-128-GCM'], chunkSize: 1024 })
    expect(enc.header.cc).toBe(5)
    const file = concatBytes(...enc.pieces)
    const dec = await decryptContainer(file, mk)
    expect(bytesToHex(dec.plaintext)).toBe(bytesToHex(data))

    // 同层不同块 nonce 必须不同
    const nonces = new Set<string>()
    for (let i = 0; i < 5; i++) nonces.add(bytesToHex(mk.deriveNonce('AES-128-GCM', 0, i, new Uint8Array(16).fill(i))))
    expect(nonces.size).toBe(5)
  })

  it('每次加密生成不同主密钥、不同 salt/nonce 种子', async () => {
    const data = te.encode('same input twice')
    const a = await encryptContainer(data, MasterKey.generate(), { layers: ['AES-128-GCM'] })
    const b = await encryptContainer(data, MasterKey.generate(), { layers: ['AES-128-GCM'] })
    expect(bytesToHex(a.pieces[1])).not.toBe(bytesToHex(b.pieces[1]))
    const ka = MasterKey.generate()
    const kb = MasterKey.generate()
    expect(bytesToHex(ka.clone())).not.toBe(bytesToHex(kb.clone()))
    // 128 位 = 16 字节 = 32 个 Hex 字符 / 24 个 Base64 字符
    expect(ka.clone()).toHaveLength(16)
    expect(bytesToHex(ka.clone())).toHaveLength(32)
    expect(bytesToBase64(ka.clone())).toHaveLength(24)
  })

  it('主密钥销毁后再使用会抛错（一次性展示的底层保证）', async () => {
    const mk = MasterKey.generate()
    const data = te.encode('destroy test')
    const enc = await encryptContainer(data, mk, { layers: ['AES-128-GCM'] })
    mk.destroy()
    expect(mk.destroyed).toBe(true)
    await expect(decryptContainer(concatBytes(...enc.pieces), mk)).rejects.toThrow('KEY_DESTROYED')
    expect(() => mk.deriveSubkey('AES-128-GCM', 0, new Uint8Array(16))).toThrow('KEY_DESTROYED')
  })

  it('指纹为 SHA-256 前 8 字节（16 个 hex 字符）且稳定', async () => {
    const mk = MasterKey.fromBytes(hexToBytes('000102030405060708090a0b0c0d0e0f'))
    const fp = await mk.fingerprint()
    expect(fp).toMatch(/^[0-9A-F]{16}$/)
    expect(await mk.fingerprint()).toBe(fp)
  })

  it('文件名规则：加密加后缀，解密还原原名', async () => {
    expect(encryptedFileName('photo.jpg')).toBe('photo.jpg.XUQIAN')
    expect(encryptedFileName('a.txt.XUQIAN')).toBe('a.txt.XUQIAN')
    expect(originalFileName('photo.jpg.XUQIAN')).toBe('photo.jpg')
    const { enc } = await roundTrip(te.encode('n'), ['AES-128-GCM'])
    expect(enc.header.meta.n).toBe('a.bin')
    expect(EXT_ENCRYPTED).toBe('.XUQIAN')
  })

  it('文件头可读：describeHeader 能列出算法与层数', async () => {
    const enc = await encryptContainer(te.encode('meta'), MasterKey.generate(), {
      layers: ['AES-128-GCM', 'XCHACHA20-POLY1305'],
      meta: { n: 'report.pdf', m: 'application/pdf' },
    })
    const file = concatBytes(...enc.pieces)
    const { header } = parseHeader(file)
    const rows = describeHeader(header)
    expect(rows.find((r) => r.key === 'algorithms')?.value).toBe('AES-128-GCM → XCHACHA20-POLY1305')
    expect(rows.find((r) => r.key === 'originalName')?.value).toBe('report.pdf')
    expect(header.meta.h).toMatch(/^[0-9A-F]{64}$/)
  })

  it('解密后哈希与原始一致（验收标准 6）', async () => {
    const data = new Uint8Array(300_000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff
    const { dec, enc } = await roundTrip(data, ['AES-256-GCM', 'CHACHA20-POLY1305'])
    expect(bytesToHex(dec.plaintext)).toBe(bytesToHex(data))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
    expect(enc.header.meta.h).toBe(bytesToHex(digest).toUpperCase())
  })

  it('乱序层会得到不同子密钥（换顺序 = 换密钥流）', async () => {
    const mk = MasterKey.generate()
    const salt = new Uint8Array(16).fill(9)
    const k0 = mk.deriveSubkey('AES-128-GCM', 0, salt)
    const k1 = mk.deriveSubkey('AES-128-GCM', 1, salt)
    expect(bytesToHex(k0)).not.toBe(bytesToHex(k1))
    const kc = mk.deriveSubkey('CHACHA20-POLY1305', 0, salt)
    expect(bytesToHex(k0)).not.toBe(bytesToHex(kc.subarray(0, 16)))
  })

  /**
   * 文件头必须是「人能读」的：用文本编辑器打开 .XUQIAN 时，
   * 紧跟魔数就该看到缩进良好的 JSON，且第一项就是加密声明。
   */
  it('磁盘文件头是人可读排布：缩进 JSON + meta 在最前 + 声明在最前', async () => {
    const payload = te.encode('内容')
    const bannerText = '本件由 XUQIAN 测试加密\n任何改动都会导致解密失败'
    const bannerBytes = te.encode(bannerText)
    const stored = concatBytes(bannerBytes, payload)
    const mk = MasterKey.generate()
    const enc = await encryptContainer(stored, mk, {
      layers: ['AES-128-GCM'],
      meta: { no: bannerText, nl: bannerBytes.length, n: 'demo.bin' },
    })
    const file = concatBytes(...enc.pieces)
    const headerLen = new DataView(file.buffer, file.byteOffset).getUint32(HEADER_LEN_OFFSET)
    const head = new TextDecoder().decode(file.subarray(HEADER_FIXED_LEN + 4, HEADER_FIXED_LEN + 4 + headerLen))

    // 缩进排版（有换行与两空格缩进），而不是一大坨单行
    expect(head).toContain('\n  "meta"')
    // 顶层第一项是 meta
    expect(head.trimStart().startsWith('{')).toBe(true)
    expect(head.indexOf('"meta"')).toBeLessThan(head.indexOf('"v"'))
    // meta 第一项是声明
    expect(head.indexOf('"no"')).toBeLessThan(head.indexOf('"nl"'))
    expect(head.indexOf('"nl"')).toBeLessThan(head.indexOf('"n"'))
    // 声明正文原样可读
    expect(head).toContain('本件由 XUQIAN 测试加密')

    // 关键回归：自身 CRC 必须仍然校验通过（meta 内部键顺序不能变）
    const parsed = parseHeader(file)
    expect(parsed.header.meta.no).toBe(bannerText)
    expect(parsed.header.meta.nl).toBe(bannerBytes.length)
  })
})
