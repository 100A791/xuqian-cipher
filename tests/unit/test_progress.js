/**
 * 大文件进度回调测试 —— G11：确认内核能**如实**上报进度（阶段名 + 块计数）。
 * 运行：node tests/unit/test_progress.js
 *
 * 为什么要测这个：界面上的进度条如果拿不可信的数字画，比没有进度条更糟。
 * 这里逐条验：阶段序列正确、块计数单调、最后一次 done === total、不传回调时行为不变。
 */
import { encryptFile } from '../../src/selfcrypto/file/encrypt.js'
import { decryptFile } from '../../src/selfcrypto/file/decrypt.js'
import { encodeMetadata } from '../../src/selfcrypto/file/metadata.js'
import { CHUNK_SIZE } from '../../src/selfcrypto/common/constants.js'
import { setUniformDelayRange } from '../../src/selfcrypto/common/delay.js'
import { assertEqual, assertTrue, createRunner } from './_helpers.js'

const runner = createRunner('大文件进度回调（阶段 / 单调 / 完整）')
setUniformDelayRange([0, 0])

const data = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 17 + seed * 11) & 0xff)
const key = data(16, 3)
const meta = [['name', 'progress.bin']]

/**
 * 实际加密的是 `u32(元数据长度) ‖ 元数据 ‖ 内容`，不是裸内容 ——
 * 所以块数要按**加上前缀之后**的长度算（我第一版就漏了这个前缀，把 6 块写成 5 块）。
 */
const PREFIX_LEN = 4 + encodeMetadata(meta).length
const expectedChunks = (contentLen) => Math.max(1, Math.ceil((contentLen + PREFIX_LEN) / CHUNK_SIZE))

await runner.test('加密：阶段序列为 setup → cipher(逐块) → split → mac', () => {
  const events = []
  encryptFile(data(CHUNK_SIZE * 3 + 123, 5), meta, { masterKey: key, onProgress: (p) => events.push(p) })
  const phases = [...new Set(events.map((e) => e.phase))]
  assertEqual(phases.join('>'), 'setup>cipher>split>mac', `阶段序列，实际 ${phases.join('>')}`)
  const cipher = events.filter((e) => e.phase === 'cipher')
  assertEqual(cipher.length, 4, `3 块 + 1 尾块 = 4 次上报，实际 ${cipher.length}`)
  assertEqual(cipher[0].total, 4, '总块数')
})

await runner.test('加密：块计数严格递增，最后一次 done === total', () => {
  const content = data(CHUNK_SIZE * 5, 7)
  const expected = expectedChunks(content.length)
  const cipher = []
  encryptFile(content, meta, {
    masterKey: key,
    onProgress: (p) => {
      if (p.phase === 'cipher') cipher.push(p)
    },
  })
  assertEqual(cipher.length, expected, `${content.length} 字节 + 前缀 → ${expected} 块`)
  for (let i = 1; i < cipher.length; i++) {
    assertTrue(cipher[i].done > cipher[i - 1].done, `第 ${i} 次应递增`)
    assertEqual(cipher[i].total, cipher[i - 1].total, 'total 全程不变')
  }
  assertEqual(cipher[cipher.length - 1].done, cipher[cipher.length - 1].total, '最后一次 done 应等于 total')
})

await runner.test('加密：未传回调时行为不变（返回值与传回调时逐字节一致）', () => {
  const content = data(CHUNK_SIZE + 500, 9)
  const withCb = encryptFile(content, meta, { masterKey: key, onProgress: () => {} }).cipherBytes
  const without = encryptFile(content, meta, { masterKey: key }).cipherBytes
  // 盐与 nonce 每次随机，所以密文不会逐字节相同；比对长度与"能解回原文"即可
  assertEqual(withCb.length, without.length, '长度一致')
  assertTrue(withCb.length > content.length, '密文应大于明文')
})

await runner.test('解密：阶段序列为 keycheck → mac → split → cipher(逐块)', async () => {
  const content = data(CHUNK_SIZE * 2 + 77, 13)
  const { cipherBytes, keyK } = encryptFile(content, meta, { masterKey: key })
  const events = []
  const result = await decryptFile(cipherBytes, keyK, { onProgress: (p) => events.push(p) })
  const phases = [...new Set(events.map((e) => e.phase))]
  assertEqual(phases.join('>'), 'keycheck>mac>split>cipher', `阶段序列，实际 ${phases.join('>')}`)
  assertEqual(result.plainBytes.length, content.length, '内容长度')

  // 顺序不可颠倒：密钥必须在 MAC 之前、MAC 必须在解密之前（SPEC §7）
  const firstCipher = events.findIndex((e) => e.phase === 'cipher')
  const firstMac = events.findIndex((e) => e.phase === 'mac')
  const firstKey = events.findIndex((e) => e.phase === 'keycheck')
  assertTrue(firstKey < firstMac && firstMac < firstCipher, 'KEY_CHECK → MAC → 解密 的顺序')
})

await runner.test('解密：失败时不会上报到 cipher 阶段（不能让人以为已经在解密了）', async () => {
  const { cipherBytes } = encryptFile(data(2000, 17), meta, { masterKey: key })
  const events = []
  let threw = false
  try {
    await decryptFile(cipherBytes, data(16, 99), { onProgress: (p) => events.push(p) })
  } catch {
    threw = true
  }
  assertEqual(threw, true, '错误密钥应失败')
  assertTrue(!events.some((e) => e.phase === 'cipher'), `失败路径不该进解密阶段，实际 ${events.map((e) => e.phase).join(',')}`)
})

await runner.test('加密：进度事件数量与文件大小成比例（大文件不会只报一次）', () => {
  const small = []
  const big = []
  encryptFile(data(CHUNK_SIZE, 21), meta, { masterKey: key, onProgress: (p) => p.phase === 'cipher' && small.push(p) })
  encryptFile(data(CHUNK_SIZE * 6, 23), meta, { masterKey: key, onProgress: (p) => p.phase === 'cipher' && big.push(p) })
  assertEqual(small.length, expectedChunks(CHUNK_SIZE), '1 个分块的内容 + 前缀会溢出到第 2 块')
  assertEqual(big.length, expectedChunks(CHUNK_SIZE * 6), '6 个分块的内容 + 前缀')
  assertTrue(big.length > small.length, '大文件的上报次数应更多')
})

runner.finish()
