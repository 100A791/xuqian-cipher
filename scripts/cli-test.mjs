/**
 * XUQIAN 命令行工具测试。
 *
 * 覆盖：密钥生成（含密码保护）、5 种算法、1~10 层、空文件、多分块、gzip、
 * 错误密钥、inspect / verify、拒绝覆盖、stdin 管道、目录输入、篡改检测、字节级一致性。
 *
 * 用法：node scripts/cli-test.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const ROOT = process.cwd()
const CLI = join(ROOT, 'cli', 'xuqian.ts')
const work = mkdtempSync(join(tmpdir(), 'xuqian-cli-'))
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 子进程是否曾启动失败（例如受限环境返回 EBUSY/EPERM）——与"用例失败"是两回事。 */
let spawnFailure = null

/** 运行 CLI；stdout/stderr 分开返回，不因非零退出码抛错。 */
function xuqian(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? work,
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.error) {
    // 关键：区分"子进程根本没起来"和"子进程跑了但断言不通过"。
    // 受限环境（沙箱、权限策略）会让 spawnSync 直接返回 error，此时 stdout 为空，
    // 若不特判就会把整轮测试误报成"全部用例失败"。
    if (!spawnFailure) {
      spawnFailure = result.error
      console.error(`\n[环境问题] 无法启动 CLI 子进程：${result.error.code ?? result.error.message}`)
      console.error('  这表示当前环境禁止派生 Node 子进程，并非用例本身失败。')
      console.error('  请在普通终端重跑：pnpm test:cli\n')
    }
    return { status: 127, stdout: '', stderr: `spawn failed: ${result.error.code ?? result.error.message}` }
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 每个用例一个独立目录，避免"解密输出与输入同名"这类冲突干扰断言。 */
let caseIndex = 0
function freshDir(label) {
  const dir = join(work, `case-${String(++caseIndex).padStart(2, '0')}-${label}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeFile(path, size, seed = 1, { incompressible = false } = {}) {
  const buffer = incompressible ? randomBytes(size) : Buffer.alloc(size)
  if (!incompressible) for (let i = 0; i < size; i++) buffer[i] = (i * 73 + seed * 19) & 0xff
  writeFileSync(path, buffer)
  return buffer
}

const sha = (path) => readFileSync(path).toString('base64')

/** 读取 .XUQIAN 开头的明文声明前导区（不需要密钥）。 */
function readPreambleOf(path) {
  const buf = readFileSync(path)
  if (buf.length < 11) return null
  if (buf.subarray(0, 6).toString('latin1') !== 'XUQIAN') return null
  const marker = buf[6]
  if (marker !== 2) return { marker, noticeText: '', noticeBytes: 0 }
  const len = buf.readUInt32BE(7)
  const noticeBytes = buf.subarray(11, 11 + len)
  return { marker, noticeText: noticeBytes.toString('utf8'), noticeBytes: len, containerOffset: 11 + len }
}

try {
  console.log(`工作目录: ${work}\n`)

  // ---------- 1. 帮助与版本 ----------
  {
    const version = xuqian(['--version'])
    check('--version 输出版本', version.status === 0 && /xuqian \d/.test(version.stdout), version.stdout.trim())
    const help = xuqian(['--help'])
    check('--help 输出用法与算法表', /用法:/.test(help.stderr) && /AES-128-GCM/.test(help.stderr))
    const unknown = xuqian(['nope'])
    check('未知命令报错', unknown.status !== 0 && /未知命令/.test(unknown.stderr))
  }

  // ---------- 2. keygen ----------
  const keysDir = freshDir('keys')
  const keyFile = join(keysDir, 'backup.XUQIANKEY')
  {
    const result = xuqian(['keygen', '-o', keyFile])
    const text = existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : ''
    check('keygen -o 写出密钥文件', result.status === 0 && text.includes('XUQIANKEY'), `${text.length} 字节`)
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* 忽略 */
    }
    check('密钥文件 protected=false 且指纹为 16 位 Hex', parsed?.protected === false && /^[0-9A-F]{16}$/.test(parsed?.fingerprint ?? ''), parsed?.fingerprint)
    const again = xuqian(['keygen', '-o', keyFile])
    check('默认拒绝覆盖已存在密钥文件', again.status !== 0 && /已存在/.test(again.stderr))
    const forced = xuqian(['keygen', '-o', keyFile, '--force'])
    check('--force 允许覆盖', forced.status === 0)
  }
  const keyHex = JSON.parse(readFileSync(keyFile, 'utf8')).keyHex
  check('密钥文件内含 32 位 Hex', /^[0-9A-Fa-f]{32}$/.test(keyHex), `${keyHex.slice(0, 8)}…`)

  // ---------- 3. 密码保护的密钥文件（非交互） ----------
  const protectedFile = join(keysDir, 'protected.XUQIANKEY')
  {
    const built = xuqian(['keygen', '-o', protectedFile, '--keyfile-password', 'cli-test-pass'])
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(protectedFile, 'utf8'))
    } catch {
      /* 忽略 */
    }
    check('keygen --keyfile-password 产出密码保护密钥文件', built.status === 0 && parsed?.protected === true)
  }

  // ---------- 4. 单层往返 + 5 种算法 ----------
  const algos = ['AES-128-GCM', 'AES-256-GCM', 'CHACHA20-POLY1305', 'XCHACHA20-POLY1305', 'SM4-GCM']
  const sampleDir = freshDir('sample')
  const sample = join(sampleDir, 'sample.bin')
  const sampleBytes = makeFile(sample, 120_000, 7)
  for (const algo of algos) {
    const dir = freshDir(`algo-${algo}`)
    const input = join(dir, 'sample.bin')
    makeFile(input, 120_000, 7)
    const enc = xuqian(['encrypt', input, '--layers', algo, '--keyfile', keyFile, '--out', dir, '--quiet'])
    const cipher = join(dir, 'sample.bin.XUQIAN')
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', cipher, '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'sample.bin')
    const same = existsSync(restored) && sha(restored) === sampleBytes.toString('base64')
    check(`${algo} 往返字节一致`, enc.status === 0 && dec.status === 0 && same, `${same ? statSync(restored).size : 0} 字节`)
  }

  // ---------- 5. 多层 + 多分块 + gzip ----------
  {
    const dir = freshDir('multi')
    const input = join(dir, 'sample.bin')
    // 不可压缩数据：确保 64K 分块下真的产生多块（压缩会把小块压进一块）
    makeFile(input, 300_000, 9, { incompressible: true })
    const layers = 'AES-256-GCM,CHACHA20-POLY1305,SM4-GCM'
    const enc = xuqian(['encrypt', input, '--layers', layers, '--chunk-size', '64K', '--keyfile', keyFile, '--out', dir, '--quiet'])
    const cipher = join(dir, 'sample.bin.XUQIAN')
    check('三层 + 64K 分块加密成功', enc.status === 0 && existsSync(cipher), `${existsSync(cipher) ? statSync(cipher).size : 0} 字节`)

    const inspect = xuqian(['inspect', cipher, '--json'])
    let header = null
    try {
      header = JSON.parse(inspect.stdout)[0].header
    } catch {
      /* 忽略 */
    }
    check('inspect --json 可解析头部', header !== null && header.lc === 3, header ? `lc=${header.lc} cc=${header.cc}` : inspect.stderr.slice(0, 120))
    check('多分块：chunkCount > 1', (header?.cc ?? 0) > 1, `cc=${header?.cc}`)
    check('算法顺序与命令行一致', header?.layers?.map((l) => l.a).join(',') === layers)
    check('未启用 gzip 时 flags 无 gzip 位', (header?.flags & 2) === 0, `flags=${header?.flags}`)

    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', cipher, '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'sample.bin')
    check('多分块多层解密字节一致', dec.status === 0 && existsSync(restored) && sha(restored) === readFileSync(input).toString('base64'))
  }

  // ---------- 6b. 元数据加密（--encrypt-meta）----------
  {
    const dir = freshDir('encmeta')
    const secretName = '2026个税申报-张三.txt'
    const input = join(dir, secretName)
    writeFileSync(input, Buffer.from('confidential payload', 'utf8'))
    const enc = xuqian(['encrypt', input, '--layers', 'AES-128-GCM', '--encrypt-meta', '--keyfile', keyFile, '--out', dir, '--quiet'])
    const cipher = join(dir, `${secretName}.XUQIAN`)
    const raw = readFileSync(cipher)
    const headText = raw.subarray(0, 1200).toString('latin1')
    const header = JSON.parse(xuqian(['inspect', cipher, '--json']).stdout)[0].header
    check(
      '加密元数据：原文件名不出现在明文文件头',
      enc.status === 0 && !headText.includes('个税') && !headText.includes('张三'),
      headText.includes('个税') ? '仍可见原文件名' : '不可见',
    )
    check('加密元数据：头部带 enc-meta 标志位', (header.flags & 4) === 4, `flags=${header.flags}`)
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', cipher, '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, secretName)
    check('加密元数据：解密后原名还原且字节一致', dec.status === 0 && existsSync(restored) && readFileSync(restored).equals(readFileSync(input)))
  }

  // ---------- 6. gzip 往返（大文本可压缩） ----------
  {
    const dir = freshDir('gzip')
    const input = join(dir, 'text.txt')
    const payload = Buffer.from('这是一段可以压缩的文本。'.repeat(20_000), 'utf8')
    writeFileSync(input, payload)
    const enc = xuqian(['encrypt', input, '--gzip', '--keyfile', keyFile, '--out', dir, '--quiet'])
    const cipher = join(dir, 'text.txt.XUQIAN')
    const header = JSON.parse(xuqian(['inspect', cipher, '--json']).stdout)[0].header
    const smaller = statSync(cipher).size < payload.length / 2
    check('gzip 显著缩小密文体积', enc.status === 0 && smaller, `${payload.length} → ${statSync(cipher).size} 字节`)
    check('gzip 标志位与原始大小写入头部', (header.flags & 2) === 2 && header.meta.os === payload.length, `flags=${header.flags} os=${header.meta.os}`)
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', cipher, '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'text.txt')
    check('gzip 解密还原原文', dec.status === 0 && existsSync(restored) && readFileSync(restored).equals(payload))
  }

  // ---------- 7. 空文件 ----------
  {
    const dir = freshDir('empty')
    const empty = join(dir, 'empty.bin')
    writeFileSync(empty, Buffer.alloc(0))
    const enc = xuqian(['encrypt', empty, '--keyfile', keyFile, '--out', dir, '--quiet'])
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', join(dir, 'empty.bin.XUQIAN'), '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'empty.bin')
    check('空文件往返（0 字节）', enc.status === 0 && dec.status === 0 && existsSync(restored) && statSync(restored).size === 0)
  }

  // ---------- 8. 层数边界 ----------
  {
    const dir = freshDir('layers')
    const input = join(dir, 'small.bin')
    const bytes = makeFile(input, 5000, 3)
    const ten = Array.from({ length: 10 }, () => 'AES-128-GCM').join(',')
    const enc = xuqian(['encrypt', input, '--layers', ten, '--keyfile', keyFile, '--out', dir, '--quiet'])
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', join(dir, 'small.bin.XUQIAN'), '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'small.bin')
    check('10 层加密解密一致', enc.status === 0 && dec.status === 0 && existsSync(restored) && sha(restored) === bytes.toString('base64'))
    const eleven = xuqian(['encrypt', input, '--layers', `${ten},AES-128-GCM`, '--keyfile', keyFile, '--out', freshDir('layers11'), '--quiet'])
    check('11 层被拒绝', eleven.status !== 0 && /层数必须/.test(eleven.stderr))
  }

  // ---------- 9. 错误密钥 / verify ----------
  {
    const dir = freshDir('wrongkey')
    const input = join(dir, 'sample.bin')
    makeFile(input, 20_000, 11)
    xuqian(['encrypt', input, '--layers', 'AES-256-GCM', '--keyfile', keyFile, '--out', dir, '--quiet'])
    const cipher = join(dir, 'sample.bin.XUQIAN')
    const wrong = xuqian(['decrypt', cipher, '--key', '00000000000000000000000000000000', '--out', join(dir, 'dec'), '--quiet'])
    check('错误密钥解密失败且提示统一', wrong.status !== 0 && /密钥错误或文件损坏/.test(wrong.stderr), wrong.stderr.trim().split('\n').pop())
    check('错误密钥不留下半成品输出', !existsSync(join(dir, 'dec', 'sample.bin')))
    const verifyBad = xuqian(['verify', cipher, '--key', '00000000000000000000000000000000', '--quiet'])
    check('verify 错误密钥输出 MISMATCH', /MISMATCH/.test(verifyBad.stdout) && verifyBad.status !== 0)
    const verifyGood = xuqian(['verify', cipher, '--keyfile', keyFile, '--quiet'])
    check('verify 正确密钥输出 MATCH', /MATCH/.test(verifyGood.stdout) && verifyGood.status === 0, verifyGood.stderr.trim().split('\n').pop())
  }

  // ---------- 10. 密码保护密钥文件解密 ----------
  {
    const dir = freshDir('protected')
    const input = join(dir, 'sample.bin')
    const bytes = makeFile(input, 30_000, 13)
    // 必须用同一把密钥加解密：这里统一使用密码保护的密钥文件
    const enc = xuqian([
      'encrypt',
      input,
      '--keyfile',
      protectedFile,
      '--keyfile-password',
      'cli-test-pass',
      '--out',
      dir,
      '--quiet',
    ])
    check('用密码保护密钥文件加密', enc.status === 0, enc.stderr.trim().split('\n').pop())
    const cipher = join(dir, 'sample.bin.XUQIAN')
    const decDir = join(dir, 'dec')
    const ok = xuqian(['decrypt', cipher, '--keyfile', protectedFile, '--keyfile-password', 'cli-test-pass', '--out', decDir, '--quiet'])
    check(
      '密码保护密钥文件解密成功',
      ok.status === 0 && existsSync(join(decDir, 'sample.bin')) && sha(join(decDir, 'sample.bin')) === bytes.toString('base64'),
      ok.stderr.trim().split('\n').pop(),
    )
    const bad = xuqian(['decrypt', cipher, '--keyfile', protectedFile, '--keyfile-password', 'wrong-pass', '--out', join(dir, 'dec2'), '--quiet'])
    check('错误密码被拒绝', bad.status !== 0 && /密码错误|KEYFILE_PASSWORD_WRONG/.test(bad.stderr), bad.stderr.trim().split('\n').pop())
    const missing = xuqian(['decrypt', cipher, '--keyfile', protectedFile, '--out', join(dir, 'dec3'), '--quiet'])
    check(
      '缺少密码时明确报错（非交互环境不会静默失败）',
      missing.status !== 0 && /密码/.test(missing.stderr),
      missing.stderr.trim().split('\n').pop(),
    )
  }

  // ---------- 11. 环境变量取密钥 ----------
  {
    const dir = freshDir('env')
    const input = join(dir, 'sample.bin')
    const bytes = makeFile(input, 15_000, 17)
    xuqian(['encrypt', input, '--layers', 'AES-128-GCM', '--keyfile', keyFile, '--out', dir, '--quiet'])
    const decDir = join(dir, 'dec')
    const viaEnv = xuqian(['decrypt', join(dir, 'sample.bin.XUQIAN'), '--out', decDir, '--quiet'], { env: { XUQIAN_KEY: keyHex } })
    check('环境变量 XUQIAN_KEY 可用', viaEnv.status === 0 && sha(join(decDir, 'sample.bin')) === bytes.toString('base64'))
  }

  // ---------- 12. stdin 管道 ----------
  {
    const dir = freshDir('stdin')
    const payload = Buffer.from('通过 stdin 传入的内容：hello xuqian cli\n', 'utf8')
    const enc = xuqian(['encrypt', '-', '--keyfile', keyFile, '--out', dir, '--quiet'], { input: payload })
    const cipher = join(dir, 'stdin.bin.XUQIAN')
    check('stdin 加密产出 .XUQIAN', enc.status === 0 && existsSync(cipher), `${existsSync(cipher) ? statSync(cipher).size : 0} 字节`)
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', cipher, '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'stdin.bin')
    check('stdin 内容往返一致', dec.status === 0 && existsSync(restored) && readFileSync(restored).equals(payload))
  }

  // ---------- 13. 目录输入 ----------
  {
    const dir = freshDir('dir-input')
    const srcDir = join(dir, 'many')
    mkdirSync(srcDir, { recursive: true })
    const originals = new Map()
    for (let i = 0; i < 3; i++) {
      const path = join(srcDir, `f${i}.bin`)
      originals.set(`f${i}.bin`, makeFile(path, 1000 + i * 111, i).toString('base64'))
    }
    const outDir = join(dir, 'out')
    const enc = xuqian(['encrypt', srcDir, '--keyfile', keyFile, '--out', outDir, '--quiet'])
    const produced = ['f0.bin.XUQIAN', 'f1.bin.XUQIAN', 'f2.bin.XUQIAN'].every((n) => existsSync(join(outDir, n)))
    check('目录输入批量加密', enc.status === 0 && produced)
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', outDir, '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const allSame = [...originals].every(([name, b64]) => sha(join(decDir, name)) === b64)
    check('目录批量解密全部字节一致', dec.status === 0 && allSame)
  }

  // ---------- 14. 篡改检测 ----------
  {
    const dir = freshDir('tamper')
    const input = join(dir, 'sample.bin')
    makeFile(input, 40_000, 19)
    xuqian(['encrypt', input, '--layers', 'AES-256-GCM,SM4-GCM', '--keyfile', keyFile, '--out', dir, '--quiet'])
    const cipher = join(dir, 'sample.bin.XUQIAN')
    const bytes = Buffer.from(readFileSync(cipher))
    bytes[Math.floor(bytes.length / 2)] ^= 0x01
    const tampered = join(dir, 'tampered.XUQIAN')
    writeFileSync(tampered, bytes)
    const dec = xuqian(['decrypt', tampered, '--keyfile', keyFile, '--out', join(dir, 'dec'), '--quiet'])
    check('篡改后的密文解密失败', dec.status !== 0 && /密钥错误或文件损坏/.test(dec.stderr))
  }

  // ---------- 15. 非 .XUQIAN 与 --check-only ----------
  {
    const dir = freshDir('misc')
    const bogus = join(dir, 'bogus.XUQIAN')
    writeFileSync(bogus, '这不是加密文件')
    const insp = xuqian(['inspect', bogus])
    check('inspect 拒绝非 .XUQIAN 文件', insp.status !== 0 && /无法解析/.test(insp.stderr))

    const input = join(dir, 'sample.bin')
    makeFile(input, 25_000, 23)
    xuqian(['encrypt', input, '--keyfile', keyFile, '--out', dir, '--quiet'])
    const checkDir = join(dir, 'check')
    const res = xuqian(['decrypt', join(dir, 'sample.bin.XUQIAN'), '--keyfile', keyFile, '--check-only', '--out', checkDir, '--quiet'])
    check('--check-only 校验通过且不写文件', res.status === 0 && !existsSync(join(checkDir, 'sample.bin')))

    // 单独用一个目录：先成功写一次，再确认默认拒绝覆盖，最后确认 --force 放行
    const againDir = join(dir, 'overwrite')
    const first = xuqian(['decrypt', join(dir, 'sample.bin.XUQIAN'), '--keyfile', keyFile, '--out', againDir, '--quiet'])
    const again = xuqian(['decrypt', join(dir, 'sample.bin.XUQIAN'), '--keyfile', keyFile, '--out', againDir, '--quiet'])
    const forced = xuqian(['decrypt', join(dir, 'sample.bin.XUQIAN'), '--keyfile', keyFile, '--out', againDir, '--quiet', '--force'])
    check(
      '输出已存在时默认拒绝、--force 放行',
      first.status === 0 && again.status !== 0 && /已存在/.test(again.stderr) && forced.status === 0,
      `first=${first.status} again=${again.status} forced=${forced.status} · ${again.stderr.trim().split('\n').pop()}`,
    )
  }

  // ---------- 16. 加密声明（banner）：前置 → 头部记录 → 解密剥离 ----------
  {
    const dir = freshDir('banner')
    const input = join(dir, 'report.bin')
    const original = makeFile(input, 40_000, 29)
    const customNotice = '本文件由 XX 公司加密保存\n未经许可不得外传\n联系电话 400-000-0000'

    const enc = xuqian([
      'encrypt',
      input,
      '--layers',
      'AES-256-GCM',
      '--notice',
      customNotice,
      '--keyfile',
      keyFile,
      '--out',
      dir,
      '--quiet',
    ])
    const cipher = join(dir, 'report.bin.XUQIAN')
    check('CLI 加密成功（含自定义声明）', enc.status === 0 && existsSync(cipher), enc.stderr.trim().split('\n').pop() ?? '')

    // 头部应记录声明长度与文本，且**不需要密钥**就能读到
    // 明文声明必须位于**文件最开头**，且不需要密钥就能读到
    const header = JSON.parse(xuqian(['inspect', cipher, '--json']).stdout)[0].header
    const preamble = readPreambleOf(cipher)
    const expectedBytes = Buffer.byteLength(customNotice, 'utf8')
    check('明文声明位于文件最开头（标记字节 + 长度）', preamble !== null && preamble.marker === 2, `marker=${preamble?.marker}`)
    check('声明正文与命令行给的一致', preamble?.noticeText === customNotice, `${preamble?.noticeBytes} 字节 / 期望 ${expectedBytes}`)
    check(
      '容器头部记录了声明的长度与 SHA-256（参与认证）',
      header.meta.nl === expectedBytes && /^[0-9A-F]{64}$/.test(header.meta.nh ?? ''),
      `nl=${header.meta.nl} nh=${String(header.meta.nh).slice(0, 12)}…`,
    )

    // inspect（不需要密钥）也应把明文声明打出来
    const readable = xuqian(['inspect', cipher]).stdout
    check('inspect 无需密钥即可输出声明内容', readable.includes('未经许可不得外传') && /明文声明/.test(readable))

    // 解密：容器从声明区之后开始，还原必须字节一致
    const decDir = join(dir, 'dec')
    const dec = xuqian(['decrypt', cipher, '--keyfile', keyFile, '--out', decDir, '--quiet'])
    const restored = join(decDir, 'report.bin')
    check('解密（跳过明文声明区后解容器）还原字节一致', dec.status === 0 && existsSync(restored) && readFileSync(restored).equals(original))
    check('解密输出不残留声明文本', dec.status === 0 && existsSync(restored) && !readFileSync(restored).toString('latin1').includes('未经许可不得外传'))
    check('解密过程报告已校验明文声明', new RegExp(`明文声明 ${expectedBytes} 字节`).test(dec.stderr), dec.stderr.split('\n').find((l) => l.includes('明文声明')) ?? '')

    // 未指定 --notice → 仍写入默认声明（"不写声明"不是可选项）
    const dir2 = freshDir('banner-default')
    const input2 = join(dir2, 'plain.bin')
    makeFile(input2, 1000, 31)
    xuqian(['encrypt', input2, '--key', keyHex, '--out', dir2, '--quiet'])
    const defaultPreamble = readPreambleOf(join(dir2, 'plain.bin.XUQIAN'))
    check(
      '未指定声明时写入默认声明（不可省略）',
      defaultPreamble !== null && defaultPreamble.noticeBytes > 0 && /XUQIAN/.test(defaultPreamble.noticeText),
      `${defaultPreamble?.noticeBytes} 字节`,
    )

    // 空字符串 / 纯空白也回退默认
    xuqian(['encrypt', input2, '--key', keyHex, '--notice', '   ', '--out', dir2, '--force', '--quiet'])
    const blankPreamble = readPreambleOf(join(dir2, 'plain.bin.XUQIAN'))
    check('声明留空/纯空白时回退默认（无法借此去掉声明）', blankPreamble !== null && /XUQIAN/.test(blankPreamble.noticeText))

    // 改动**明文声明**的任意一个字节 → 必须拒绝解密（哈希与头部记录不符）
    const tamperPlain = join(dir, 'tamper-notice.XUQIAN')
    const rawPlain = Buffer.from(readFileSync(cipher))
    const noticeStart = 11
    rawPlain[noticeStart + 3] ^= 0x01
    writeFileSync(tamperPlain, rawPlain)
    const tamperPlainDec = xuqian(['decrypt', tamperPlain, '--keyfile', keyFile, '--out', join(dir, 'dec-bad1'), '--quiet'])
    check(
      '改动明文声明 → 拒绝解密',
      tamperPlainDec.status !== 0 && /声明已被改动/.test(tamperPlainDec.stderr),
      tamperPlainDec.stderr.trim().split('\n').pop() ?? '',
    )

    // 删掉整个明文声明区 → 也必须拒绝解密（头部 nh 声称它应当存在）
    const tamperNoNotice = join(dir, 'no-notice.XUQIAN')
    writeFileSync(tamperNoNotice, Buffer.from(readFileSync(cipher)).subarray(11 + expectedBytes))
    const missingDec = xuqian(['decrypt', tamperNoNotice, '--keyfile', keyFile, '--out', join(dir, 'dec-bad2'), '--quiet'])
    check(
      '删除明文声明区 → 拒绝解密',
      missingDec.status !== 0 && /声明区已被删除/.test(missingDec.stderr),
      missingDec.stderr.trim().split('\n').pop() ?? '',
    )
  }
} catch (error) {
  check('CLI 测试流程未抛异常', false, error.message)
} finally {
  const passed = results.filter((r) => r.ok).length
  console.log(`\n合计 ${results.length} 项，通过 ${passed} 项，失败 ${results.length - passed} 项`)
  if (passed !== results.length) {
    if (spawnFailure && passed === 0) {
      // 全部失败且从未成功启动过子进程 → 是环境问题，别让人误以为 CLI 坏了
      console.log(`注意：本轮失败全部由「子进程无法启动」导致（${spawnFailure.code ?? spawnFailure.message}），`)
      console.log('      不是用例失败。请在有权限派生子进程的普通终端重跑。')
    } else {
      console.log('失败项：')
      for (const r of results.filter((x) => !x.ok)) console.log(` - ${r.name} (${r.detail})`)
    }
    process.exitCode = 1
  }
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}
