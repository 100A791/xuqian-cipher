/**
 * XUQIAN 本地静态部署服务器（零依赖）。
 *
 * 与 `pnpm dev` 的区别：**它服务的是构建产物**（默认 publish/），
 * 不跑 Vite、不转译源码、不监听文件变化 —— 适合"开机就在那儿、随时能打开"的本地部署。
 *
 * 只绑 127.0.0.1；关掉进程/窗口即停。开机自启由「启动」文件夹里的 xuqian-local.cmd 负责。
 *
 * 用法：
 *   node scripts/serve.mjs               # 服务 publish/，端口 5188
 *   node scripts/serve.mjs --port 5189
 *   node scripts/serve.mjs --dir dist
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const PORT = Number(argOf('--port', process.env.XQ_SERVE_PORT ?? '5188'))
const HOST = '127.0.0.1'
const relDir = argOf('--dir', 'publish')
const WEB_ROOT = resolve(root, relDir)

if (!existsSync(join(WEB_ROOT, 'index.html'))) {
  console.error(`[serve] 目录里没有 index.html：${WEB_ROOT}`)
  console.error('[serve] 先构建并同步：pnpm build && pnpm site:sync（或 --dir dist）')
  process.exit(2)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 解析请求路径到磁盘路径；越界（../）直接返回 null。 */
function resolveTarget(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const clean = normalize(decoded).replace(/^([/\\])+/, '')
  const target = resolve(WEB_ROOT, clean)
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return null
  return target
}

function cacheControl(relPath) {
  // index.html 与 sw.js 必须每次校验（否则 PWA 更新不生效）；带哈希的静态资源可长期缓存
  if (relPath === 'index.html' || relPath === 'sw.js' || relPath === 'manifest.webmanifest') return 'no-cache'
  if (/[-.][A-Za-z0-9_-]{8,12}\.(js|css|png|svg|woff2)$/.test(relPath)) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end('Method Not Allowed')
    return
  }

  const urlPath = req.url ?? '/'
  let target = resolveTarget(urlPath)
  if (target === null) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  // 目录 → index.html
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')

  // 找不到时：无扩展名的路径回退到 SPA 首页（有扩展名则 404，避免掩盖真实缺文件）
  if (!existsSync(target)) {
    if (extname(target) === '') target = join(WEB_ROOT, 'index.html')
    else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
  }

  const relPath = target
    .slice(WEB_ROOT.length + 1)
    .split(sep)
    .join('/')
  const size = statSync(target).size
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': cacheControl(relPath),
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(target)
  stream.on('error', () => {
    res.destroy()
  })
  stream.pipe(res)
})

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`[serve] 端口 ${PORT} 已被占用（可能服务已在运行）；换端口：node scripts/serve.mjs --port 5189`)
    process.exit(3)
  }
  console.error('[serve] 服务错误:', error)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`[serve] 已启动 http://${HOST}:${PORT}/  ← 目录 ${relDir}/（构建产物，非源码）`)
  console.log('[serve] 只监听回环地址；关闭本窗口或结束进程即停止')
})
