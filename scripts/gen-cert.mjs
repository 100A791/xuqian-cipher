/** 生成开发用自签名证书（certs/），让本地也能以 HTTPS 打开（部分浏览器 API 需要安全上下文）。 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const certDir = resolve(root, 'certs')
const keyPath = resolve(certDir, 'key.pem')
const certPath = resolve(certDir, 'cert.pem')

if (existsSync(keyPath) && existsSync(certPath)) {
  console.log('[gen-cert] 已存在 certs/key.pem 与 certs/cert.pem，跳过生成')
  process.exit(0)
}

mkdirSync(certDir, { recursive: true })

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

try {
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '365',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ])
  console.log('[gen-cert] 已生成 certs/key.pem 与 certs/cert.pem')
} catch {
  console.error('[gen-cert] 需要本机安装 openssl。也可以直接使用 HTTP 的 pnpm dev（localhost 属于安全上下文）。')
  process.exit(1)
}

writeFileSync(resolve(certDir, 'README.txt'), '本目录仅用于本地 HTTPS 开发预览，请勿提交或用于生产。\n')
