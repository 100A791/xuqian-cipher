/**
 * 文件加解密往返 + **双向交叉验证** —— SPEC 第 5 节阶段二最后一项
 * 「做交叉验证，用自研代码加密，用成熟库解密，反之亦然」。
 *
 * 本文件里的参考实现（reference）刻意**不复用** src/selfcrypto 的任何加密代码：
 * 头部字节用 DataView 手写、KDF/MAC 用 node:crypto（OpenSSL）、CTR 用 createDecipheriv。
 * 两边独立得出同一结果，才能说明文件格式不是"自己和自己对齐"。
 *
 * 运行：node tests/unit/test_file_crypto.js
 */
import { createHmac, createDecipheriv, createCipheriv } from 'node:crypto'

import { encryptFile } from '../../src/selfcrypto/file/encrypt.js'
import { checkKey, decryptFile } from '../../src/selfcrypto/file/decrypt.js'
import { HEADER_LEN, parseHeader, splitFile } from '../../src/selfcrypto/file/format.js'
import { MAC_LEN, MAGIC, CHUNK_SIZE } from '../../src/selfcrypto/common/constants.js'
import { setInternalDiagnostics } from '../../src/selfcrypto/common/fail.js'
import { resetUniformDelayRange, setUniformDelayRange } from '../../src/selfcrypto/common/delay.js'
import { assertEqual, assertTrue, bytesToHex, createRunner } from './_helpers.js'

const runner = createRunner('自研文件加解密（往返 + 与 OpenSSL 双向交叉验证）')

// 失败路径会走统一延迟；测试里缩到 0，否则每个负例都要等 4~5 秒
setUniformDelayRange([0, 0])
resetUniformDelayRange()
setUniformDelayRange([0, 0])

// 把内部失败原因收集起来，便于断言"确实是这一步失败"（生产环境默认关闭）
const reasons = []
setInternalDiagnostics((reason) => reasons.push(reason))

const data = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff)
const utf8 = (s) => new TextEncoder().encode(s)
const concat = (...parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
/** 大缓冲区的比较不打印全文，否则失败时日志会被整段十六进制淹掉。 */
const short = (bytes) =>
  bytes.length <= 32 ? bytesToHex(bytes) : `${bytesToHex(bytes.subarray(0, 16))}…(${bytes.length} 字节)`
function assertBytesEqual(actual, expected, label) {
  const same = actual.length === expected.length && actual.every((v, i) => v === expected[i])
  if (!same) {
    let firstDiff = -1
    for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
      if (actual[i] !== expected[i]) {
        firstDiff = i
        break
      }
    }
    throw new Error(`${label} 不一致：长度 ${actual.length}/${expected.length}，首个不同字节 @${firstDiff}`)
  }
  assertTrue(true, `${label}（${short(actual)}）`)
}

const u32 = (v) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v)
  return b
}
const u64 = (v) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(v))
  return b
}

// ---------------------------------------------------------------------------
// 参考实现（只用 node:crypto，完全不碰 src/selfcrypto 的加解密代码）
// ---------------------------------------------------------------------------

const HMAC = (key, ...parts) => {
  const h = createHmac('sha256', Buffer.from(key))
  for (const p of parts) h.update(Buffer.from(p))
  return new Uint8Array(h.digest())
}

const subkeys = (masterKey, salt) => {
  const derive = (label) => HMAC(masterKey, salt, utf8(label))
  return {
    encKey: derive('xq/v1/enc').subarray(0, 16),
    macKey: derive('xq/v1/mac').subarray(0, 32),
    keyCheck: derive('xq/v1/check').subarray(0, 16),
  }
}

/** 手写头部（独立于 serializeHeader）。 */
function refHeaderBytes({ flags, timestamp, bootNonce, rulesLen, chunkSize, segments, splitMode, segmentOrder, salt, keyCheck, payloadLen }) {
  const out = new Uint8Array(HEADER_LEN)
  const dv = new DataView(out.buffer)
  out.set(MAGIC, 0)
  out[8] = 1
  out[9] = flags
  dv.setUint16(10, 0)
  dv.setUint32(12, timestamp)
  out.set(bootNonce, 16)
  dv.setUint32(32, rulesLen)
  dv.setUint32(36, chunkSize)
  out[40] = segments
  out[41] = splitMode
  out.set(segmentOrder, 42)
  out.set(salt, 45)
  out.set(keyCheck, 77)
  dv.setUint32(93, payloadLen)
  return out
}

/** 手写一个 KV 块：单条 ['name','ref.bin']（type 2 = utf8）。 */
function refMetadataKv(nameText) {
  const key = utf8('name')
  const value = utf8(nameText)
  return concat(u32(1), Uint8Array.of(key.length), key, Uint8Array.of(2), u32(value.length), value)
}

/** 纯交错拆分（输入是自然顺序的字节流时适用）。 */
const splitShares = (bytes, segments) => Array.from({ length: segments }, (_, j) => bytes.filter((_, i) => i % segments === j))

/** 纯合并：按逻辑下标 i % segments 回放。 */
function joinLogical(shares) {
  const total = shares.reduce((s, x) => s + x.length, 0)
  const out = new Uint8Array(total)
  const cursor = new Array(shares.length).fill(0)
  for (let i = 0; i < total; i++) {
    const j = i % shares.length
    out[i] = shares[j][cursor[j]++]
  }
  return out
}

/** 第 j 份的长度（载荷重排后各份不再是等分，必须按下标公式算）。 */
const shareLens = (total, segments) =>
  Array.from({ length: segments }, (_, j) => (j < total ? Math.ceil((total - j) / segments) : 0))

/** 把"已按 order 排列的载荷"还原成逻辑顺序的份。 */
function unreorderPayload(payload, segments, order) {
  const lens = shareLens(payload.length, segments)
  const shares = new Array(segments)
  let off = 0
  for (const physical of order) {
    shares[physical] = payload.subarray(off, off + lens[physical])
    off += lens[physical]
  }
  return shares
}

/**
 * 参考实现的计数器构造（**独立于 src/selfcrypto 重写一遍**，这正是交叉验证的意义）。
 *
 *   fullNonce = true  → 新文件：整个 16 字节 nonce 作 128 位初值，再累加块偏移
 *   fullNonce = false → v1 旧文件：只取前 8 字节，后 8 字节直接放块偏移
 */
function refCounter(bootNonce, chunkIndex, fullNonce = true) {
  const counter = fullNonce ? new Uint8Array(bootNonce) : concat(bootNonce.subarray(0, 8), u64(0))
  return refAddToCounter(counter, BigInt(chunkIndex) * BigInt(CHUNK_SIZE / 16))
}

/** 128 位大端加法（参考实现，用 BigInt 独立写一遍）。 */
function refAddToCounter(counter, value) {
  const addend = u64(value)
  let carry = 0n
  for (let i = 15; i >= 0; i--) {
    const sum = BigInt(counter[i]) + (i >= 8 ? BigInt(addend[i - 8]) : 0n) + carry
    counter[i] = Number(sum & 0xffn)
    carry = sum >> 8n
  }
  return counter
}

function refCtr(key, bootNonce, input, fullNonce = true) {
  const out = new Uint8Array(input.length)
  for (let off = 0, i = 0; off < input.length; off += CHUNK_SIZE, i++) {
    const chunk = input.subarray(off, Math.min(off + CHUNK_SIZE, input.length))
    const decipher = createDecipheriv('aes-128-ctr', Buffer.from(key), Buffer.from(refCounter(bootNonce, i, fullNonce)))
    out.set(concat(new Uint8Array(decipher.update(Buffer.from(chunk))), new Uint8Array(decipher.final())), off)
  }
  return out
}

/** 参考解密：吃我们自己产出的文件，返回 { content, metaLen }。 */
function referenceDecrypt(fileBytes, masterKey) {
  const bytes = Buffer.from(fileBytes)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < MAGIC.length; i++) assertEqual(bytes[i], MAGIC[i], '参考实现读到魔数')
  const header = {
    flags: bytes[9],
    timestamp: dv.getUint32(12),
    bootNonce: new Uint8Array(bytes.subarray(16, 32)),
    rulesLen: dv.getUint32(32),
    chunkSize: dv.getUint32(36),
    segments: bytes[40],
    splitMode: bytes[41],
    segmentOrder: Array.from(bytes.subarray(42, 45)),
    salt: new Uint8Array(bytes.subarray(45, 77)),
    keyCheck: new Uint8Array(bytes.subarray(77, 93)),
    payloadLen: dv.getUint32(93),
  }
  const { encKey, macKey, keyCheck } = subkeys(masterKey, header.salt)
  assertEqual(bytesToHex(keyCheck), bytesToHex(header.keyCheck), '参考实现算出的 KEY_CHECK')

  const macStart = HEADER_LEN + header.rulesLen + header.payloadLen
  assertEqual(bytes.length, macStart + MAC_LEN, '参考实现算出的文件总长')
  const expectedMac = HMAC(macKey, bytes.subarray(0, macStart))
  assertEqual(bytesToHex(expectedMac), bytesToHex(bytes.subarray(macStart)), '参考实现算出的整体 MAC')

  const rules = new Uint8Array(bytes.subarray(HEADER_LEN, HEADER_LEN + header.rulesLen))
  const payload = new Uint8Array(bytes.subarray(HEADER_LEN + header.rulesLen, macStart))
  const ciphertext = joinLogical(unreorderPayload(payload, header.segments, header.segmentOrder))
  // 按文件头自述选择计数器构造方式（新文件带 FLAG_FULL_NONCE_COUNTER = 0b100 = 4）
  const plaintext = refCtr(encKey, header.bootNonce, ciphertext, (header.flags & 4) !== 0)
  const metaLen = new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0)
  return { content: plaintext.subarray(4 + metaLen), metaLen, rules, header }
}

/**
 * 参考加密：用 node:crypto 从零造一个文件，交给我们的 decryptFile。
 * fullNonce=false 造 v1 旧格式（flags=0，只有 64 位 nonce），用于验证**向后兼容**；
 * fullNonce=true 造新格式（flags=4，完整 128 位 nonce）。
 */
function referenceEncrypt(content, masterKey, metadataName, fullNonce = false) {
  const flags = fullNonce ? 4 : 0
  const timestamp = 0x11223344
  const bootNonce = data(16, 21)
  const salt = data(32, 22)
  const rulesBytes = new Uint8Array(0)
  const segments = 3
  const splitMode = 0
  const segmentOrder = Uint8Array.from([2, 0, 1])

  const { encKey, macKey, keyCheck } = subkeys(masterKey, salt)
  const metaKv = refMetadataKv(metadataName)
  const plaintext = concat(u32(metaKv.length), metaKv, content)

  const ciphertext = new Uint8Array(plaintext.length)
  for (let off = 0, i = 0; off < plaintext.length; off += CHUNK_SIZE, i++) {
    const chunk = plaintext.subarray(off, Math.min(off + CHUNK_SIZE, plaintext.length))
    const cipher = createCipheriv('aes-128-ctr', Buffer.from(encKey), Buffer.from(refCounter(bootNonce, i, fullNonce)))
    ciphertext.set(concat(new Uint8Array(cipher.update(Buffer.from(chunk))), new Uint8Array(cipher.final())), off)
  }

  const shares = splitShares(ciphertext, segments)
  const payload = concat(...Array.from(segmentOrder).map((physical) => shares[physical]))
  const header = refHeaderBytes({
    flags,
    timestamp,
    bootNonce,
    rulesLen: rulesBytes.length,
    chunkSize: CHUNK_SIZE,
    segments,
    splitMode,
    segmentOrder,
    salt,
    keyCheck,
    payloadLen: payload.length,
  })
  const mac = HMAC(macKey, header, rulesBytes, payload)
  return { bytes: concat(header, rulesBytes, payload, mac), masterKey }
}

// ---------------------------------------------------------------------------
// 往返
// ---------------------------------------------------------------------------

const key = data(16, 99)

await runner.test('往返（小文件）：内容与元数据都能还原', async () => {
  const content = data(1000, 3)
  const { cipherBytes, keyK } = encryptFile(content, [['name', '秘密.txt'], ['size', 1000n]], { masterKey: key, now: 0x01020304 })
  const result = await decryptFile(cipherBytes, keyK)
  assertBytesEqual(result.plainBytes, content, '内容')
  assertEqual(result.metadata.get('name'), '秘密.txt', '元数据 name')
  assertEqual(result.metadata.get('size'), 1000n, '元数据 size')
  assertEqual(result.header.timestamp, 0x01020304, '时间戳保留')
})

await runner.test('往返（跨多个分块）：内容完全一致', async () => {
  // 2.5 个分块，覆盖"非整块长度"与多块计数器推进
  const content = data(CHUNK_SIZE * 2 + 12345, 5)
  const { cipherBytes, keyK } = encryptFile(content, [['name', 'big.bin']], { masterKey: key })
  const result = await decryptFile(cipherBytes, keyK)
  assertEqual(result.plainBytes.length, content.length, '长度')
  assertEqual(bytesToHex(result.plainBytes.subarray(0, 64)), bytesToHex(content.subarray(0, 64)), '开头一致')
  assertEqual(
    bytesToHex(result.plainBytes.subarray(content.length - 64)),
    bytesToHex(content.subarray(content.length - 64)),
    '结尾一致',
  )
})

await runner.test('往返（空文件与零元数据）', async () => {
  const { cipherBytes, keyK } = encryptFile(new Uint8Array(0), [], { masterKey: key })
  const result = await decryptFile(cipherBytes, keyK)
  assertEqual(result.plainBytes.length, 0, '空内容')
  assertEqual(result.metadata.size, 0, '无元数据')
})

await runner.test('密文里看不到明文，也看不到元数据里的文件名', () => {
  const content = utf8('这是一个应当被加密的句子 PLANTEXT-MARKER-12345')
  const { cipherBytes } = encryptFile(content, [['name', '机密文件名.docx']], { masterKey: key })
  const asText = Buffer.from(cipherBytes).toString('latin1')
  assertTrue(!asText.includes('PLANTEXT-MARKER-12345'), '明文不应出现')
  assertTrue(!asText.includes('机密文件名'), '元数据文件名不应出现在明文里')
})

// ---------------------------------------------------------------------------
// 双向交叉验证
// ---------------------------------------------------------------------------

await runner.test('交叉验证 A：自研加密 → OpenSSL 独立解密', () => {
  const content = data(5000, 11)
  const { cipherBytes } = encryptFile(content, [['name', 'cross.bin'], ['mime', 'application/octet-stream']], {
    masterKey: key,
  })
  const reference = referenceDecrypt(cipherBytes, key)
  assertBytesEqual(reference.content, content, '参考实现解出的内容')
  assertTrue(reference.metaLen > 0, '参考实现读到元数据长度')
})

await runner.test('交叉验证 B：OpenSSL 独立加密 → 自研解密', async () => {
  const content = data(4096, 13)
  const reference = referenceEncrypt(content, key, 'ref.bin')
  const result = await decryptFile(reference.bytes, key)
  assertBytesEqual(result.plainBytes, content, '自研实现解出的内容')
  assertEqual(result.metadata.get('name'), 'ref.bin', '参考实现写入的元数据')
})

await runner.test('交叉验证 C：多分块文件也双向一致（覆盖计数器推进）', () => {
  const content = data(CHUNK_SIZE + 777, 17)
  const { cipherBytes } = encryptFile(content, [['name', 'multi.bin']], { masterKey: key })
  const reference = referenceDecrypt(cipherBytes, key)
  assertBytesEqual(reference.content, content, '多分块参考解密')
})

await runner.test('交叉验证 D：新格式（flags=4，完整 128 位 nonce）—— 参考加密 → 自研解密', async () => {
  const content = data(CHUNK_SIZE + 321, 23)
  const reference = referenceEncrypt(content, key, 'v2.bin', true)
  assertEqual(reference.bytes[9] & 4, 4, '参考实现应置上完整-nonce 标志位')
  const result = await decryptFile(reference.bytes, key)
  assertBytesEqual(result.plainBytes, content, '自研实现解开新格式参考文件')
  assertEqual(result.metadata.get('name'), 'v2.bin', '元数据')
})

await runner.test('交叉验证 E：自研新格式 —— 参考实现按 flags 自述也能解开', () => {
  const content = data(3333, 29)
  const { cipherBytes } = encryptFile(content, [['name', 'v2-cross.bin']], { masterKey: key })
  assertEqual(cipherBytes[9] & 4, 4, '新文件必须置上完整-nonce 标志位')
  const reference = referenceDecrypt(cipherBytes, key)
  assertBytesEqual(reference.content, content, '参考实现按 flags 解出的内容')
})

await runner.test('向后兼容：v1 旧格式（flags=0，仅 64 位 nonce）仍能解开', async () => {
  const content = data(2048, 31)
  const legacy = referenceEncrypt(content, key, 'v1.bin') // fullNonce 默认 false → flags=0
  assertEqual(legacy.bytes[9] & 4, 0, 'v1 旧格式不应带完整-nonce 标志位')
  const result = await decryptFile(legacy.bytes, key)
  assertBytesEqual(result.plainBytes, content, 'v1 旧文件仍可解密')
  assertEqual(result.metadata.get('name'), 'v1.bin', 'v1 元数据')
})

// ---------------------------------------------------------------------------
// 负例：篡改 / 错密钥 / 截断，且都必须走统一失败
// ---------------------------------------------------------------------------

const flips = [
  ['头部标志位', (b) => { b[9] ^= 0x01 }],
  ['时间戳', (b) => { b[12] ^= 0xff }],
  ['盐', (b) => { b[45] ^= 0x01 }],
  ['KEY_CHECK', (b) => { b[77] ^= 0x01 }],
  ['载荷中的一个字节', (b) => { b[b.length - MAC_LEN - 1] ^= 0x01 }],
  ['MAC 自身', (b) => { b[b.length - 1] ^= 0x01 }],
]

for (const [label, mutate] of flips) {
  await runner.test(`篡改「${label}」→ 统一失败，且不返回任何明文`, async () => {
    const { cipherBytes } = encryptFile(data(500, 19), [['name', 'x.bin']], { masterKey: key })
    const tampered = new Uint8Array(cipherBytes)
    mutate(tampered)
    let threw = null
    let returned = null
    try {
      returned = await decryptFile(tampered, key)
    } catch (error) {
      threw = error
    }
    assertTrue(threw !== null && returned === null, '必须抛错且不返回结果')
    assertEqual(threw.code, 'XQ_UNIFORM_FAIL', '统一失败错误码')
    assertEqual(threw.message, '解密失败', '统一失败文案（不含原因）')
  })
}

await runner.test('错误密钥 → 统一失败（整体 MAC 阶段拦下）', async () => {
  const { cipherBytes } = encryptFile(data(300, 23), [['name', 'x.bin']], { masterKey: key })
  const wrong = data(16, 77)
  reasons.length = 0
  let error = null
  try {
    await decryptFile(cipherBytes, wrong)
  } catch (e) {
    error = e
  }
  assertEqual(error?.message, '解密失败', '对外文案统一')
  // 顺序已反转为「先整体 MAC、后 KEY_CHECK」：错误密钥同样要先付出完整 MAC 的代价。
  // 否则「密钥错」会比「文件被改」快得多（后者必须算完整个文件的 MAC），统一延迟即失效。
  assertTrue(reasons.includes('mac-mismatch'), `内部原因应为 mac-mismatch，实际 ${JSON.stringify(reasons)}`)
})

await runner.test('截断文件 → 统一失败（且内部原因是格式问题）', async () => {
  const { cipherBytes } = encryptFile(data(300, 29), [['name', 'x.bin']], { masterKey: key })
  reasons.length = 0
  let error = null
  try {
    await decryptFile(cipherBytes.slice(0, cipherBytes.length - 1), key)
  } catch (e) {
    error = e
  }
  assertEqual(error?.message, '解密失败', '对外文案统一')
  assertTrue(reasons.some((r) => r.startsWith('format:')), `内部原因应为格式问题，实际 ${JSON.stringify(reasons)}`)
})

await runner.test('checkKey：正确密钥为真、错误密钥为假，且不改动文件', () => {
  const { cipherBytes } = encryptFile(data(128, 31), [['name', 'x.bin']], { masterKey: key })
  const before = bytesToHex(cipherBytes)
  assertTrue(checkKey(cipherBytes, key), '正确密钥')
  assertTrue(!checkKey(cipherBytes, data(16, 88)), '错误密钥')
  assertEqual(bytesToHex(cipherBytes), before, 'checkKey 不应改动文件')
})

await runner.test('每次加密的盐与 BOOT_NONCE 都不同（同一明文 + 同一密钥产出不同密文）', () => {
  const content = data(256, 37)
  const a = encryptFile(content, [['name', 'x.bin']], { masterKey: key }).cipherBytes
  const b = encryptFile(content, [['name', 'x.bin']], { masterKey: key }).cipherBytes
  assertTrue(bytesToHex(a) !== bytesToHex(b), '密文不应相同')
  const ha = parseHeader(a)
  const hb = parseHeader(b)
  assertTrue(bytesToHex(ha.salt) !== bytesToHex(hb.salt), '盐应不同')
  assertTrue(bytesToHex(ha.bootNonce) !== bytesToHex(hb.bootNonce), 'BOOT_NONCE 应不同')
})

await runner.test('分块计数器不重叠（相邻块的计数器区间无交集）', async () => {
  const { blockCounter } = await import('../../src/selfcrypto/file/encrypt.js')
  const nonce = data(16, 41)
  const c0 = blockCounter(nonce, 0)
  const c1 = blockCounter(nonce, 1)
  assertEqual(c0.length, 16, '计数器长度')
  assertTypeSafeDistinct(c0, c1)
})

/** 把 16 字节大端计数器读成 128 位 BigInt（新写法下低 8 字节含 nonce 的后半部分）。 */
function counterToBigInt(bytes) {
  let v = 0n
  for (const byte of bytes) v = (v << 8n) | BigInt(byte)
  return v
}

function assertTypeSafeDistinct(a, b) {
  assertTrue(bytesToHex(a) !== bytesToHex(b), '不同块的计数器必须不同')
  // 按 128 位差值断言：块 1 应恰好比块 0 多一个块的计数器数。
  // 不能只读低 8 字节 —— 新写法下那里含 nonce 的后半部分。
  assertEqual(counterToBigInt(b) - counterToBigInt(a), BigInt(CHUNK_SIZE / 16), '块 1 与块 0 的计数器差值')
}

runner.finish()
