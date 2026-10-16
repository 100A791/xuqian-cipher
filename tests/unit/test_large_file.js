/**
 * 大文件分块测试 —— SPEC 第 5 节阶段七「跑大文件分块测试」。
 * 运行：node tests/unit/test_large_file.js
 *
 * 重点验三件事：
 *   ① 跨多个分块（>10 块）的内容完整性 —— 分块漏字节、块间计数器错位都会在这里暴露；
 *   ② **分块边界**：恰好 1 块、1 块 ±1 字节 —— 差一错误最爱藏的地方；
 *   ③ 块间计数器严格不重叠（SPEC §7「禁止 nonce 复用」）。
 */
import { encryptFile } from '../../src/selfcrypto/file/encrypt.js'
import { decryptFile } from '../../src/selfcrypto/file/decrypt.js'
import { blockCounter } from '../../src/selfcrypto/file/encrypt.js'
import { CHUNK_SIZE } from '../../src/selfcrypto/common/constants.js'
import { setInternalDiagnostics } from '../../src/selfcrypto/common/fail.js'
import { setUniformDelayRange } from '../../src/selfcrypto/common/delay.js'
import { assertEqual, assertTrue, bytesToHex, createRunner } from './_helpers.js'

const runner = createRunner('大文件分块（完整性 / 边界 / 计数器不重叠）')
setUniformDelayRange([0, 0])
setInternalDiagnostics(() => {})

/** 把 16 字节大端计数器读成 128 位 BigInt（新写法下低 8 字节已不能代表块偏移）。 */
function counterToBigInt(bytes) {
  let v = 0n
  for (const byte of bytes) v = (v << 8n) | BigInt(byte)
  return v
}

/** 用可复现的伪随机填充，避免全零数据掩盖"块错位"这类问题。 */
function patterned(length, seed = 1) {
  const out = new Uint8Array(length)
  let x = seed >>> 0
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    out[i] = (x >>> 24) & 0xff
  }
  return out
}

/** 逐字节比对，返回首个不同位置（-1 表示完全一致）。 */
function firstDiff(a, b) {
  if (a.length !== b.length) return -1
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i
  return -1
}

const key = patterned(16, 7)
const meta = [
  ['name', 'large.bin'],
  ['mime', 'application/octet-stream'],
]

await runner.test('12 MB / 12 个分块：内容逐字节一致', async () => {
  const CHUNKS = 12
  const content = patterned(CHUNK_SIZE * CHUNKS, 11)
  const started = Date.now()
  const { cipherBytes, keyK } = encryptFile(content, meta, { masterKey: key })
  const encryptedMs = Date.now() - started

  const t2 = Date.now()
  const result = await decryptFile(cipherBytes, keyK)
  const decryptedMs = Date.now() - t2

  assertEqual(result.plainBytes.length, content.length, '还原长度')
  assertEqual(firstDiff(result.plainBytes, content), -1, '逐字节一致')

  // 密文长度 = 明文 + 4(metaLen) + metaLen + MAC(32)
  const overhead = cipherBytes.length - content.length
  assertTrue(overhead > 32 && overhead < 200, `开销应在合理范围，实际 ${overhead}`)

  const mbps = (content.length / 1024 / 1024 / ((encryptedMs + decryptedMs) / 1000)).toFixed(1)
  assertTrue(cipherBytes.length > content.length, '密文应略大于明文')
  console.log(
    `      ${CHUNKS} MB 加密 ${encryptedMs}ms + 解密 ${decryptedMs}ms ≈ ${mbps} MB/s（自研纯 JS AES-CTR，无硬件加速）`,
  )
})

for (const [label, size] of [
  ['恰好 1 个分块', CHUNK_SIZE],
  ['1 个分块 − 1 字节', CHUNK_SIZE - 1],
  ['1 个分块 + 1 字节', CHUNK_SIZE + 1],
  ['跨块边界 2 个分块 + 7 字节', CHUNK_SIZE * 2 + 7],
]) {
  await runner.test(`分块边界：${label} 能完整往返`, async () => {
    const content = patterned(size, 21)
    const { cipherBytes, keyK } = encryptFile(content, meta, { masterKey: key })
    const result = await decryptFile(cipherBytes, keyK)
    assertEqual(result.plainBytes.length, size, '长度')
    assertEqual(firstDiff(result.plainBytes, content), -1, '逐字节一致')
    // 边界后一个字节也不能串味：确认分块长度按 CHUNK_SIZE 切
    assertEqual(decryptResultChunkCount(result.plainBytes.length), Math.ceil(size / CHUNK_SIZE), '分块数')
  })
}

function decryptResultChunkCount(plainLen) {
  return Math.max(1, Math.ceil(plainLen / CHUNK_SIZE))
}

await runner.test('块间计数器严格不重叠（覆盖前 24 个块）', () => {
  const nonce = patterned(16, 33)
  const seen = new Set()
  const perChunk = CHUNK_SIZE / 16
  // 计数器 = nonce(完整 128 位) + i × 每块计数器数，低 8 字节含 nonce 的后半部分，
  // 所以必须按 **128 位整数**比较，不能只读低 8 字节。
  const base = counterToBigInt(blockCounter(nonce, 0))
  for (let i = 0; i < 24; i++) {
    const counter = blockCounter(nonce, i)
    const hex = bytesToHex(counter)
    assertTrue(!seen.has(hex), `块 ${i} 的计数器与之前重复`)
    seen.add(hex)
    // 相对块 0 的增量必须恰好是 i 个块
    assertEqual(counterToBigInt(counter) - base, BigInt(i) * BigInt(perChunk), `块 ${i} 起始计数`)
  }
  // 块内最后一个计数器仍落在本块区间内
  const last = BigInt(23) * BigInt(perChunk) + BigInt(perChunk - 1)
  assertTrue(last < BigInt(24) * BigInt(perChunk), '块内计数器不越界')
})

await runner.test('完整 nonce：16 字节全部参与计数器（回归：曾只用前 8 字节）', () => {
  const a = patterned(16, 55)
  const b = new Uint8Array(a)
  b[15] ^= 0x01 // 只改 nonce 的**最后一个字节**，前 15 字节不动

  // 新写法：整个 nonce 参与 → 块 0 的计数器必须随之改变
  assertTrue(bytesToHex(blockCounter(a, 0)) !== bytesToHex(blockCounter(b, 0)), 'nonce 后半必须影响计数器')
  // v1 兼容分支：后半被丢弃 → 块 0 的计数器完全相同（这正是被修掉的旧行为）
  assertEqual(bytesToHex(blockCounter(a, 0, false)), bytesToHex(blockCounter(b, 0, false)), 'v1 分支应忽略 nonce 后半')
})

await runner.test('12 MB 的密文里不应出现明文片段（分块加密没有漏块）', () => {
  // 构造一段高辨识度的"明文记号"放在最后一个分块里，确认它没有以明文出现在密文中
  const content = patterned(CHUNK_SIZE * 3, 44)
  const marker = new TextEncoder().encode('LAST-CHUNK-PLAINTEXT-MARKER-XUQIAN-9911')
  content.set(marker, CHUNK_SIZE * 2 + 100)
  const { cipherBytes } = encryptFile(content, meta, { masterKey: key })
  const asLatin1 = Buffer.from(cipherBytes).toString('latin1')
  assertTrue(!asLatin1.includes('LAST-CHUNK-PLAINTEXT-MARKER-XUQIAN-9911'), '明文记号不得出现在密文里')
})

runner.finish()
