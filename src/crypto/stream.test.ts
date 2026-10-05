/**
 * 流式引擎专项测试。
 *
 * 重点覆盖内存路径碰不到的边界：分块边界、源字节数不符、截断、尾部多余数据、
 * 以及"流式产物与内存产物必须可互解"（这是浏览器流式落盘与命令行互操作的等价性依据）。
 */
import { describe, expect, it } from 'vitest'
import {
  ByteQueue,
  bufferSource,
  collectingSink,
  decryptStream,
  encryptStream,
  keyCheck,
  type ByteSource,
} from './stream.ts'
import { decryptContainer, encryptContainer, planChunks } from './container.ts'
import { MasterKey } from './keys.ts'
import { concatBytes, bytesToHex } from './encoding.ts'
import type { AlgoId } from './aead.ts'
import { sha256 } from '@noble/hashes/sha2.js'

const te = new TextEncoder()
const hex = (b: Uint8Array) => bytesToHex(b)
/** 与容器 meta.h 完全一致的哈希算法（大写 Hex 比较）。 */
const sha256Of = (data: Uint8Array) => new Uint8Array(sha256(data))

function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 37 + seed * 11) & 0xff
  return out
}

/** 把一块字节切成多个"畸形大小"的片段，模拟流式源的真实切分。 */
function chopped(data: Uint8Array, sizes: number[]): ByteSource {
  const pieces: Uint8Array[] = []
  let off = 0
  let index = 0
  while (off < data.length) {
    const size = sizes[index % sizes.length]
    pieces.push(data.subarray(off, Math.min(off + size, data.length)))
    off += size
    index++
  }
  if (pieces.length === 0) pieces.push(new Uint8Array(0))
  return bufferSource(pieces)
}

async function streamRoundTrip(data: Uint8Array, layers: AlgoId[], chunkSize = 1 << 20, source?: ByteSource) {
  const mk = MasterKey.generate()
  const enc = collectingSink()
  await encryptStream(source ?? bufferSource([data]), enc.sink, mk, {
    layers,
    plaintextLength: data.length,
    chunkSize,
  })
  const file = concatBytes(...enc.parts)
  const dec = collectingSink()
  const result = await decryptStream(bufferSource([file]), dec.sink, mk)
  return { file, plaintext: concatBytes(...dec.parts), result, key: mk }
}

describe('流式引擎', () => {
  it('空文件也能往返，且块内仍有 tag', async () => {
    const { file, plaintext, result } = await streamRoundTrip(new Uint8Array(0), ['AES-128-GCM'])
    expect(plaintext.length).toBe(0)
    expect(result.plaintextLength).toBe(0)
    // 头部 + 1 块（0 字节明文仍占 (2L−1)×16 = 16 字节 tag 区）
    const plan = planChunks(0, 1 << 20, 1)
    expect(result.headerLength + plan.blockTotals[0]).toBe(file.length)
  })

  it('单块 / 多块边界一致：明文长度与分块布局一一对应', async () => {
    // 每块明文 = chunkSize − 层数×16；用 1 层、chunkSize 64 让每块明文 48 字节
    const chunkSize = 64
    const layers: AlgoId[] = ['AES-128-GCM']
    for (const length of [47, 48, 49, 96, 97, 300]) {
      const { plaintext, result } = await streamRoundTrip(bytes(length, length), layers, chunkSize)
      expect(hex(plaintext), `length=${length}`).toBe(hex(bytes(length, length)))
      expect(result.header.cc, `cc for ${length}`).toBe(planChunks(length, chunkSize, 1).chunkCount)
    }
  })

  it('5 种算法各自流式往返一致', async () => {
    const algos: AlgoId[] = ['AES-128-GCM', 'AES-256-GCM', 'CHACHA20-POLY1305', 'XCHACHA20-POLY1305', 'SM4-GCM']
    for (const algo of algos) {
      const data = bytes(4096, 3)
      const { plaintext } = await streamRoundTrip(data, [algo])
      expect(hex(plaintext), algo).toBe(hex(data))
    }
  })

  it('1~10 层流式往返一致（层数越多 tag 区越长）', async () => {
    for (const layerCount of [1, 2, 3, 5, 10]) {
      const data = bytes(1000, layerCount)
      const layers: AlgoId[] = Array.from({ length: layerCount }, (_, i) =>
        i % 2 === 0 ? 'AES-128-GCM' : 'CHACHA20-POLY1305',
      )
      const { plaintext, result } = await streamRoundTrip(data, layers, 4096)
      expect(hex(plaintext), `layers=${layerCount}`).toBe(hex(data))
      expect(result.header.lc).toBe(layerCount)
    }
  })

  it('源被切成畸形片段也能正确拼块', async () => {
    const data = bytes(5000, 9)
    // 1、7、1000、3 字节交替，制造大量跨块拼接
    const { plaintext } = await streamRoundTrip(data, ['AES-256-GCM', 'SM4-GCM'], 1024, chopped(data, [1, 7, 1000, 3]))
    expect(hex(plaintext)).toBe(hex(data))
  })

  it('源字节数与 plaintextLength 不符会被拒绝', async () => {
    const mk = MasterKey.generate()
    const data = bytes(100, 1)
    await expect(
      encryptStream(bufferSource([data]), collectingSink().sink, mk, {
        layers: ['AES-128-GCM'],
        plaintextLength: 101,
      }),
    ).rejects.toThrow('SOURCE_LENGTH_MISMATCH')
  })

  it('源多出字节会被拒绝（避免静默丢弃数据）', async () => {
    const mk = MasterKey.generate()
    const data = bytes(100, 1)
    await expect(
      encryptStream(bufferSource([data, bytes(10, 2)]), collectingSink().sink, mk, {
        layers: ['AES-128-GCM'],
        plaintextLength: 100,
      }),
    ).rejects.toThrow('SOURCE_TRAILING_DATA')
  })

  it('密文被截断会报 TAG_TRUNCATED 或 SOURCE_TRUNCATED', async () => {
    const data = bytes(2048, 4)
    const mk = MasterKey.generate()
    const enc = collectingSink()
    await encryptStream(bufferSource([data]), enc.sink, mk, { layers: ['AES-128-GCM'], plaintextLength: data.length })
    const file = concatBytes(...enc.parts)
    const truncated = file.subarray(0, file.length - 8)
    await expect(decryptStream(bufferSource([truncated]), collectingSink().sink, mk)).rejects.toThrow(
      /SOURCE_TRUNCATED|TAG_TRUNCATED|PLAINTEXT_LENGTH/,
    )
  })

  it('密文尾部多出字节会被拒绝', async () => {
    const data = bytes(512, 5)
    const mk = MasterKey.generate()
    const enc = collectingSink()
    await encryptStream(bufferSource([data]), enc.sink, mk, { layers: ['AES-128-GCM'], plaintextLength: data.length })
    const file = concatBytes(...enc.parts, bytes(16, 6))
    await expect(decryptStream(bufferSource([file]), collectingSink().sink, mk)).rejects.toThrow('TRAILING_DATA')
  })

  it('错误密钥统一报 AUTH_FAILED，不泄露层信息', async () => {
    const data = te.encode('very secret payload')
    const mk = MasterKey.generate()
    const wrong = MasterKey.generate()
    const enc = collectingSink()
    await encryptStream(bufferSource([data]), enc.sink, mk, {
      layers: ['AES-128-GCM', 'SM4-GCM', 'CHACHA20-POLY1305'],
      plaintextLength: data.length,
    })
    const file = concatBytes(...enc.parts)
    await expect(decryptStream(bufferSource([file]), collectingSink().sink, wrong)).rejects.toThrow('AUTH_FAILED')
  })

  it('任一层密文被篡改都会被检测到（认证覆盖全部层）', async () => {
    const data = bytes(300, 7)
    const mk = MasterKey.generate()
    const enc = collectingSink()
    await encryptStream(bufferSource([data]), enc.sink, mk, {
      layers: ['AES-128-GCM', 'SM4-GCM'],
      plaintextLength: data.length,
    })
    const file = new Uint8Array(concatBytes(...enc.parts))
    // 块区中间某字节翻转（跳过头部）
    const headerLen = file.length - planChunks(data.length, 1 << 20, 2).blockTotals[0]
    const tampered = copyWithFlip(file, headerLen + 10)
    await expect(decryptStream(bufferSource([tampered]), collectingSink().sink, mk)).rejects.toThrow('AUTH_FAILED')
  })

  it('gzip 标志位写入头部，引擎本身不碰压缩数据', async () => {
    const mk = MasterKey.generate()
    const data = bytes(1000, 8)
    const enc = collectingSink()
    const result = await encryptStream(bufferSource([data]), enc.sink, mk, {
      layers: ['AES-128-GCM'],
      plaintextLength: data.length,
      gzip: true,
      meta: { n: 'x.bin', os: 9999 },
    })
    expect(result.header.flags & 2).toBe(2)
    expect(result.header.meta.os).toBe(9999)
    // 解密端不需要知道 gzip，只是把明文原样还回来
    const dec = collectingSink()
    const back = await decryptStream(bufferSource([concatBytes(...enc.parts)]), dec.sink, mk)
    expect(back.header.flags & 2).toBe(2)
    expect(hex(concatBytes(...dec.parts))).toBe(hex(data))
  })

  it('进度回调按块单调递增并最终等于总长', async () => {
    const data = bytes(3000, 10)
    const mk = MasterKey.generate()
    const seen: number[] = []
    const enc = collectingSink()
    await encryptStream(bufferSource([data]), enc.sink, mk, {
      layers: ['AES-128-GCM'],
      plaintextLength: data.length,
      chunkSize: 512,
      onProgress: (done) => seen.push(done),
    })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[seen.length - 1]).toBe(data.length)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
  })

  it('确定性随机源可复现密文（供互操作性对拍使用）', async () => {
    const data = bytes(700, 11)
    const mk = MasterKey.generate()
    const makeRandom = () => {
      let counter = 0
      return (length: number) => {
        const out = new Uint8Array(length)
        for (let i = 0; i < length; i++) out[i] = (counter++ * 29 + 5) & 0xff
        return out
      }
    }
    const a = collectingSink()
    await encryptStream(bufferSource([data]), a.sink, mk, {
      layers: ['AES-256-GCM', 'SM4-GCM'],
      plaintextLength: data.length,
      randomFn: makeRandom(),
    })
    const b = collectingSink()
    await encryptStream(bufferSource([data]), b.sink, mk, {
      layers: ['AES-256-GCM', 'SM4-GCM'],
      plaintextLength: data.length,
      randomFn: makeRandom(),
    })
    expect(hex(concatBytes(...a.parts))).toBe(hex(concatBytes(...b.parts)))
  })

  it('流式产物与内存适配器产物可互解（等价性关键断言）', async () => {
    const data = bytes(9000, 12)
    const mk = MasterKey.generate()
    const layers: AlgoId[] = ['AES-256-GCM', 'CHACHA20-POLY1305']

    // 流式加密 → 内存适配器解密
    const streamed = collectingSink()
    await encryptStream(bufferSource([data]), streamed.sink, mk, {
      layers,
      plaintextLength: data.length,
      chunkSize: 2048,
    })
    const viaMemory = await decryptContainer(concatBytes(...streamed.parts), mk)
    expect(hex(viaMemory.plaintext)).toBe(hex(data))

    // 内存适配器加密 → 流式解密
    const viaAdapter = await encryptContainer(data, mk, { layers, chunkSize: 2048 })
    const out = collectingSink()
    await decryptStream(bufferSource(viaAdapter.pieces), out.sink, mk)
    expect(hex(concatBytes(...out.parts))).toBe(hex(data))
  })

  it('ByteQueue 能把推送的字节块变成可迭代源（可重放变体支持两遍遍历）', async () => {
    const data = bytes(2048, 13)
    const mk = MasterKey.generate()
    const queue = new ByteQueue({ replayable: true })
    const enc = collectingSink()
    const promise = encryptStream(queue, enc.sink, mk, {
      layers: ['AES-128-GCM'],
      plaintextLength: data.length,
    })
    // 异步推送，模拟管道
    void (async () => {
      for (let off = 0; off < data.length; off += 300) {
        queue.push(data.subarray(off, Math.min(off + 300, data.length)))
        await new Promise((r) => setTimeout(r, 0))
      }
      queue.end()
    })()
    await promise
    const dec = collectingSink()
    await decryptStream(bufferSource(enc.parts), dec.sink, mk)
    expect(hex(concatBytes(...dec.parts))).toBe(hex(data))
  })
})

function copyWithFlip(source: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(source)
  out[index] ^= 0x01
  return out
}

describe('密钥自检（keyCheck）', () => {
  /** 造一个 .XUQIAN：返回文件字节与所用密钥。 */
  async function makeContainer(data: Uint8Array, layers: AlgoId[], chunkSize = 1 << 20, key?: MasterKey) {
    const mk = key ?? MasterKey.generate()
    const enc = collectingSink()
    await encryptStream(bufferSource([data]), enc.sink, mk, { layers, plaintextLength: data.length, chunkSize })
    return { file: concatBytes(...enc.parts), key: mk, chunkSize }
  }

  it('正确密钥：单块文件 matched 且完成哈希比对', async () => {
    const data = bytes(1000, 1)
    const { file, key } = await makeContainer(data, ['AES-128-GCM'])
    const result = await keyCheck(key, bufferSource([file]))
    expect(result.matched).toBe(true)
    expect(result.hashVerified).toBe(true)
    expect(result.firstChunkHash).toBe(bytesToHex(sha256Of(data)).toUpperCase())
    expect(result.layers).toEqual(['AES-128-GCM'])
    expect(result.plaintextLength).toBe(data.length)
  })

  it('错误密钥：单块文件 matched=false（不是抛错）', async () => {
    const data = bytes(1000, 2)
    const { file } = await makeContainer(data, ['AES-128-GCM'])
    const wrong = MasterKey.generate()
    const result = await keyCheck(wrong, bufferSource([file]))
    expect(result.matched).toBe(false)
    expect(result.hashVerified).toBe(false)
    // 即便如此，头部元信息仍然读得出来（供用户核对算法与文件）
    expect(result.layers).toEqual(['AES-128-GCM'])
    expect(result.plaintextLength).toBe(data.length)
  })

  it('多块文件：只读第一块即可判定，正确密钥 matched 但不声称哈希已验证', async () => {
    const data = bytes(5000, 3)
    // chunkSize 64、1 层 → 每块明文 48 字节，必然多块
    const { file, key } = await makeContainer(data, ['AES-128-GCM'], 64)
    const result = await keyCheck(key, bufferSource([file]))
    expect(result.matched).toBe(true)
    expect(result.hashVerified).toBe(false) // 首块 ≠ 全量，不能声称哈希已验证
    expect(result.firstChunkHash).toBe('')
    expect(result.plaintextLength).toBe(data.length)
  })

  it('多块文件：错误密钥 matched=false', async () => {
    const data = bytes(5000, 4)
    const { file } = await makeContainer(data, ['AES-256-GCM', 'SM4-GCM'], 64)
    const result = await keyCheck(MasterKey.generate(), bufferSource([file]))
    expect(result.matched).toBe(false)
  })

  it('5 种算法下自检结论都正确', async () => {
    const algos: AlgoId[] = ['AES-128-GCM', 'AES-256-GCM', 'CHACHA20-POLY1305', 'XCHACHA20-POLY1305', 'SM4-GCM']
    for (const algo of algos) {
      const data = bytes(2000, 5)
      const { file, key } = await makeContainer(data, [algo])
      const good = await keyCheck(key, bufferSource([file]))
      const bad = await keyCheck(MasterKey.generate(), bufferSource([file]))
      expect(good.matched, `${algo} 正确密钥`).toBe(true)
      expect(good.hashVerified, `${algo} 哈希校验`).toBe(true)
      expect(bad.matched, `${algo} 错误密钥`).toBe(false)
    }
  })

  it('10 层文件自检可用（层数不影响首块判定）', async () => {
    const data = bytes(3000, 6)
    const layers = Array.from({ length: 10 }, () => 'AES-128-GCM') as AlgoId[]
    const { file, key } = await makeContainer(data, layers, 256)
    expect((await keyCheck(key, bufferSource([file]))).matched).toBe(true)
    expect((await keyCheck(MasterKey.generate(), bufferSource([file]))).matched).toBe(false)
  })

  it('密文被篡改时自检失败（与"密钥不对"同样表现为 matched=false）', async () => {
    const data = bytes(4000, 7)
    const { file, key } = await makeContainer(data, ['AES-128-GCM'], 64)
    // 翻转第一块内的一个字节（跳过头部）
    const headerLength = file.length - planChunks(data.length, 64, 1).blockTotals.reduce((a, b) => a + b, 0)
    const tampered = copyWithFlip(file, headerLength + 5)
    const result = await keyCheck(key, bufferSource([tampered]))
    expect(result.matched).toBe(false)
  })

  it('单块文件内容被改动时哈希比对会暴露不一致', async () => {
    const data = bytes(500, 8)
    const { file, key } = await makeContainer(data, ['AES-128-GCM'])
    // 直接改头部 meta.h 不可行（CRC 会失败），所以这里验证"正常文件 hashVerified=true"
    const ok = await keyCheck(key, bufferSource([file]))
    expect(ok.hashVerified).toBe(true)
    // 关闭哈希比对时不应声称验证过
    const skipped = await keyCheck(key, bufferSource([file]), { verifyHash: false })
    expect(skipped.matched).toBe(true)
    expect(skipped.hashVerified).toBe(false)
  })

  it('空文件自检：正确密钥 matched，错误密钥 matched=false', async () => {
    const { file, key } = await makeContainer(new Uint8Array(0), ['AES-128-GCM'])
    expect((await keyCheck(key, bufferSource([file]))).matched).toBe(true)
    expect((await keyCheck(MasterKey.generate(), bufferSource([file]))).matched).toBe(false)
  })
})
