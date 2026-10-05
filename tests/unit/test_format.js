/**
 * 格式层测试 —— SPEC 第 5 节阶段二「format.js 定义文件头和字段序列化」+「metadata.js 定义元数据编码」。
 * 运行：node tests/unit/test_format.js
 */
import {
  HEADER_LEN,
  MAC_OFFSET_FROM_END,
  OFFSETS,
  FLAG_COMPRESSED,
  SPLIT_MODE_INTERLEAVE_BYTES,
  FormatError,
  assembleFile,
  defaultHeader,
  fileLayout,
  parseHeader,
  serializeHeader,
  splitFile,
} from '../../src/selfcrypto/file/format.js'
import { decodeKv, encodeKv, encodeMetadata, decodeMetadata } from '../../src/selfcrypto/file/metadata.js'
import { MAC_LEN } from '../../src/selfcrypto/common/constants.js'
import { assertEqual, assertTrue, bytesToHex, createRunner } from './_helpers.js'

const runner = createRunner('自研格式层（头部 / 布局 / KV 编码）')

const fill = (n, v) => new Uint8Array(n).fill(v)

function sampleHeader(overrides = {}) {
  return defaultHeader({
    timestamp: 0x01020304,
    bootNonce: fill(16, 0xa5),
    salt: fill(32, 0x5a),
    keyCheck: fill(16, 0xc3),
    ...overrides,
  })
}

await runner.test('头部往返：字段逐一对上', () => {
  const header = sampleHeader({ flags: FLAG_COMPRESSED })
  const parsed = parseHeader(serializeHeader(header))
  assertEqual(parsed.version, 1, 'version')
  assertEqual(parsed.flags, FLAG_COMPRESSED, 'flags')
  assertEqual(parsed.timestamp, 0x01020304, 'timestamp')
  assertEqual(parsed.chunkSize, 1048576, 'chunkSize')
  assertEqual(parsed.segments, 3, 'segments')
  assertEqual(parsed.splitMode, SPLIT_MODE_INTERLEAVE_BYTES, 'splitMode')
  assertEqual(bytesToHex(parsed.segmentOrder), '020001', 'segmentOrder 应为 2 0 1')
  assertEqual(bytesToHex(parsed.salt), bytesToHex(fill(32, 0x5a)), 'salt')
  assertEqual(bytesToHex(parsed.bootNonce), bytesToHex(fill(16, 0xa5)), 'bootNonce')
  assertEqual(bytesToHex(parsed.keyCheck), bytesToHex(fill(16, 0xc3)), 'keyCheck')
})

await runner.test('头部长度固定为 97 字节，且各字段落在声明的偏移上', () => {
  const bytes = serializeHeader(sampleHeader())
  assertEqual(bytes.length, HEADER_LEN, 'HEADER_LEN')
  assertEqual(HEADER_LEN, 97, '头部长度常量')
  assertEqual(bytesToHex(bytes.slice(OFFSETS.MAGIC, OFFSETS.MAGIC + 8)), 'da7a9f3c00ff1b8e', 'MAGIC')
  assertEqual(bytes[OFFSETS.VERSION], 1, 'VERSION 偏移')
  // 段顺序写在偏移 42，长度 3
  assertEqual(bytesToHex(bytes.slice(42, 45)), '020001', 'SEGMENT_ORDER 偏移')
})

await runner.test('FLAGS 未知位被拒绝（不静默忽略）', () => {
  let threw = false
  try {
    parseHeader(serializeHeader(sampleHeader({ flags: 0b1000_0000 })))
  } catch (error) {
    threw = error instanceof FormatError && error.code === 'FLAGS_INVALID'
  }
  assertTrue(threw, '未知标志位应抛 FLAGS_INVALID')
})

await runner.test('魔数不符 / 文件过短 都被拒绝', () => {
  const serialized = serializeHeader(sampleHeader())
  const bad = serialized.slice()
  bad[0] ^= 0xff
  let magicCode = null
  try {
    parseHeader(bad)
  } catch (error) {
    magicCode = error.code
  }
  assertEqual(magicCode, 'MAGIC_MISMATCH', '魔数错误码')
  let shortCode = null
  try {
    parseHeader(serialized.slice(0, HEADER_LEN - 1))
  } catch (error) {
    shortCode = error.code
  }
  assertEqual(shortCode, 'FILE_TRUNCATED', '过短错误码')
})

await runner.test('保留字段（FK 槽位）非零 → 明确拒绝，而不是猜着解析', () => {
  const bytes = serializeHeader(sampleHeader())
  new DataView(bytes.buffer).setUint16(OFFSETS.RESERVED_FK, 7)
  let code = null
  try {
    parseHeader(bytes)
  } catch (error) {
    code = error.code
  }
  assertEqual(code, 'RESERVED_FK_UNSUPPORTED', 'FK 槽位错误码')
})

await runner.test('段顺序必须是 0/1/2 的排列（越界或重复都拒绝）', () => {
  for (const order of [Uint8Array.from([0, 0, 1]), Uint8Array.from([0, 1, 3]), Uint8Array.from([0, 1])]) {
    let threw = false
    try {
      serializeHeader(sampleHeader({ segmentOrder: order }))
    } catch (error) {
      threw = error.code === 'SEGMENT_ORDER_INVALID'
    }
    assertTrue(threw, `顺序 ${bytesToHex(order)} 应被拒绝`)
  }
})

await runner.test('组装 → 拆分：四段位置与 MAC 覆盖范围正确', () => {
  const rules = encodeKv([['wm', 'on'], ['layer', 2n]])
  const payload = fill(20, 0x77)
  const mac = fill(MAC_LEN, 0x99)
  const { bytes, header } = assembleFile({ header: sampleHeader(), rules, payload, mac })

  assertEqual(bytes.length, HEADER_LEN + rules.length + payload.length + MAC_LEN, '总长度')
  assertEqual(header.rulesLen, rules.length, '头部记录规则块长度')
  assertEqual(header.payloadLen, payload.length, '头部记录载荷长度')

  const parts = splitFile(bytes)
  assertEqual(bytesToHex(parts.rules), bytesToHex(rules), '规则块')
  assertEqual(bytesToHex(parts.payload), bytesToHex(payload), '载荷')
  assertEqual(bytesToHex(parts.mac), bytesToHex(mac), 'MAC')
  assertEqual(parts.macCovered.length, bytes.length - MAC_LEN, 'MAC 覆盖除末尾 MAC 外的全部字节')
  assertEqual(MAC_OFFSET_FROM_END, MAC_LEN, 'MAC 位于末尾')
})

await runner.test('文件长度与头部声明不符 → 报错（防截断与拼接）', () => {
  const { bytes } = assembleFile({
    header: sampleHeader(),
    rules: new Uint8Array(0),
    payload: fill(10, 1),
    mac: fill(MAC_LEN, 2),
  })
  let shortCode = null
  try {
    splitFile(bytes.slice(0, bytes.length - 1))
  } catch (error) {
    shortCode = error.code
  }
  assertEqual(shortCode, 'FILE_LENGTH_MISMATCH', '截断应被发现')

  const extra = new Uint8Array(bytes.length + 1)
  extra.set(bytes)
  let longCode = null
  try {
    splitFile(extra)
  } catch (error) {
    longCode = error.code
  }
  assertEqual(longCode, 'FILE_LENGTH_MISMATCH', '多余字节应被发现')
})

// ---------------------------------------------------------------- KV 编码

await runner.test('KV 往返：三种取值类型都对', () => {
  const entries = [
    ['name', '许七安.txt'],
    ['size', 1048576n],
    ['blob', Uint8Array.from([0, 1, 2, 255])],
  ]
  const decoded = decodeKv(encodeKv(entries))
  assertEqual(decoded.length, 3, '条目数')
  assertEqual(decoded[0][1], '许七安.txt', 'utf8 值')
  assertEqual(decoded[1][1], 1048576n, 'uint64 值')
  assertEqual(bytesToHex(decoded[2][1]), '000102ff', 'bytes 值')
})

await runner.test('KV 空块可往返', () => {
  const bytes = encodeKv([])
  assertEqual(bytes.length, 4, '空块只有 count')
  assertEqual(decodeKv(bytes).length, 0, '条目数')
})

await runner.test('KV 拒绝：重复键 / 非法键名 / 未知类型 / 尾部多余字节 / 截断', () => {
  const cases = [
    ['KV_KEY_DUPLICATE', () => encodeKv([['a', 1], ['a', 2]])],
    ['KV_KEY_INVALID', () => encodeKv([['中文键', 1]])],
    ['KV_KEY_INVALID', () => encodeKv([['', 1]])],
    ['KV_VALUE_TYPE', () => encodeKv([['a', null]])],
    ['KV_VALUE_RANGE', () => encodeKv([['a', -1]])],
    ['KV_TRAILING_BYTES', () => { const b = encodeKv([['a', 1]]); const c = new Uint8Array(b.length + 1); c.set(b); return decodeKv(c) }],
    ['KV_TRUNCATED', () => decodeKv(encodeKv([['a', 1]]).slice(0, 6))],
    // KV 布局：[count(4)][keyLen(1)][key][type(1)][valueLen(4)][value]
    // 单条 ['a',1] 时 type 在偏移 6（不是 5，5 是键字节）
    ['KV_TYPE_UNKNOWN', () => { const b = encodeKv([['a', 1]]); b[6] = 9; return decodeKv(b) }],
  ]
  for (const [expectedCode, fn] of cases) {
    let code = null
    try {
      fn()
    } catch (error) {
      code = error.code
    }
    assertEqual(code, expectedCode, `期望错误码 ${expectedCode}`)
  }
})

await runner.test('KV 声明超大条目数时被长度下界挡掉（不会长循环）', () => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setUint32(0, 0xffffffff)
  let code = null
  const started = Date.now()
  try {
    decodeKv(bytes)
  } catch (error) {
    code = error.code
  }
  assertEqual(code, 'KV_TRUNCATED', '超大 count 应立刻报截断')
  assertTrue(Date.now() - started < 1000, '不应耗时过久')
})

await runner.test('元数据白名单：未知键被拒绝', () => {
  const ok = decodeMetadata(encodeMetadata([['name', 'a.bin'], ['size', 3n], ['mime', 'application/octet-stream']]))
  assertEqual(ok.get('name'), 'a.bin', 'name')
  assertEqual(ok.get('size'), 3n, 'size')
  let code = null
  try {
    encodeMetadata([['evil', 1]])
  } catch (error) {
    code = error.code
  }
  assertEqual(code, 'META_KEY_UNKNOWN', '未知键错误码')
})

runner.finish()
