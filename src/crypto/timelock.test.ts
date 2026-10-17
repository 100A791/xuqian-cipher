/**
 * 时间锁专项测试（基于时间戳验证）。
 *
 * 语义：flags 含 0x10（HEADER_FLAG_TIMELOCK）时，解密端在解开 meta 之后、
 * 解开任何密文块之前，用当前时间与 meta.nbf / meta.exp 比较（闭区间 [nbf, exp]）。
 * 验证基于本机时钟（纯前端没有可信时间源），所以这里的"现在"全部用注入的 now，
 * 不让测试依赖真实时钟。
 */
import { describe, expect, it } from 'vitest'
import { HEADER_FLAG_TIMELOCK, encryptContainer } from './container.ts'
import { TimeLockError, decryptStream, keyCheck } from './stream.ts'
import { bufferSource, collectingSink } from './stream.ts'
import { MasterKey } from './keys.ts'
import { concatBytes } from './encoding.ts'

const data = new TextEncoder().encode('TIMELOCK-ROUNDTRIP-时间锁测试')

const T0 = Date.parse('2026-01-01T00:00:00Z')
const HOUR = 3_600_000

async function encryptWithTime(over: { exp?: number; nbf?: number }) {
  const mk = MasterKey.generate()
  const result = await encryptContainer(data, mk, {
    layers: ['AES-256-GCM'],
    meta: { n: 'timelock.txt', t: T0, ...over },
  })
  return { mk, file: concatBytes(...result.pieces), header: result.header }
}

describe('时间锁（基于时间戳验证）', () => {
  it('过期后拒绝解密：抛 TIMELOCK_EXPIRED，且明文一个字节都没有产出', async () => {
    const { mk, file } = await encryptWithTime({ exp: T0 + HOUR })
    const sinkCol = collectingSink()
    await expect(
      decryptStream(bufferSource([file]), sinkCol.sink, mk, undefined, { now: T0 + 2 * HOUR }),
    ).rejects.toBeInstanceOf(TimeLockError)
    await expect(
      decryptStream(bufferSource([file]), sinkCol.sink, mk, undefined, { now: T0 + 2 * HOUR }),
    ).rejects.toMatchObject({ code: 'TIMELOCK_EXPIRED' })
    expect(sinkCol.parts.length).toBe(0)
  })

  it('生效前拒绝解密：抛 TIMELOCK_NOT_YET', async () => {
    const { mk, file } = await encryptWithTime({ nbf: T0 + HOUR })
    const sinkCol = collectingSink()
    await expect(decryptStream(bufferSource([file]), sinkCol.sink, mk, undefined, { now: T0 })).rejects.toMatchObject({
      code: 'TIMELOCK_NOT_YET',
    })
    expect(sinkCol.parts.length).toBe(0)
  })

  it('时间窗 [nbf, exp] 闭区间可用：now=nbf 与 now=exp 都能解', async () => {
    const { mk, file } = await encryptWithTime({ nbf: T0 + HOUR, exp: T0 + 3 * HOUR })
    for (const now of [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]) {
      const sinkCol = collectingSink()
      await decryptStream(bufferSource([file]), sinkCol.sink, mk, undefined, { now })
      expect(sinkCol.parts.length).toBeGreaterThan(0)
    }
  })

  it('没设时间字段就不加时间锁位，任何时刻都能解（旧行为不变）', async () => {
    const { mk, file, header } = await encryptWithTime({})
    expect(header.flags & HEADER_FLAG_TIMELOCK).toBe(0)
    const sinkCol = collectingSink()
    await decryptStream(bufferSource([file]), sinkCol.sink, mk, undefined, { now: T0 + 100 * HOUR })
    expect(sinkCol.parts.length).toBeGreaterThan(0)
  })

  it('默认 now 用真实时钟：nbf 设为过去时刻的文件直接可解', async () => {
    const { mk, file } = await encryptWithTime({ nbf: T0 })
    const sinkCol = collectingSink()
    await decryptStream(bufferSource([file]), sinkCol.sink, mk)
    expect(sinkCol.parts.length).toBeGreaterThan(0)
  })

  it('keyCheck 不抛时间锁异常，而是返回匹配结果与时间窗（自检用于提前告知）', async () => {
    const { mk, file } = await encryptWithTime({ nbf: T0 + HOUR, exp: T0 + 3 * HOUR })
    const early = await keyCheck(mk, bufferSource([file]), { now: T0 })
    expect(early.matched).toBe(true)
    expect(early.timelock).toEqual({ enforced: true, exp: T0 + 3 * HOUR, nbf: T0 + HOUR })

    const inside = await keyCheck(mk, bufferSource([file]), { now: T0 + 2 * HOUR })
    expect(inside.matched).toBe(true)
    expect(inside.timelock).toEqual({ enforced: true, exp: T0 + 3 * HOUR, nbf: T0 + HOUR })
  })
})
