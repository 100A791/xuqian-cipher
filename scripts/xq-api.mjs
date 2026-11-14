/**
 * XUQIAN 本地加密 API（供 skill / 脚本调用）。
 *
 * 定位：**本地进程**，只监听回环地址，与静态站点（publish/）完全分离；
 * 站点本身仍然"零网络请求"，本服务只在你自己机器上跑。
 *
 * 安全设计（三条，缺一不可）：
 *   1. 只绑 127.0.0.1 —— 局域网/公网访问不到。
 *   2. 必须带 `X-XQ-Token`，令牌每次启动随机生成，写到 tokenFile；
 *      比对用 timingSafeEqual（等长摘要比较），避免计时旁路。
 *   3. **拒绝任何带 `Origin` 头的请求** —— 浏览器发起的跨源请求一定带 Origin，
 *      而 curl / 脚本 / 我们的 skill 不带。这样可以挡住"你正在浏览的恶意网页
 *      偷偷 POST 到 127.0.0.1:5190"这类攻击（CSRF / DNS rebinding 的前置）。
 *
 * 加密逻辑零复制：每个请求 spawn 现成的 `cli/xuqian.mjs`，保证与站点/CLI 同一内核。
 *
 * 用法：
 *   node scripts/xq-api.mjs [--port 5190]
 *   环境变量：XQ_API_PORT（端口）、XQ_API_TOKEN_FILE（令牌文件路径）
 * 令牌文件默认：%TEMP%\xuqian-api-token.json（内容 {token, port, pid, startedAt}）
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(root, 'cli', 'xuqian.mjs')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const argv = process.argv.slice(2)
const argPort = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : NaN
const PORT = Number.isFinite(argPort) ? argPort : Number(process.env.XQ_API_PORT ?? 5190)
const HOST = '127.0.0.1'
const TOKEN_FILE = process.env.XQ_API_TOKEN_FILE ?? join(process.env.TEMP ?? root, 'xuqian-api-token.json')
/** 长期 API Key 的存储（只存 sha256 哈希），在仓库之外，由 scripts/xq-keys.mjs 管理。 */
const KEYS_FILE = process.env.XQ_API_KEYS_FILE ?? join(process.env.LOCALAPPDATA ?? root, 'xuqian', 'api-keys.json')
const MAX_BODY = 1024 * 1024 // 1 MiB：请求体只放路径与小参数，不传文件内容

if (!existsSync(CLI)) {
  console.error(`[xq-api] 找不到 CLI：${CLI}`)
  process.exit(2)
}

const token = randomBytes(24).toString('hex')
writeFileSync(
  TOKEN_FILE,
  JSON.stringify({ token, port: PORT, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
  'utf8',
)

/** 等长摘要比较，避免逐字节比较带来的计时差异。 */
function tokenMatches(given) {
  if (typeof given !== 'string' || given.length === 0) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

/** 读长期 API Key（只含哈希）。每次请求都读，这样新增/吊销立即生效、无需重启服务。 */
function readApiKeys() {
  if (!existsSync(KEYS_FILE)) return []
  try {
    const parsed = JSON.parse(readFileSync(KEYS_FILE, 'utf8'))
    return Array.isArray(parsed?.keys) ? parsed.keys : []
  } catch {
    return []
  }
}

/** 命中则返回该 key 的记录（并顺手更新 lastUsedAt，最多每分钟写一次）。 */
function findApiKey(given) {
  if (typeof given !== 'string' || !given.startsWith('xq_')) return null
  const digest = createHash('sha256').update(given).digest()
  const keys = readApiKeys()
  const hit = keys.find((k) => {
    if (typeof k?.hash !== 'string' || k.hash.length !== 64) return false
    const stored = Buffer.from(k.hash, 'hex')
    return stored.length === digest.length && timingSafeEqual(stored, digest)
  })
  if (!hit) return null
  const now = Date.now()
  const last = hit.lastUsedAt ? Date.parse(hit.lastUsedAt) : 0
  if (!Number.isFinite(last) || now - last > 60_000) {
    try {
      hit.lastUsedAt = new Date(now).toISOString()
      writeFileSync(KEYS_FILE, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, 'utf8')
    } catch {
      /* 写不进去不影响本次鉴权 */
    }
  }
  return hit
}

/**
 * 解析请求身份。支持两种凭据：
 *   1. 长期 API Key：`Authorization: Bearer xq_...` 或 `X-XQ-Key: xq_...`（推荐，重启不失效）
 *   2. 会话令牌：`X-XQ-Token: <token>`（每次启动随机，写在 token 文件里，供 skill 自动使用）
 */
function resolveAuth(req) {
  const auth = req.headers.authorization
  const bearer = typeof auth === 'string' && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : ''
  const fromHeader = typeof req.headers['x-xq-key'] === 'string' ? req.headers['x-xq-key'].trim() : ''
  const candidate = bearer || fromHeader
  if (candidate) {
    const record = findApiKey(candidate)
    if (record) return { ok: true, method: 'api-key', label: record.label, id: record.id }
    return null
  }
  if (tokenMatches(req.headers['x-xq-token'])) return { ok: true, method: 'session-token' }
  return null
}

/** 调现成 CLI，返回 {status, stdout, stderr}；不经过 shell，参数数组直接传。
 *  input 可选：作为 stdin 喂给 CLI（`encrypt -` 用，这样明文不必先落盘）。 */
function runCli(args, input) {
  const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  if (input !== undefined) options.input = input
  const r = spawnSync(process.execPath, [CLI, ...args], options)
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 把 CLI 的 stdout 当 JSON 解析；失败时把 stderr 作为错误原因返回。input 可选，作为 stdin。 */
function cliJson(args, input) {
  const r = runCli(args, input)
  const text = r.stdout.trim()
  const parsed = text.startsWith('{') || text.startsWith('[') ? safeJson(text) : null
  if (r.status !== 0 || parsed === null) {
    return { ok: false, code: r.status, error: firstErrorLine(r.stderr) || '命令执行失败' }
  }
  return { ok: true, code: 0, result: parsed }
}

function firstErrorLine(stderr) {
  const line = String(stderr)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('错误:'))
    .pop()
  return line ? line.replace(/^错误:\s*/, '') : ''
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const isStr = (v) => typeof v === 'string' && v.length > 0
const isStrArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr)

/** 输入必须是字符串路径或字符串数组；任何非字符串一律拒绝（绝不拼进命令行字符串）。 */
function asPaths(value) {
  if (isStrArray(value)) return value
  if (isStr(value)) return [value]
  return null
}

function keyArgs(body) {
  const args = isStr(body.keyfile)
    ? ['--keyfile', body.keyfile]
    : isStr(body.key)
      ? ['--key', body.key] // 兼容自动化；文档里不推荐（会进 shell 历史/请求体）
      : null
  if (args && isStr(body.keyPassword)) {
    // 口令保护的 .XUQIANKEY：非交互传入，不依赖 TTY 提示
    args.push('--keyfile-password', body.keyPassword)
  }
  return args
}

/** 可选算法（与 src/crypto/aead.ts 的 ALGO_SPECS 保持一致；改动时两边同步）。 */
const ALGORITHMS = ['AES-128-GCM', 'AES-256-GCM', 'CHACHA20-POLY1305', 'XCHACHA20-POLY1305', 'SM4-GCM']

/** 建临时目录并在 finally 里整目录删除（明文只在这里短暂存在）。 */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'xq-api-'))
  try {
    return fn(dir)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 删不掉就留着，不影响本次结果 */
    }
  }
}

/** 在目录里找唯一一个扩展名匹配的文件。 */
function findOne(dir, ext) {
  const hits = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(ext))
  return hits.length === 1 ? join(dir, hits[0]) : null
}

/**
 * 解密前的可选校验：把头部自述的算法/算法链与调用方期望比对。
 * 用途：明确"这份密文就是用某算法加密的"——拿错文件或被换了算法时立刻报错，而不是解出意外内容。
 */
function checkExpectations(path, body) {
  const wantAlgo = isStr(body.expectAlgorithm) ? body.expectAlgorithm : null
  const wantLayers = Array.isArray(body.expectLayers) && body.expectLayers.length > 0 ? body.expectLayers : null
  if (!wantAlgo && !wantLayers) return null
  const r = cliJson(['inspect', path, '--json'])
  if (!r.ok) return { error: r.error }
  const header = Array.isArray(r.result) ? r.result[0]?.header : r.result?.header
  const actual = (header?.layers ?? []).map((layer) => layer.a)
  if (wantAlgo && (actual.length !== 1 || actual[0] !== wantAlgo)) {
    return { error: `算法不匹配：期望单层 ${wantAlgo}，实际 ${actual.join(' → ') || '(无法读取)'}` }
  }
  if (wantLayers && actual.join(',') !== wantLayers.join(',')) {
    return { error: `算法链不匹配：期望 ${wantLayers.join(' → ')}，实际 ${actual.join(' → ') || '(无法读取)'}` }
  }
  return null
}

const ROUTES = {
  '/v1/keygen': (body) => {
    const args = ['keygen']
    if (isStr(body.out)) args.push('-o', body.out)
    if (isStr(body.keyPassword)) args.push('--keyfile-password', body.keyPassword)
    else if (body.password === true) args.push('--password')
    if (isStr(body.note)) args.push('--note', body.note)
    if (body.force === true) args.push('--force')
    args.push('--quiet')
    const r = runCli(args)
    const out = r.stdout.trim()
    if (r.status !== 0) return { code: r.status, body: { ok: false, error: firstErrorLine(r.stderr) || 'keygen 失败' } }
    return { code: 200, body: { ok: true, keyFile: out } }
  },

  // 统一入口：`inputs`（文件路径）→ 输出文件；`text`（字符串）→ 输出数据（base64url）。
  '/v1/encrypt': (body) => {
    if (isStr(body.text) && !body.inputs) return encryptTextResult(body)
    if (isStr(body.text) && body.inputs)
      return bad('不能同时给 text 与 inputs：二选一（文件→输出文件 / 字符串→输出数据）')
    const inputs = asPaths(body.inputs)
    if (!inputs) return bad('inputs 必须是文件路径或路径数组（或用 text 传字符串）')
    const k = keyArgs(body)
    if (!k) return bad('缺少 keyfile（推荐）或 key')
    const args = ['encrypt', ...inputs, ...k, '--json', '--quiet']
    if (body.gzip === true) args.push('--gzip')
    if (body.encryptMeta === true) args.push('--encrypt-meta')
    if (body.timestampSalt === true) args.push('--timestamp-salt')
    if (isStr(body.layers)) args.push('--layers', body.layers)
    if (isStr(body.chunkSize)) args.push('--chunk-size', body.chunkSize)
    if (isStr(body.note)) args.push('--note', body.note)
    if (isStr(body.notice)) args.push('--notice', body.notice)
    if (isStr(body.expires)) args.push('--expires', body.expires)
    if (isStr(body.notBefore)) args.push('--not-before', body.notBefore)
    if (isStr(body.out)) args.push('--out', body.out)
    if (body.force === true) args.push('--force')
    const r = cliJson(args)
    return r.ok
      ? { code: 200, body: { ...r.result, outputType: 'file' } }
      : { code: 400, body: { ok: false, error: r.error } }
  },

  // 统一入口：`inputs`（.XUQIAN 路径）→ 输出文件；`token`（数据）→ 输出字符串。
  '/v1/decrypt': (body) => {
    if (isStr(body.token) && !body.inputs) return decryptTextResult(body)
    if (isStr(body.token) && body.inputs)
      return bad('不能同时给 token 与 inputs：二选一（文件→输出文件 / 数据→输出字符串）')
    const inputs = asPaths(body.inputs)
    if (!inputs) return bad('inputs 必须是文件路径或路径数组（或用 token 传数据）')
    const k = keyArgs(body)
    if (!k) return bad('缺少 keyfile（推荐）或 key')
    for (const input of inputs) {
      const mismatch = checkExpectations(input, body)
      if (mismatch) return bad(mismatch.error)
    }
    const args = ['decrypt', ...inputs, ...k, '--json', '--quiet']
    if (isStr(body.out)) args.push('--out', body.out)
    if (body.checkOnly === true) args.push('--check-only')
    if (body.force === true) args.push('--force')
    const r = cliJson(args)
    return r.ok
      ? { code: 200, body: { ...r.result, outputType: 'file' } }
      : { code: 400, body: { ok: false, error: r.error } }
  },

  '/v1/verify': (body) => {
    if (!isStr(body.input)) return bad('缺少 input')
    const k = keyArgs(body)
    if (!k) return bad('缺少 keyfile（推荐）或 key')
    const r = runCli(['verify', body.input, ...k, '--quiet'])
    const text = r.stdout.trim()
    return {
      code: 200,
      body: { ok: r.status === 0, matched: text.includes('MATCH') && !text.includes('MISMATCH'), exit: r.status },
    }
  },

  '/v1/inspect': (body) => {
    if (!isStr(body.input)) return bad('缺少 input')
    const r = cliJson(['inspect', body.input, '--json'])
    return r.ok ? { code: 200, body: r.result } : { code: 400, body: { ok: false, error: r.error } }
  },

  /** 显式短内容端点（等价于给 /v1/encrypt 传 text；保留是为了可读性与向后兼容）。 */
  '/v1/encrypt-text': (body) => encryptTextResult(body),

  /** 显式短内容端点（等价于给 /v1/decrypt 传 token）。 */
  '/v1/decrypt-text': (body) => decryptTextResult(body),
}

/**
 * 数据模式加密：字符串 → base64url 字符串。
 * 明文经 stdin 喂给 CLI，**不落盘**；产物仍是标准 .xuqian 容器，可存成文件用网站解密。
 */
function encryptTextResult(body) {
  if (!isStr(body.text)) return bad('缺少 text')
  const k = keyArgs(body)
  if (!k) return bad('缺少 keyfile（推荐）或 key')
  return withTempDir((dir) => {
    const args = ['encrypt', '-', ...k, '--out', dir, '--json', '--quiet']
    if (isStr(body.layers)) args.push('--layers', body.layers)
    if (isStr(body.notice)) args.push('--notice', body.notice)
    if (isStr(body.chunkSize)) args.push('--chunk-size', body.chunkSize)
    if (body.gzip === true) args.push('--gzip')
    if (body.encryptMeta === true) args.push('--encrypt-meta')
    const r = cliJson(args, body.text)
    if (!r.ok) return { code: 400, body: { ok: false, error: r.error } }
    const out = findOne(dir, '.xuqian')
    if (!out) return { code: 500, body: { ok: false, error: '未找到加密输出（不应发生）' } }
    const bytes = readFileSync(out)
    return {
      code: 200,
      body: {
        ok: true,
        outputType: 'data',
        token: bytes.toString('base64url'),
        bytes: bytes.length,
        layers: r.result.results?.[0]?.layers ?? [],
      },
    }
  })
}

/**
 * 数据模式解密：base64url 字符串 → 字符串。
 * 解密选项：keyfile/keyPassword、checkOnly（只验密钥与首块认证、不返回明文）、
 * expectAlgorithm / expectLayers（钉死算法，不匹配直接报错）。
 */
function decryptTextResult(body) {
  if (!isStr(body.token)) return bad('缺少 token')
  const k = keyArgs(body)
  if (!k) return bad('缺少 keyfile（推荐）或 key')
  const cipher = Buffer.from(body.token, 'base64url')
  if (cipher.length === 0) return bad('token 解码后为空（应为 base64url）')
  return withTempDir((dir) => {
    const inPath = join(dir, 'token.xuqian')
    writeFileSync(inPath, cipher)
    const mismatch = checkExpectations(inPath, body)
    if (mismatch) return bad(mismatch.error)
    const outDir = join(dir, 'out')
    const args = ['decrypt', inPath, ...k, '--out', outDir, '--force', '--quiet', '--json']
    if (body.checkOnly === true) args.push('--check-only')
    const r = cliJson(args)
    if (!r.ok) return { code: 400, body: { ok: false, error: r.error } }
    if (body.checkOnly === true) {
      // 只验不取：不读明文，直接返回结构信息
      const first = Array.isArray(r.result.results) ? r.result.results[0] : null
      return {
        code: 200,
        body: { ok: true, outputType: 'data', checked: true, noticeBytes: first?.noticeBytes ?? null },
      }
    }
    const names = readdirSync(outDir)
    if (names.length !== 1) return { code: 500, body: { ok: false, error: '解密输出异常（不应发生）' } }
    const text = readFileSync(join(outDir, names[0]), 'utf8')
    return { code: 200, body: { ok: true, outputType: 'data', text, bytes: Buffer.byteLength(text, 'utf8') } }
  })
}

function bad(message) {
  return { code: 400, body: { ok: false, error: message } }
}

function sendJson(res, code, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

const server = createServer((req, res) => {
  const started = Date.now()
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  // 防止"请求体超限"这类分支既 finish 又走到 end 处理，导致重复写响应
  let responded = false

  const finish = (code, payload) => {
    if (responded) return
    responded = true
    sendJson(res, code, payload)
    console.log(
      `[xq-api] ${new Date().toISOString()} ${req.method} ${url.pathname} → ${code} (${Date.now() - started}ms)`,
    )
  }

  // 规则 3：浏览器跨源请求必带 Origin —— 直接拒绝
  if (req.headers.origin)
    return finish(403, { ok: false, error: '拒绝来自浏览器的跨源请求（本服务只接受本地脚本/命令行调用）' })

  // 健康检查与能力清单不需要令牌（便于 skill 探测服务、挑选加密方式）
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    return finish(200, { ok: true, service: 'xuqian-api', version: pkg.version, port: PORT, pid: process.pid })
  }
  if (req.method === 'GET' && url.pathname === '/v1/methods') {
    return finish(200, {
      ok: true,
      algorithms: ALGORITHMS,
      defaultAlgorithm: 'AES-128-GCM',
      minLayers: 1,
      maxLayers: 10,
      keyProtection: ['plain-keyfile', 'password-keyfile（keygen 传 keyPassword 生成，使用时同传 keyPassword）'],
      /** 统一规则：输入的形态决定输出的形态。 */
      autoDispatch: {
        encrypt: { 'inputs（文件路径）': '输出文件（.xuqian 落盘）', 'text（字符串）': '输出数据（base64url 字符串）' },
        decrypt: { 'inputs（.xuqian 路径）': '输出文件（还原原文件）', 'token（base64url）': '输出字符串' },
        rule: '给 inputs 就按文件处理并返回 outputType:"file"；给 text/token 就按数据处理并返回 outputType:"data"；同时给两者返回 400。',
      },
      textMode: {
        encrypt: '/v1/encrypt-text',
        decrypt: '/v1/decrypt-text',
        encoding: 'base64url',
        note: '与文件模式同一容器格式；解码成文件后可直接用网站「简单加密」页解密。也可直接用 /v1/encrypt 传 text。',
      },
      routes: {
        simple: 'src/crypto（本 API + CLI + 网站「简单加密」页，互通）',
        self: 'src/selfcrypto（自研路线，未通过本 API 暴露，格式互不通用）',
      },
      auth: {
        apiKey: 'Authorization: Bearer xq_…（长期有效；用 node scripts/xq-keys.mjs add <标签> 创建）',
        apiKeyAlt: 'X-XQ-Key: xq_…',
        sessionToken: 'X-XQ-Token: <token>（每次启动随机，见 token 文件；供 skill 自动使用）',
        probe: 'GET /v1/auth 可确认当前凭据（返回 method/label/id）',
      },
    })
  }

  // 规则 2：凭据 —— 长期 API Key（推荐）或会话令牌
  const identity = resolveAuth(req)
  if (!identity) {
    return finish(401, {
      ok: false,
      error:
        '缺少或错误的凭据：用 Authorization: Bearer xq_…（长期 API Key，见 scripts/xq-keys.mjs）或 X-XQ-Token（会话令牌，见 token 文件）',
    })
  }
  // 让调用方确认自己用的是哪把凭据（排查用）
  if (req.method === 'GET' && url.pathname === '/v1/auth') {
    return finish(200, {
      ok: true,
      method: identity.method,
      label: identity.label ?? null,
      id: identity.id ?? null,
    })
  }

  const route = ROUTES[url.pathname]
  if (!route) return finish(404, { ok: false, error: `未知端点：${url.pathname}` })
  if (req.method !== 'POST') return finish(405, { ok: false, error: '该端点只接受 POST' })

  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) {
      finish(413, { ok: false, error: '请求体过大（上限 1 MiB；只传路径与参数，不要传文件内容）' })
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (size > MAX_BODY || responded) return
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw.trim() === '' ? {} : safeJson(raw)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return finish(400, { ok: false, error: '请求体必须是 JSON 对象' })
    }
    try {
      const out = route(body)
      finish(out.code, out.body)
    } catch (error) {
      finish(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
})

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`[xq-api] 端口 ${PORT} 已被占用；换端口：node scripts/xq-api.mjs --port 5191`)
    process.exit(3)
  }
  console.error('[xq-api] 服务错误:', error)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[xq-api] 已启动 http://${HOST}:${PORT}/  （v${pkg.version}）`)
  console.log(`[xq-api] 令牌文件：${TOKEN_FILE}`)
  console.log('[xq-api] 只监听回环地址；带 Origin 的浏览器请求一律拒绝；Ctrl+C 停止')
})
