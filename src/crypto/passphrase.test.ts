import { describe, expect, it } from 'vitest'
import { estimatePassphrase, passphraseScore } from './passphrase.ts'

describe('口令强度估算', () => {
  it('常见弱口令被判为弱并给出 common 警告', () => {
    for (const pw of ['password', 'qwerty', '123456', 'admin', 'password123', 'woaini1314']) {
      const est = estimatePassphrase(pw)
      expect(est.level, pw).toBe('weak')
      expect(est.warnings).toContain('common')
    }
  })

  it('重复字符 / 连续序列被惩罚', () => {
    expect(estimatePassphrase('aaaaaaaaaaaaaa')).toMatchObject({ level: 'weak' })
    expect(estimatePassphrase('aaaaaaaaaaaaaa').warnings).toContain('repeated')
    expect(estimatePassphrase('abcdefghijkl').warnings).toContain('sequence')
    expect(estimatePassphrase('qwertyuiopas').warnings).toContain('sequence')
  })

  it('长度不足 12 位被标记', () => {
    expect(estimatePassphrase('aB3$xY9!').warnings).toContain('short')
    expect(estimatePassphrase('Ab1!Cd2@Ef3#Gh4$').warnings).not.toContain('short')
  })

  it('高熵长口令判为强/很强，且无警告', () => {
    const est = estimatePassphrase('correct horse battery staple 42xQ')
    expect(['strong', 'very-strong']).toContain(est.level)
    expect(est.warnings).toHaveLength(0)
    expect(est.bits).toBeGreaterThanOrEqual(60)
  })

  it('强度随熵单调增强', () => {
    const weak = estimatePassphrase('abc123')
    const mid = estimatePassphrase('x7k2m9p4q1w8')
    const strong = estimatePassphrase('aB3$xY9!kL2#mN8@cV5^')
    expect(weak.bits).toBeLessThan(mid.bits)
    expect(mid.bits).toBeLessThan(strong.bits)
  })

  it('空口令是弱、0 bit', () => {
    expect(estimatePassphrase('')).toEqual({ bits: 0, level: 'weak', warnings: ['short'] })
  })

  it('展示分被夹在 2..100', () => {
    expect(passphraseScore(estimatePassphrase('a'))).toBeGreaterThanOrEqual(2)
    expect(passphraseScore(estimatePassphrase('x'.repeat(80)))).toBeLessThanOrEqual(100)
  })
})
