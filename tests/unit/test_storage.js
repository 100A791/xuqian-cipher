/**
 * 本地存储 + 目录结构/禁止事项自检 —— SPEC §2、§5 阶段六、§7。
 * 运行：node tests/unit/test_storage.js
 *
 * 这个文件里有两类测试：
 *   ① 存储模块的安全约束（绝不落库密钥）；
 *   ② **把 SPEC 的目录结构与"禁止引入第三方库"变成可自动执行的断言** ——
 *      写在文档里的约束会随时间腐化，写成测试才会一直有效。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ALLOWED_FIELDS,
  ARCHIVE_MAGIC,
  assertNoKeyMaterial,
  exportLibraryArchive,
  importLibraryArchive,
  isAvailable,
  openDatabase,
  recordId,
  validateRecord,
} from '../../src/selfcrypto/storage/indexeddb.js'
import { assertEqual, assertTrue, createRunner } from './_helpers.js'

const runner = createRunner('本地存储 + SPEC 结构/禁止事项自检')

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..', '..')
const selfDir = join(root, 'src', 'selfcrypto')

// ------------------------------------------------------------------ 结构自检

await runner.test('SPEC §2：八个子目录齐全', () => {
  const required = ['crypto', 'file', 'watermark', 'ai', 'ui', 'storage', 'common', 'third']
  const present = readdirSync(selfDir).filter((name) => statSync(join(selfDir, name)).isDirectory())
  const missing = required.filter((dir) => !present.includes(dir))
  // ui 目录按 SPEC 应存在；本项目用 React 实现同样划分（决策 D25），
  // 因此这里只要求"八个名字都在"，不要求 ui 里是原生 JS
  assertEqual(missing.length, 0, `缺少子目录：${missing.join(', ')}`)
})

await runner.test('SPEC §2：storage 目录有 indexeddb.js', () => {
  assertTrue(existsSync(join(selfDir, 'storage', 'indexeddb.js')), 'storage/indexeddb.js 必须存在')
})

await runner.test('SPEC §2：third 目录**留空**（只有说明文件，没有任何 .js）', () => {
  const files = readdirSync(join(selfDir, 'third'))
  const jsFiles = files.filter((name) => name.endsWith('.js'))
  assertEqual(jsFiles.length, 0, `third 里不该有任何 .js，实际：${jsFiles.join(', ')}`)
  assertTrue(files.includes('README.md'), 'third 应当有一份说明它为何留空的 README')
})

await runner.test('SPEC §7 红线：自研路线**零外部包 import**（机械校验，不靠人看）', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8')
        // 只看真正的 import/from，且要求来源不是相对路径（相对路径=本项目内部模块）
        for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s+'([^']+)'/g)) {
          const spec = match[1]
          if (!spec.startsWith('.')) offenders.push(`${relative(root, full)} → ${spec}`)
        }
      }
    }
  }
  walk(selfDir)
  assertEqual(offenders.length, 0, `禁止引入第三方包，发现：${offenders.join('; ')}`)
})

await runner.test('SPEC §7 红线：没有任何网络调用（纯本地）', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8')
        for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /navigator\.sendBeacon/]) {
          if (pattern.test(text)) offenders.push(`${relative(root, full)} 命中 ${pattern}`)
        }
      }
    }
  }
  walk(selfDir)
  assertEqual(offenders.length, 0, `自研路线不应有任何网络调用，发现：${offenders.join('; ')}`)
})

await runner.test('SPEC §7 红线：自研代码里不出现明文密钥存储（localStorage/sessionStorage）', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) {
        const text = readFileSync(full, 'utf8')
        if (/localStorage|sessionStorage/.test(text)) offenders.push(relative(root, full))
      }
    }
  }
  walk(selfDir)
  assertEqual(offenders.length, 0, `禁止用 localStorage/sessionStorage 存任何东西，发现：${offenders.join(', ')}`)
})

// ------------------------------------------------------------------ 存储安全

await runner.test('允许字段白名单：密钥类字段一律拒绝写入', () => {
  const base = { id: 'a', name: 'x.xuqian', bytes: Uint8Array.of(1, 2, 3), size: 3, savedAt: 1, version: 1, note: '' }
  assertNoKeyMaterial(base)
  assertTrue(true, '正常记录应通过')

  for (const field of ['key', 'keyK', 'masterKey', 'master_key', 'passphrase', 'password', 'secret', 'WK', 'watermarkKey', 'recoveryCode']) {
    let threw = false
    try {
      assertNoKeyMaterial({ ...base, [field]: 'deadbeef' })
    } catch {
      threw = true
    }
    assertTrue(threw, `字段「${field}」必须被拒绝`)
  }
})

await runner.test('嵌套对象与数组里的密钥字段也要被拒绝（不只查顶层）', () => {
  let deep = false
  try {
    assertNoKeyMaterial({ id: 'a', nested: { inner: { keyK: 'x' } } })
  } catch {
    deep = true
  }
  assertTrue(deep, '嵌套密钥字段应被拒绝')

  let inArray = false
  try {
    assertNoKeyMaterial({ id: 'a', list: [{ fine: 1 }, { passphrase: 'x' }] })
  } catch {
    inArray = true
  }
  assertTrue(inArray, '数组里的密钥字段应被拒绝')
})

await runner.test('拒绝时的报错信息**不包含字段值**（避免把疑似密钥打进日志）', () => {
  const secretValue = 'SUPER-SECRET-KEY-MATERIAL-0123456789'
  let message = ''
  try {
    assertNoKeyMaterial({ id: 'a', keyK: secretValue })
  } catch (error) {
    message = error.message
  }
  assertTrue(message.length > 0, '应当抛错')
  assertTrue(!message.includes(secretValue), '报错信息不得包含字段值')
  assertTrue(message.includes('keyK'), '但应当指出字段名，便于修正')
})

await runner.test('validateRecord：只接受非空 Uint8Array 密文 + 非空名字', () => {
  const ok = {
    id: 'a',
    name: 'secret.bin.xuqian',
    bytes: Uint8Array.of(9, 9, 9),
    size: 3,
    savedAt: 1,
    version: 1,
    note: '',
  }
  assertEqual(validateRecord(ok).name, 'secret.bin.xuqian', '正常记录')

  const cases = [
    ['空密文', { ...ok, bytes: new Uint8Array(0) }],
    ['密文不是 Uint8Array', { ...ok, bytes: 'base64-text' }],
    ['没有名字', { ...ok, name: '' }],
  ]
  for (const [label, record] of cases) {
    let threw = false
    try {
      validateRecord(record)
    } catch {
      threw = true
    }
    assertTrue(threw, `${label} 应被拒绝`)
  }
})

await runner.test('recordId：确定、随内容变化、不含密钥信息', () => {
  const a = recordId('x.bin', Uint8Array.of(1, 2, 3))
  const b = recordId('x.bin', Uint8Array.of(1, 2, 3))
  const c = recordId('x.bin', Uint8Array.of(1, 2, 4))
  assertEqual(a, b, '同样输入应得到同样的 id')
  assertTrue(a !== c, '内容不同 id 应不同')
  const record = { id: a, name: 'x.bin', bytes: Uint8Array.of(1, 2, 3), size: 3, savedAt: 1, version: 1, note: '' }
  assertNoKeyMaterial(record)
  assertTrue(true, 'id 不应引入违规字段')
})

await runner.test('ALLOWED_FIELDS 里不包含任何密钥类字段名', () => {
  const forbidden = /key|pass|secret|password|wk|recovery|seed/i
  const bad = ALLOWED_FIELDS.filter((field) => forbidden.test(field))
  assertEqual(bad.length, 0, `白名单里不该出现：${bad.join(', ')}`)
})

await runner.test('Node 环境没有 IndexedDB → 明确报错，而不是静默失败', async () => {
  // Node 24 也没有 indexedDB 全局（浏览器才有）
  assertEqual(isAvailable(), false, 'Node 里应报告不可用')
  let message = ''
  try {
    await openDatabase()
  } catch (error) {
    message = error.message
  }
  assertTrue(/IndexedDB/.test(message), `应给出明确错误，实际：${message}`)
})

// ------------------------------------------------- 整库导出 / 导入（D36）

const mkRecord = (name, bytes, savedAt = 1700000000000) => ({
  id: recordId(name, bytes),
  name,
  bytes,
  size: bytes.length,
  savedAt,
  version: 1,
  note: '',
})

await runner.test('备份：导出→导入 往返，名字/密文/时间/版本都还原', () => {
  const records = [
    mkRecord('a.bin.xuqian', Uint8Array.of(1, 2, 3)),
    mkRecord('中文名.xuqian', Uint8Array.from({ length: 300 }, (_, i) => i & 0xff), 1700000001234),
  ]
  const archive = exportLibraryArchive(records)
  assertEqual(archive[0], 0x58, 'magic 首字节应为 X')
  assertEqual(
    archive.length,
    ARCHIVE_MAGIC.length + 4 + (1 + 13 + 4 + 3 + 1 + 8) + (1 + 15 + 4 + 300 + 1 + 8),
    '总长度',
  )

  const back = importLibraryArchive(archive)
  assertEqual(back.length, 2, '条数')
  assertEqual(back[0].name, 'a.bin.xuqian', '第一条名字')
  assertEqual(back[0].bytes.join(','), '1,2,3', '第一条密文')
  assertEqual(back[1].name, '中文名.xuqian', '中文名（UTF-8）')
  assertEqual(back[1].savedAt, 1700000001234, '时间戳')
  assertEqual(back[1].version, 1, '版本')
  assertEqual(back[1].id, recordId('中文名.xuqian', records[1].bytes), 'id 应可重算（用于去重覆盖）')
})

await runner.test('备份：空库也能往返（count=0 且无尾部字节）', () => {
  const archive = exportLibraryArchive([])
  assertEqual(archive.length, ARCHIVE_MAGIC.length + 4, '只有头')
  assertEqual(importLibraryArchive(archive).length, 0, '导入 0 条')
})

await runner.test('备份：magic 不对 / 过短 / 截断 / 尾部多余 都拒绝', () => {
  const archive = exportLibraryArchive([mkRecord('x.xuqian', Uint8Array.of(9, 9))])
  const badMagic = new Uint8Array(archive)
  badMagic[0] = 0x00
  const truncated = archive.slice(0, archive.length - 1)
  const extra = new Uint8Array(archive.length + 1)
  extra.set(archive)

  const cases = [
    ['magic 不对', badMagic, /magic/],
    ['过短', new Uint8Array(4), /过短/],
    ['截断', truncated, /损坏|越界/],
    ['尾部多余', extra, /多余/],
  ]
  for (const [label, bytes, pattern] of cases) {
    let message = ''
    try {
      importLibraryArchive(bytes)
    } catch (error) {
      message = error.message
    }
    assertTrue(pattern.test(message), `${label} 应被拒绝，实际信息：${message}`)
  }
})

await runner.test('备份：导出时同样受"无密钥字段"白名单约束（不能靠导出绕过）', () => {
  let threw = false
  try {
    exportLibraryArchive([{ ...mkRecord('x.xuqian', Uint8Array.of(1)), masterKey: 'deadbeef' }])
  } catch {
    threw = true
  }
  assertTrue(threw, '带密钥字段的记录不得被导出')
})

await runner.test('备份：内容仍是密文二进制（不被 base64/文本化）', () => {
  const payload = Uint8Array.from([0x00, 0xff, 0x80, 0x7f, 0x0a])
  const archive = exportLibraryArchive([mkRecord('b.xuqian', payload)])
  let found = false
  for (let i = 0; i + payload.length <= archive.length; i++) {
    if (payload.every((v, k) => archive[i + k] === v)) {
      found = true
      break
    }
  }
  assertTrue(found, '归档里应包含原始密文字节')
  assertTrue(!Buffer.from(archive).toString('latin1').includes('AP+A'), '不应出现 base64 形态')
})

await runner.test('备份：非 Uint8Array / 非数组参数被拒绝', () => {
  let a = false
  let b = false
  try {
    importLibraryArchive('not bytes')
  } catch {
    a = true
  }
  try {
    exportLibraryArchive('not array')
  } catch {
    b = true
  }
  assertTrue(a && b, '参数类型错误都应抛错')
})

runner.finish()
