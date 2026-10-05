import { describe, expect, it } from 'vitest'
import { combineShares, decodeShare, encodeShare, splitSecret } from './shamir.ts'
import { randomBytes } from './keys.ts'
import { bytesToHex } from './encoding.ts'

const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 3)

describe('Shamir 密钥分片（GF(256)）', () => {
  it('任意 M 份都能恢复，任意 M−1 份不能恢复', () => {
    const m = 3
    const n = 5
    const shares = splitSecret(SECRET, m, n, (len) => randomBytes(len))
    expect(shares).toHaveLength(n)

    // 所有 C(5,3) 组合都能恢复
    const combos: number[][] = []
    const choose = (start: number, picked: number[]) => {
      if (picked.length === m) {
        combos.push([...picked])
        return
      }
      for (let i = start; i < n; i++) choose(i + 1, [...picked, i])
    }
    choose(0, [])
    expect(combos).toHaveLength(10)
    for (const combo of combos) {
      const restored = combineShares(combo.map((index) => shares[index]))
      expect(bytesToHex(restored)).toBe(bytesToHex(SECRET))
    }

    // 少于 M 份得到错误结果（信息论上不可能恢复）
    const partial = combineShares([shares[0], shares[1]])
    expect(bytesToHex(partial)).not.toBe(bytesToHex(SECRET))
  })

  it('分片文本可编解码往返', () => {
    const shares = splitSecret(SECRET, 2, 4, (len) => randomBytes(len))
    for (const [index, share] of shares.entries()) {
      const text = encodeShare(share, 4, 2)
      expect(text.startsWith('XUQIAN-SHARE-')).toBe(true)
      const decoded = decodeShare(text)
      expect(decoded.share.x).toBe(index + 1)
      expect(decoded.total).toBe(4)
      expect(decoded.threshold).toBe(2)
      expect(bytesToHex(decoded.share.y)).toBe(bytesToHex(share.y))
    }
    const restored = combineShares(shares.slice(1, 3).map((share) => decodeShare(encodeShare(share, 4, 2)).share))
    expect(bytesToHex(restored)).toBe(bytesToHex(SECRET))
  })

  it('非法参数与重复分片被拒绝', () => {
    expect(() => splitSecret(SECRET, 1, 3, (len) => randomBytes(len))).toThrow('SHAMIR_BAD_PARAMS')
    expect(() => splitSecret(SECRET, 4, 3, (len) => randomBytes(len))).toThrow('SHAMIR_BAD_PARAMS')
    expect(() => splitSecret(SECRET, 2, 300, (len) => randomBytes(len))).toThrow('SHAMIR_BAD_PARAMS')
    const shares = splitSecret(SECRET, 2, 3, (len) => randomBytes(len))
    expect(() => combineShares([shares[0], shares[0]])).toThrow('SHAMIR_DUPLICATE_SHARE')
    expect(() => combineShares([])).toThrow('SHAMIR_NO_SHARES')
    expect(() => decodeShare('XUQIAN-SHARE-bad')).toThrow('SHAMIR_BAD_FORMAT')
  })

  it('分片不包含明文的直接片段（每份都是随机多项式取值）', () => {
    const shares = splitSecret(SECRET, 2, 2, (len) => randomBytes(len))
    // 门限 2 时：y1 = s + r, y2 = s + 2r（GF 乘法），二者都不等于 s
    expect(bytesToHex(shares[0].y)).not.toBe(bytesToHex(SECRET))
    expect(bytesToHex(shares[1].y)).not.toBe(bytesToHex(SECRET))
  })
})
