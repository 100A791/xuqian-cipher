import { describe, expect, it } from 'vitest'
import {
  decryptContainer,
  describeHeader,
  encryptContainer,
  parseHeader,
  HEADER_FLAG_ENC_META,
  HEADER_FLAG_TS_SALT,
} from './container.ts'
import { MasterKey } from './keys.ts'
import { bytesToHex, concatBytes } from './encoding.ts'

const te = new TextEncoder()

/** 只解出「文件头」那一段明文文本（不含密文体）。 */
function headerText(file: Uint8Array): string {
  const { headerLength } = parseHeader(file)
  return new TextDecoder().decode(file.subarray(0, headerLength))
}

describe('元数据加密（隐藏原文件名 / MIME / 备注）', () => {
  it('开启后，标识性字段不出现在明文文件头里', async () => {
    const mk = MasterKey.generate()
    const enc = await encryptContainer(te.encode('tax data'), mk, {
      layers: ['AES-128-GCM'],
      encryptMeta: true,
      meta: { n: '2026年度个税申报-张三.xlsx', m: 'application/vnd.ms-excel', c: '机密备注' },
    })
    const file = concatBytes(...enc.pieces)
    const head = headerText(file)
    expect(head).not.toContain('个税')
    expect(head).not.toContain('张三')
    expect(head).not.toContain('机密备注')
    // 解密必需的结构字段仍在明文（分块布局依赖 s）
    expect(typeof parseHeader(file).header.meta.s).toBe('number')
    // 标志位标记了「元数据已加密」
    expect(enc.header.flags & HEADER_FLAG_ENC_META).toBe(HEADER_FLAG_ENC_META)
  })

  it('解密后原文件名 / MIME / 备注 / 原始大小被完整还原', async () => {
    const mk = MasterKey.generate()
    const enc = await encryptContainer(te.encode('x'), mk, {
      layers: ['AES-256-GCM', 'SM4-GCM'],
      encryptMeta: true,
      meta: { n: 'report.pdf', m: 'application/pdf', c: 'note', os: 999 },
    })
    const dec = await decryptContainer(concatBytes(...enc.pieces), mk)
    expect(dec.header.meta.n).toBe('report.pdf')
    expect(dec.header.meta.m).toBe('application/pdf')
    expect(dec.header.meta.c).toBe('note')
    expect(dec.header.meta.os).toBe(999)
    expect(bytesToHex(dec.plaintext)).toBe(bytesToHex(te.encode('x')))
  })

  it('没有密钥时，describeHeader 不泄露原文件名，只提示"元数据已加密"', async () => {
    const mk = MasterKey.generate()
    const enc = await encryptContainer(te.encode('y'), mk, {
      layers: ['AES-128-GCM'],
      encryptMeta: true,
      meta: { n: 'secret.docx' },
    })
    const { header } = parseHeader(concatBytes(...enc.pieces))
    const rows = describeHeader(header)
    expect(rows.find((r) => r.key === 'metaEncrypted')?.value).toContain('是')
    expect(rows.find((r) => r.key === 'originalName')).toBeUndefined()
  })

  it('错误密钥时元数据同样解不开，统一报 AUTH_FAILED（不留 oracle）', async () => {
    const mk = MasterKey.generate()
    const enc = await encryptContainer(te.encode('z'), mk, {
      layers: ['AES-128-GCM'],
      encryptMeta: true,
      meta: { n: 'secret.bin' },
    })
    await expect(decryptContainer(concatBytes(...enc.pieces), MasterKey.generate())).rejects.toThrow('AUTH_FAILED')
  })

  it('篡改加密元数据密文会被检出', async () => {
    const mk = MasterKey.generate()
    const enc = await encryptContainer(te.encode('payload for tamper'), mk, {
      layers: ['AES-128-GCM'],
      encryptMeta: true,
      meta: { n: 'a.bin' },
    })
    const file = concatBytes(...enc.pieces)
    const head = headerText(file)
    const at = head.indexOf('"x"')
    expect(at).toBeGreaterThan(0)
    const tampered = file.slice()
    // 改动 x 的密文首字节（在 key 之后）；无论被 CRC 还是 AAD 拦下，都必须失败
    tampered[at + 8] ^= 0x01
    await expect(decryptContainer(tampered, mk)).rejects.toThrow(/HEADER_CRC_MISMATCH|AUTH_FAILED/)
  })

  it('关闭时保持旧行为：明文元数据、无 enc-meta 标志', async () => {
    const mk = MasterKey.generate()
    const enc = await encryptContainer(te.encode('w'), mk, {
      layers: ['AES-128-GCM'],
      encryptMeta: false,
      meta: { n: 'plain.txt' },
    })
    const file = concatBytes(...enc.pieces)
    expect(headerText(file)).toContain('plain.txt')
    expect(enc.header.flags & HEADER_FLAG_ENC_META).toBe(0)
    expect((await decryptContainer(file, mk)).header.meta.n).toBe('plain.txt')
  })

  it('元数据密钥与分块子密钥做了域分离（同 salt 也不同）', async () => {
    const mk = MasterKey.generate()
    const salt = new Uint8Array(16).fill(3)
    expect(bytesToHex(mk.deriveMetaKey(salt))).not.toBe(bytesToHex(mk.deriveSubkey('AES-256-GCM', 0, salt)))
    expect(bytesToHex(mk.deriveMetaNonce(salt))).toHaveLength(24) // 12 字节 → 24 hex
  })
})

describe('时间戳附加盐（域分离，不提升安全性）', () => {
  it('开启后往返一致，且头部置了 ts-salt 标志', async () => {
    const mk = MasterKey.generate()
    const data = te.encode('timestamp salt payload')
    const enc = await encryptContainer(data, mk, {
      layers: ['AES-128-GCM'],
      timestampSalt: true,
      meta: { t: 1700000000000 },
    })
    expect(enc.header.flags & HEADER_FLAG_TS_SALT).toBe(HEADER_FLAG_TS_SALT)
    const dec = await decryptContainer(concatBytes(...enc.pieces), mk)
    expect(bytesToHex(dec.plaintext)).toBe(bytesToHex(data))
  })

  it('未开启时无标志、往返一致（保持旧文件派生不变）', async () => {
    const mk = MasterKey.generate()
    const data = te.encode('no salt')
    const enc = await encryptContainer(data, mk, { layers: ['AES-128-GCM'] })
    expect(enc.header.flags & HEADER_FLAG_TS_SALT).toBe(0)
    const dec = await decryptContainer(concatBytes(...enc.pieces), mk)
    expect(bytesToHex(dec.plaintext)).toBe(bytesToHex(data))
  })

  it('上下文只改变派生结果，不引入也不替代随机性', () => {
    const mk = MasterKey.generate()
    const salt = new Uint8Array(16).fill(7)
    const plain = mk.deriveSubkey('AES-256-GCM', 0, salt)
    const salted = mk.deriveSubkey('AES-256-GCM', 0, salt, '|ts:1700000000000')
    expect(bytesToHex(plain)).not.toBe(bytesToHex(salted))
    // 相同上下文可复现 → 解密端能还原
    expect(bytesToHex(mk.deriveSubkey('AES-256-GCM', 0, salt, '|ts:1700000000000'))).toBe(bytesToHex(salted))
  })
})
