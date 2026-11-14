/**
 * XUQIAN 本地 API 的 **API Key 管理**（零依赖）。
 *
 * 与启动时随机生成的会话令牌（`X-XQ-Token`，每次重启就换）不同，API Key 是**长期有效**的：
 * 你自己的脚本/工具用它调 http://127.0.0.1:5190，直到你 revoke 为止。
 *
 * 安全设计：
 *   - 密钥只在**创建时打印一次**，文件里只存 SHA-256 哈希（文件泄露 ≠ 密钥泄露）。
 *   - 密钥格式带前缀 `xq_`，便于日志里识别与脱敏。
 *   - 存储位置在仓库之外：`%LOCALAPPDATA%\xuqian\api-keys.json`，不会被提交。
 *
 * 用法：
 *   node scripts/xq-keys.mjs add <标签> [--save]   新增（--save 同时写到 api-key.txt 供脚本读取）
 *   node scripts/xq-keys.mjs list                  列出（不显示密钥本身）
 *   node scripts/xq-keys.mjs revoke <id|标签>       吊销
 *   node scripts/xq-keys.mjs path                  打印密钥文件位置
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const KEYS_FILE =
  process.env.XQ_API_KEYS_FILE ?? join(process.env.LOCALAPPDATA ?? process.cwd(), 'xuqian', 'api-keys.json')
const KEY_TEXT_FILE = process.env.XQ_API_KEY_TEXT_FILE ?? join(dirname(KEYS_FILE), 'api-key.txt')

const argv = process.argv.slice(2)
const cmd = argv[0]
const args = argv.slice(1).filter((a) => !a.startsWith('--'))
const flags = new Set(argv.filter((a) => a.startsWith('--')))

function readStore() {
  if (!existsSync(KEYS_FILE)) return { version: 1, keys: [] }
  try {
    const parsed = JSON.parse(readFileSync(KEYS_FILE, 'utf8'))
    if (!parsed || !Array.isArray(parsed.keys)) return { version: 1, keys: [] }
    return parsed
  } catch {
    console.error(`[xq-keys] 密钥文件不是合法 JSON：${KEYS_FILE}`)
    process.exit(2)
  }
}

function writeStore(store) {
  mkdirSync(dirname(KEYS_FILE), { recursive: true })
  writeFileSync(KEYS_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex')
const newKey = () => `xq_${randomBytes(24).toString('base64url')}`
const shortId = () => `k_${randomBytes(4).toString('hex')}`

function cmdAdd() {
  const label = args[0] || 'default'
  const store = readStore()
  if (store.keys.some((k) => k.label === label) && !flags.has('--force')) {
    console.error(`[xq-keys] 标签已存在：${label}（要再加一个同名标签请加 --force）`)
    process.exit(2)
  }
  const key = newKey()
  const record = { id: shortId(), label, hash: hashOf(key), createdAt: new Date().toISOString(), lastUsedAt: null }
  store.keys.push(record)
  writeStore(store)

  console.log(`[xq-keys] 已新增 API Key`)
  console.log(`  标签：${label}`)
  console.log(`  ID  ：${record.id}`)
  console.log(`  密钥（只显示这一次，请自行保存）：`)
  console.log(`  ${key}`)
  if (flags.has('--save')) {
    mkdirSync(dirname(KEY_TEXT_FILE), { recursive: true })
    writeFileSync(KEY_TEXT_FILE, `${key}\n`, 'utf8')
    console.log(`  已同时写入：${KEY_TEXT_FILE}（供脚本/自检读取；该文件等同凭据，勿提交勿外发）`)
  }
  console.log(`  密钥文件（只存哈希）：${KEYS_FILE}`)
}

function cmdList() {
  const store = readStore()
  if (store.keys.length === 0) {
    console.log('[xq-keys] 还没有 API Key。新建：node scripts/xq-keys.mjs add <标签>')
    return
  }
  console.log(`[xq-keys] ${store.keys.length} 个 API Key（${KEYS_FILE}）`)
  for (const k of store.keys) {
    console.log(`  ${k.id}  ${k.label}  created=${k.createdAt}  lastUsed=${k.lastUsedAt ?? '从未'}`)
  }
}

function cmdRevoke() {
  const target = args[0]
  if (!target) {
    console.error('[xq-keys] 用法：node scripts/xq-keys.mjs revoke <id|标签>')
    process.exit(2)
  }
  const store = readStore()
  const before = store.keys.length
  store.keys = store.keys.filter((k) => k.id !== target && k.label !== target)
  if (store.keys.length === before) {
    console.error(`[xq-keys] 没找到：${target}`)
    process.exit(2)
  }
  writeStore(store)
  console.log(`[xq-keys] 已吊销：${target}（剩余 ${store.keys.length} 个）`)
}

switch (cmd) {
  case 'add':
    cmdAdd()
    break
  case 'list':
    cmdList()
    break
  case 'revoke':
    cmdRevoke()
    break
  case 'path':
    console.log(KEYS_FILE)
    break
  default:
    console.log('用法：node scripts/xq-keys.mjs <add|list|revoke|path> [标签/ID] [--save] [--force]')
    process.exit(cmd ? 2 : 0)
}
