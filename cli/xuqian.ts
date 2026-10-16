#!/usr/bin/env node
/**
 * XUQIAN 命令行工具 —— 与网站共用同一套加密实现（src/crypto/*）。
 *
 * 为什么能共用：Node ≥ 20 提供 globalThis.crypto.subtle（AES-GCM / PBKDF2 / SHA-256），
 * 其余算法（ChaCha20 / XChaCha20 / SM4）本来就是纯 JS 实现。所以产出与浏览器
 * 产物使用完全相同的 .XUQIAN 格式，可双向互解（见 scripts/interop-test.mjs）。
 *
 * 运行方式（package.json 的 bin 指向**启动器** cli/xuqian.mjs，不是这个 .ts）：
 *   pnpm xuqian --help
 *   node cli/xuqian.ts --help            # Node ≥ 23.6（类型擦除默认开）
 *   npx tsx cli/xuqian.ts --help         # 更老的 Node
 *
 * 为什么要启动器：`.ts` 不能直接当 bin —— Node 20 会抛一句看不懂的
 * `Unknown file extension ".ts"`。启动器按 Node 版本分三条路（直跑 / 自动加旗标重启 / 给可执行的提示）。
 *
 * 约定：
 * - 进度与提示写 stderr，机器可读结果写 stdout（便于管道）。
 * - 没有 --force 时绝不覆盖已存在文件；失败时删掉半成品输出。
 * - 密钥只来自 --key / --keyfile / 环境变量 XUQIAN_KEY / TTY 交互，绝不写日志。
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { open, readFile, stat, writeFile } from 'node:fs/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  DEFAULT_CHUNK_SIZE,
  EXT_ENCRYPTED,
  MAX_LAYERS,
  MIN_LAYERS,
  describeHeader,
  encryptedFileName,
  parseHeader,
  originalFileName,
  type XuqianHeader,
} from '../src/crypto/container.ts'
import { ALL_ALGO_IDS, isAlgoId, type AlgoId } from '../src/crypto/aead.ts'
import { MasterKey, MASTER_KEY_BYTES } from '../src/crypto/keys.ts'
import {
  KEYFILE_WARNING,
  buildPlainKeyFile,
  buildProtectedKeyFile,
  masterKeyFromPayload,
  parseKeyFile,
  payloadFromBytes,
  serializeKeyFile,
} from '../src/crypto/keyfile.ts'
import {
  ByteQueue,
  decryptStream,
  encryptStream,
  keyCheck,
  type ByteSink,
  type ByteSource,
} from '../src/crypto/stream.ts'
import {
  bannerSkippingSink,
  buildPreamble,
  defaultBanner,
  normalizeBannerText,
  noticeExpectation,
  noticeHash,
  readPreamble,
  skippingSource,
} from '../src/crypto/banner.ts'
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '../src/crypto/encoding.ts'
import { copyBytes, zeroize } from '../src/crypto/zeroize.ts'

export const CLI_VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// 输出与错误
// ---------------------------------------------------------------------------

const out = (text) => process.stdout.write(`${text}\n`)
const info = (text) => process.stderr.write(`${text}\n`)

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

function usage() {
  process.stderr.write(`XUQIAN 加密站命令行工具 v${CLI_VERSION}

用法:
  xuqian keygen  [-o <密钥文件>] [--password] [--note "说明"]
  xuqian encrypt <输入...> [--layers <算法列表>] [--chunk-size <大小>] [--gzip] [--encrypt-meta] [--timestamp-salt] [--out <目录>]
                          [--note "说明"] [--expires <ISO时间>] [--key <hex> | --keyfile <文件>] [--password]
  xuqian decrypt <输入...> [--key <hex> | --keyfile <文件>] [--password] [--out <目录>] [--check-only]
  xuqian inspect <输入...> [--json]
  xuqian verify  <输入>   [--key <hex> | --keyfile <文件>] [--password]

通用选项:
  -o, --out <路径>   输出文件（keygen）或输出目录（encrypt/decrypt）
  --force            允许覆盖已存在的输出文件
  --json             以 JSON 输出结果
  --quiet            不打印进度
  -h, --help         显示本帮助
  -v, --version      显示版本

算法: ${ALL_ALGO_IDS.join(' , ')}
层数: ${MIN_LAYERS}~${MAX_LAYERS}（默认单层 AES-128-GCM）
分块: 支持 64K / 4M / 64M 这类写法（默认 ${DEFAULT_CHUNK_SIZE / 1024 / 1024}M）

示例:
  xuqian keygen -o backup.XUQIANKEY
  xuqian encrypt secret.pdf --layers AES-256-GCM,SM4-GCM --gzip --keyfile backup.XUQIANKEY
  xuqian decrypt secret.pdf.XUQIAN --keyfile backup.XUQIANKEY
  xuqian inspect secret.pdf.XUQIAN
  xuqian verify secret.pdf.XUQIAN --keyfile backup.XUQIANKEY
`)
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  layers: { type: 'string' },
  'chunk-size': { type: 'string' },
  gzip: { type: 'boolean', default: false },
  'encrypt-meta': { type: 'boolean', default: false },
  'timestamp-salt': { type: 'boolean', default: false },
  note: { type: 'string' },
  notice: { type: 'string' },
  expires: { type: 'string' },
  key: { type: 'string' },
  keyfile: { type: 'string' },
  password: { type: 'boolean', default: false },
  'keyfile-password': { type: 'string' },
  force: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  'check-only': { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
}

export function parseCli(argv) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new CliError(`${error.message}\n\n运行 xuqian --help 查看用法`)
  }
}

/** 解析 "64K" / "4M" / "64M" / 纯数字。 */
export function parseSize(text) {
  const match = /^(\d+)\s*([KMG]?)B?$/i.exec(String(text).trim())
  if (!match) throw new CliError(`无法识别的分块大小: ${text}`)
  const value = Number(match[1])
  const unit = match[2].toUpperCase()
  const multiplier = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : 1
  const size = value * multiplier
  if (!Number.isSafeInteger(size) || size < 64) throw new CliError(`分块大小过小或非法: ${text}`)
  return size
}

export function parseLayers(text) {
  const parts = String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length < MIN_LAYERS || parts.length > MAX_LAYERS) {
    throw new CliError(`层数必须在 ${MIN_LAYERS}~${MAX_LAYERS} 之间，当前 ${parts.length}`)
  }
  for (const part of parts) {
    if (!isAlgoId(part)) throw new CliError(`不支持的算法: ${part}（可选: ${ALL_ALGO_IDS.join(', ')}）`)
  }
  return parts as AlgoId[]
}

// ---------------------------------------------------------------------------
// 密钥获取
// ---------------------------------------------------------------------------

/** 从 TTY 读取输入（不回显）。 */
export async function promptSecret(question) {
  if (!process.stdin.isTTY) throw new CliError(`${question}：非交互环境请改用 --key / --keyfile / XUQIAN_KEY`)
  process.stderr.write(question)
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  if (stdin.setRawMode) stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolvePromise) => {
    const chars = []
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stderr.write('\n')
          resolvePromise(chars.join(''))
          return
        }
        if (ch === '\u0003') {
          process.stderr.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          chars.pop()
          continue
        }
        chars.push(ch)
      }
    }
    stdin.on('data', onData)
  })
}

/** 把用户输入的密钥文本解析成主密钥（自动识别 Hex / Base64）。 */
export function masterKeyFromText(text) {
  const trimmed = String(text).replace(/[\s:]/g, '')
  let bytes
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    bytes = hexToBytes(trimmed)
  } else {
    try {
      bytes = base64ToBytes(trimmed)
    } catch {
      throw new CliError('密钥必须是 32 位 Hex 或 24 位 Base64')
    }
  }
  if (bytes.length !== MASTER_KEY_BYTES) {
    zeroize(bytes)
    throw new CliError('密钥长度不是 128 位（16 字节）')
  }
  try {
    return MasterKey.fromBytes(bytes)
  } finally {
    zeroize(bytes)
  }
}

/**
 * 取得主密钥。
 * 优先级：--key > --keyfile > 环境变量 XUQIAN_KEY > TTY 交互。
 */
export async function resolveMasterKey(values) {
  if (values.key) return masterKeyFromText(values.key)

  if (values.keyfile) {
    const text = await readFile(values.keyfile, 'utf8')
    const password = values['keyfile-password'] ?? (values.password ? await promptSecret('密钥文件密码: ') : undefined)
    const payload = await parseKeyFile(text, password || undefined)
    return masterKeyFromPayload(payload)
  }

  if (process.env.XUQIAN_KEY) return masterKeyFromText(process.env.XUQIAN_KEY)

  const entered = await promptSecret('请输入 128 位密钥（Hex 或 Base64）: ')
  if (!entered.trim()) throw new CliError('未提供密钥')
  return masterKeyFromText(entered.trim())
}

// ---------------------------------------------------------------------------
// 字节源 / 汇
// ---------------------------------------------------------------------------

/**
 * 文件字节源：可重复迭代（每次重新打开读流），加密的两遍遍历都靠它。
 * `start` 用于跳过明文声明前导区，直接从加密容器开始读。
 */
export function fileSource(path: string, start = 0) {
  return {
    async *[Symbol.asyncIterator]() {
      const stream = createReadStream(path, { highWaterMark: 1 << 20, ...(start > 0 ? { start } : {}) })
      try {
        for await (const chunk of stream) yield new Uint8Array(chunk)
      } finally {
        stream.destroy()
      }
    },
  } as ByteSource
}

/**
 * 先把明文声明前导区写出去，再转发后续的容器字节。
 * 对应要求的顺序：**先加密内容，再把明文声明加在最前面**。
 */
export function preambleFirstSink(preamble: Uint8Array, sink: ByteSink): ByteSink {
  let written = false
  return {
    async write(chunk) {
      if (!written) {
        written = true
        await sink.write(preamble)
      }
      await sink.write(chunk)
    },
  }
}

/** 把 stdin 落成临时文件（加密需两遍遍历，stdin 不可重读）。 */
export async function spillStdinToTemp() {
  const path = join(tmpdir(), `xuqian-stdin-${process.pid}-${Date.now()}.bin`)
  await pipeline(process.stdin, createWriteStream(path, { mode: 0o600 }))
  return { path, size: (await stat(path)).size, cleanup: () => safeUnlink(path) }
}

/** gzip 到临时文件，返回压缩后大小（头部 meta.s 需要它）。 */
export async function gzipToTemp(sourcePath) {
  const path = join(tmpdir(), `xuqian-gz-${process.pid}-${Date.now()}.gz`)
  await pipeline(createReadStream(sourcePath), createGzip({ level: 6 }), createWriteStream(path, { mode: 0o600 }))
  return { path, size: (await stat(path)).size, cleanup: () => safeUnlink(path) }
}

export function fileSink(path) {
  const stream = createWriteStream(path, { mode: 0o600 })
  return {
    sink: {
      async write(chunk) {
        if (!stream.write(Buffer.from(chunk))) await new Promise((r) => stream.once('drain', r))
      },
    } as ByteSink,
    finish: () => new Promise((r, j) => stream.end((error) => (error ? j(error) : r()))),
    abort: () => stream.destroy(),
  }
}

export function nullSink() {
  return { write() {} } as ByteSink
}

function safeUnlink(path) {
  try {
    unlinkSync(path)
  } catch {
    /* 忽略 */
  }
}

function makeProgress(label, quiet) {
  if (quiet) return undefined
  let last = 0
  return (done, total) => {
    const now = Date.now()
    if (now - last < 120 && done < total) return
    last = now
    const percent = total === 0 ? 100 : Math.floor((done / total) * 100)
    process.stderr.write(`\r  ${label} ${String(percent).padStart(3)}%  ${done}/${total} 字节`)
    if (done >= total) process.stderr.write('\n')
  }
}

function ensureWritable(path, force) {
  if (existsSync(path) && !force) throw new CliError(`输出文件已存在: ${path}（加 --force 覆盖）`)
  mkdirSync(dirname(resolve(path)), { recursive: true })
}

/** 展开输入：目录按后缀递归一层，文件原样返回。 */
export function expandInputs(inputs, wantedExt) {
  const files = []
  for (const input of inputs) {
    const stats = statSync(input)
    if (stats.isDirectory()) {
      for (const name of readdirSync(input)) {
        const child = join(input, name)
        if (statSync(child).isFile() && (!wantedExt || child.toLowerCase().endsWith(wantedExt.toLowerCase()))) {
          files.push(child)
        }
      }
    } else {
      files.push(input)
    }
  }
  return files
}

async function readPrefix(path, length) {
  const { size } = await stat(path)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(length, size))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return new Uint8Array(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** 第一块的明文长度（用于快速校验）。 */
export function firstPlainSize(header: XuqianHeader) {
  const plainChunk = header.cs - header.lc * 16
  return Math.min(plainChunk, Math.max(0, Number(header.meta.s ?? 0)))
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export async function cmdKeygen(values) {
  const key = MasterKey.generate()
  try {
    const fingerprint = await key.fingerprint()
    const raw = key.clone()
    let password = values['keyfile-password']
    if (!password && values.password) password = await promptSecret('为密钥文件设置密码（留空则不加密码）: ')
    const payload = await payloadFromBytes(raw, { fingerprint })
    const file = password ? await buildProtectedKeyFile(payload, password) : buildPlainKeyFile(payload)
    const text = serializeKeyFile(file)
    zeroize(raw)

    if (values.out) {
      ensureWritable(values.out, values.force)
      await writeFile(values.out, text, { mode: 0o600 })
      info('')
      info(KEYFILE_WARNING)
      info(`已写入密钥文件: ${values.out}`)
      info(`密钥指纹: ${fingerprint}`)
      out(values.out)
    } else {
      info('')
      info(KEYFILE_WARNING)
      out(`指纹: ${fingerprint}`)
      out(`Hex:  ${bytesToHex(key.clone()).toUpperCase()}`)
      out(`B64:  ${bytesToBase64(key.clone())}`)
      info('')
      info('提示: 密钥只显示这一次。请立即离线保存，或用 -o 写入 .XUQIANKEY 文件。')
    }
  } finally {
    key.destroy()
  }
}

export async function cmdEncrypt(values, inputs) {
  if (inputs.length === 0) throw new CliError('请指定要加密的文件（用 - 表示 stdin）')
  const layers = values.layers ? parseLayers(values.layers) : (['AES-128-GCM'] as AlgoId[])
  const chunkSize = values['chunk-size'] ? parseSize(values['chunk-size']) : DEFAULT_CHUNK_SIZE
  const useGzip = values.gzip === true
  const expiresAt = values.expires ? Date.parse(values.expires) : undefined
  if (values.expires && Number.isNaN(expiresAt)) throw new CliError(`无法解析 --expires: ${values.expires}`)

  const key = await resolveMasterKey(values)
  const temps = []
  const results = []

  try {
    const list = inputs.includes('-') ? ['-'] : expandInputs(inputs, '')
    for (const input of list) {
      let sourcePath = input
      let displayName
      if (input === '-') {
        const temp = await spillStdinToTemp()
        temps.push(temp)
        sourcePath = temp.path
        displayName = 'stdin.bin'
      } else {
        displayName = basename(input)
      }

      const sourceSize = statSync(sourcePath).size
      let containerPath = sourcePath
      let contentLength = sourceSize
      if (useGzip && sourceSize > 0) {
        const gz = await gzipToTemp(sourcePath)
        temps.push(gz)
        containerPath = gz.path
        contentLength = gz.size
      }

      // 加密声明：**明文**写在文件最开头（前导区），长度与 SHA-256 进加密头部参与 AAD。
      // 顺序＝先加密内容，再把明文声明加到文件前面。
      const banner = normalizeBannerText(values.notice, defaultBanner('zh'))
      const preamble = buildPreamble(banner.bytes)
      const plaintextLength = contentLength

      const targetDir = values.out ?? (input === '-' ? process.cwd() : dirname(resolve(input)))
      const targetPath = join(targetDir, encryptedFileName(displayName))
      ensureWritable(targetPath, values.force)

      const writer = fileSink(targetPath)
      info(`加密 ${displayName} → ${basename(targetPath)}`)
      try {
        const result = await encryptStream(fileSource(containerPath), preambleFirstSink(preamble, writer.sink), key, {
          layers,
          plaintextLength,
          chunkSize,
          gzip: useGzip,
          encryptMeta: values['encrypt-meta'] === true,
          timestampSalt: values['timestamp-salt'] === true,
          meta: {
            // 声明信息排最前（meta 键顺序会进 AAD，勿随意调整）
            nl: banner.bytes.length,
            nh: noticeHash(banner.bytes),
            n: displayName,
            s: plaintextLength,
            t: Date.now(),
            k: 'bytes',
            ...(useGzip ? { os: sourceSize } : {}),
            ...(values.note ? { c: values.note } : {}),
            ...(expiresAt ? { exp: expiresAt } : {}),
          },
          onProgress: makeProgress(basename(targetPath), values.quiet),
        })
        await writer.finish()
        results.push({
          input: displayName,
          output: targetPath,
          layers,
          bytes: result.outputSize,
          sha256: result.sourceHash,
        })
      } catch (error) {
        writer.abort()
        safeUnlink(targetPath)
        throw error
      }
    }

    if (values.json) out(JSON.stringify({ ok: true, results }, null, 2))
    else for (const r of results) out(r.output)
  } finally {
    for (const temp of temps) temp.cleanup()
    key.destroy()
  }
}

export async function cmdDecrypt(values, inputs) {
  if (inputs.length === 0) throw new CliError('请指定要解密的 .XUQIAN 文件')
  const key = await resolveMasterKey(values)
  const results = []

  try {
    for (const input of expandInputs(inputs, EXT_ENCRYPTED)) {
      const filePath = resolve(input)
      const prefix = await readPrefix(filePath, 1 << 16)

      // 解密顺序（按要求的"先去明文再解密"）：
      // ① 读文件开头的**明文**声明前导区（不需要密钥）
      // ② 从容器偏移处解析加密头部
      // ③ 用头部记录的 nl/nh 校验明文声明未被改动/删除
      // ④ 再从容器偏移开始解密
      let preamble = null
      try {
        preamble = readPreamble(prefix)
      } catch (error) {
        throw new CliError(`明文声明区损坏：${(error as Error).message}`)
      }
      const containerOffset = preamble ? preamble.containerOffset : 0
      const containerPrefix = containerOffset > 0 ? prefix.subarray(containerOffset) : prefix

      let header
      try {
        header = parseHeader(containerPrefix).header
      } catch {
        throw new CliError(`不是有效的 .XUQIAN 文件: ${input}`)
      }

      const declaredName = header.meta.n ? String(header.meta.n) : basename(filePath)
      const targetName = originalFileName(declaredName, header)
      const checkOnly = values['check-only'] === true
      const targetDir = values.out ?? dirname(filePath)
      const targetPath = join(targetDir, targetName)
      if (!checkOnly) ensureWritable(targetPath, values.force)

      // ③ 校验明文声明
      let legacySkip = 0
      if (preamble) {
        const expected = noticeExpectation(header.meta)
        if (!expected) throw new CliError('文件头未记录明文声明信息，但文件带有声明区：文件可能被改动')
        if (preamble.noticeBytes.length !== expected.length || noticeHash(preamble.noticeBytes) !== expected.hash) {
          throw new CliError('文件开头的明文声明已被改动（与加密头部记录的哈希不符），拒绝解密')
        }
        info(`  明文声明 ${preamble.noticeBytes.length} 字节，已校验未被改动`)
      } else if (typeof header.meta.nh === 'string' && header.meta.nh.length > 0) {
        throw new CliError('文件头的明文声明区已被删除（加密头部记录了它存在），拒绝解密')
      } else {
        // 旧格式：声明曾前置在加密内容里，解密后再剥离
        legacySkip = typeof header.meta.nl === 'number' && header.meta.nl > 0 ? header.meta.nl : 0
        if (legacySkip > 0) info(`  （旧格式：解密后将剥离内容开头 ${legacySkip} 字节声明）`)
      }

      info(`解密 ${basename(filePath)} → ${targetName}${checkOnly ? '（仅校验，不写文件）' : ''}`)
      const total = Number(header.meta.s ?? 0)
      const source = fileSource(filePath, containerOffset)
      const skip = legacySkip

      if (checkOnly) {
        await decryptStream(source, nullSink(), key, makeProgress(targetName, values.quiet))
      } else if ((header.flags & 2) === 2) {
        // 容器内明文是 gzip 流：先跳过明文声明区（已在 source 里处理），再边解密边解压边写盘
        const queue = new ByteQueue()
        const pipePromise = pipeline(
          Readable.from(queue),
          createGunzip(),
          createWriteStream(targetPath, { mode: 0o600 }),
        )
        const intoQueue = { write: (chunk) => queue.push(copyBytes(chunk)) }
        try {
          await decryptStream(source, bannerSkippingSink(intoQueue, skip), key, makeProgress(targetName, values.quiet))
          queue.end()
          await pipePromise
        } catch (error) {
          queue.end()
          safeUnlink(targetPath)
          throw error
        }
      } else {
        const writer = fileSink(targetPath)
        try {
          await decryptStream(
            source,
            bannerSkippingSink(writer.sink, skip),
            key,
            makeProgress(targetName, values.quiet),
          )
          await writer.finish()
        } catch (error) {
          writer.abort()
          safeUnlink(targetPath)
          throw error
        }
      }

      results.push({
        input: basename(filePath),
        output: checkOnly ? null : targetPath,
        bytes: Math.max(0, total - skip),
        noticeBytes: preamble ? preamble.noticeBytes.length : skip,
      })
    }

    if (values.json) out(JSON.stringify({ ok: true, results }, null, 2))
    else for (const r of results) if (r.output) out(r.output)
  } finally {
    key.destroy()
  }
}

export async function cmdInspect(values, inputs) {
  if (inputs.length === 0) throw new CliError('请指定要查看的 .XUQIAN 文件')
  const reports = []
  for (const input of inputs) {
    const prefix = await readPrefix(resolve(input), 1 << 16)
    let preamble = null
    try {
      preamble = readPreamble(prefix)
    } catch {
      preamble = null
    }
    const offset = preamble ? preamble.containerOffset : 0
    let header
    try {
      header = parseHeader(offset > 0 ? prefix.subarray(offset) : prefix).header
    } catch (error) {
      throw new CliError(`无法解析 ${input}: ${error.message}`)
    }
    reports.push({ file: input, header, noticeText: preamble?.noticeText ?? null })
  }

  if (values.json) {
    out(JSON.stringify(reports, null, 2))
    return
  }
  for (const report of reports) {
    out(`文件: ${report.file}`)
    // 明文声明放在最前展示——它**不需要密钥**就能读到，这正是它写在文件开头的原因
    if (report.noticeText) {
      out('  明文声明（无需密钥即可读）:')
      for (const line of report.noticeText.split('\n')) out(`    ${line}`)
    }
    for (const row of describeHeader(report.header)) out(`  ${row.key.padEnd(16)} ${row.value}`)
    out('')
  }
}

/**
 * 只校验密钥是否匹配：只认证第一块（AEAD 逐块独立，任意一块即可判定密钥对错），
 * 因此大文件也能秒级得出结论。单块文件会自动升级为完整校验（解出内容并比对头部哈希）。
 */
export async function cmdVerify(values, inputs) {
  if (inputs.length !== 1) throw new CliError('verify 需要恰好一个 .XUQIAN 文件')
  const key = await resolveMasterKey(values)
  try {
    // 先跳过明文声明前导区，再验密钥
    const prefix = await readPrefix(resolve(inputs[0]), 1 << 16)
    const target = resolve(inputs[0])
    let offset = 0
    try {
      offset = readPreamble(prefix)?.containerOffset ?? 0
    } catch {
      offset = 0
    }
    let result
    try {
      result = await keyCheck(key, fileSource(target, offset))
    } catch (error) {
      if (/AUTH_FAILED/.test(String((error as Error)?.message ?? error))) {
        out('MISMATCH')
        info('密钥不匹配（或文件已被篡改/损坏）')
        process.exitCode = 1
        return
      }
      throw error
    }
    if (!result.matched) {
      out('MISMATCH')
      info('密钥不匹配（或文件已被篡改/损坏）')
      process.exitCode = 1
      return
    }
    const fingerprint = await key.fingerprint()
    out('MATCH')
    info(
      `密钥匹配，指纹: ${fingerprint} · 层数 ${result.layers.length} · 算法链 ${result.layers.join(' → ')}` +
        (result.hashVerified ? ' · 已比对完整内容哈希' : ' · 仅校验首块（多块文件）'),
    )
  } finally {
    key.destroy()
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseCli(argv)

  if (values.version) {
    out(`xuqian ${CLI_VERSION}`)
    return
  }
  if (values.help || positionals.length === 0) {
    usage()
    return
  }

  const [command, ...rest] = positionals
  const handlers = {
    keygen: () => cmdKeygen(values),
    encrypt: () => cmdEncrypt(values, rest),
    decrypt: () => cmdDecrypt(values, rest),
    inspect: () => cmdInspect(values, rest),
    verify: () => cmdVerify(values, rest),
  }
  const handler = handlers[command]
  if (!handler) throw new CliError(`未知命令: ${command}\n\n运行 xuqian --help 查看用法`)
  await handler()
}

/** 把内部错误码翻译成给人看的中文提示。 */
const ERROR_TEXT: Record<string, string> = {
  KEYFILE_PASSWORD_REQUIRED: '该 .XUQIANKEY 文件受密码保护，请用 --keyfile-password 提供密码',
  KEYFILE_PASSWORD_WRONG: '密钥文件密码错误（或文件已损坏）',
  KEYFILE_INVALID: '不是有效的 .XUQIANKEY 密钥文件',
  KEYFILE_VERSION_UNSUPPORTED: '密钥文件版本不受支持，请升级工具',
  KEYFILE_CHECKSUM_MISMATCH: '密钥文件校验和不匹配，文件可能已损坏',
  AUTH_FAILED: '密钥错误或文件损坏',
  SOURCE_LENGTH_MISMATCH: '输入字节数与声明长度不符（文件在读取过程中被修改？）',
  SOURCE_TRUNCATED: '输入数据不完整（文件被截断？）',
  SOURCE_TRAILING_DATA: '输入数据比声明的更长',
  TAG_TRUNCATED: '密文被截断，无法完整解密',
  TRAILING_DATA: '密文末尾有多余数据，可能不是完整的 .XUQIAN 文件',
  MAGIC_MISMATCH: '文件头魔数不符，不是 .XUQIAN 文件',
  VERSION_UNSUPPORTED: '文件格式版本不受支持',
  HEADER_CRC_MISMATCH: '文件头校验失败（头部被改动或损坏）',
  LAYER_COUNT_INVALID: `层数必须在 ${MIN_LAYERS}~${MAX_LAYERS} 之间`,
  UNSUPPORTED_ALGORITHM: '文件中包含本工具不支持的算法',
  META_SIZE_INVALID: '文件头中的明文长度字段非法',
  CHUNK_LAYOUT_INVALID: '分块布局与文件头不一致（文件可能被拼接或改动）',
  CSPRNG_UNAVAILABLE: '当前环境没有可用的安全随机源，无法生成密钥',
}

function humanize(message: string): string {
  const code = message.trim()
  if (ERROR_TEXT[code]) return ERROR_TEXT[code]
  if (/^[A-Z][A-Z0-9_]+$/.test(code)) return `内部错误: ${code}`
  return message
}

/** 直接运行时（node cli/xuqian.ts …）才执行；被 import 时只导出函数，方便测试与复用。 */
const invokedDirectly = /[\\/]xuqian\.(ts|mjs)$/.test(String(process.argv[1] ?? '').replace(/\\/g, '/'))
if (invokedDirectly) {
  main().catch((error) => {
    if (error instanceof CliError) {
      process.stderr.write(`错误: ${error.message}\n`)
      process.exit(error.exitCode ?? 1)
    }
    process.stderr.write(`错误: ${humanize(String(error?.message ?? error))}\n`)
    process.exit(1)
  })
}
