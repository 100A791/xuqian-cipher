/**
 * 测试辅助：用"指定密钥"生成 .XUQIANKEY 文件（CLI 的 keygen 只能生成随机密钥）。
 *
 * 必须用 .ts 文件 + `node <path>.ts` 运行：Node 的类型擦除只对显式 .ts 入口生效，
 * `node -e` 里动态 import .ts 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
 *
 * 用法：
 *   node scripts/lib/make-keyfile.ts <输出路径> <32位Hex> [密码]
 * 输出：一行 JSON（fingerprint / keyHex / protected / bytes）
 */
import { writeFileSync, readFileSync } from 'node:fs'

import { buildPlainKeyFile, buildProtectedKeyFile, masterKeyFromPayload, parseKeyFile, payloadFromBytes, serializeKeyFile } from '../../src/crypto/keyfile.ts'
import { MasterKey } from '../../src/crypto/keys.ts'
import { hexToBytes } from '../../src/crypto/encoding.ts'

const [targetPath, keyHex, password] = process.argv.slice(2)
if (!targetPath || !keyHex) {
  process.stderr.write('用法: node scripts/lib/make-keyfile.ts <输出路径> <32位Hex> [密码]\n')
  process.exit(2)
}
if (!/^[0-9a-fA-F]{32}$/.test(keyHex)) {
  process.stderr.write('密钥必须是 32 位 Hex\n')
  process.exit(2)
}

const key = MasterKey.fromBytes(hexToBytes(keyHex))
try {
  const payload = await payloadFromBytes(key.clone(), { fingerprint: await key.fingerprint() })
  const file = password ? await buildProtectedKeyFile(payload, password) : buildPlainKeyFile(payload)
  const text = serializeKeyFile(file)
  writeFileSync(targetPath, text, { mode: 0o600 })

  // 回读校验：确认写进去的确实是同一把密钥（防止夹具本身有错导致误判）
  const back = await parseKeyFile(readFileSync(targetPath, 'utf8'), password || undefined)
  const restored = masterKeyFromPayload(back)
  const fingerprint = await restored.fingerprint()
  const matches = back.keyHex.toLowerCase() === keyHex.toLowerCase()
  restored.destroy()
  process.stdout.write(
    JSON.stringify({ ok: matches, fingerprint, keyHex: back.keyHex, protected: Boolean(password), bytes: text.length }),
  )
  if (!matches) process.exit(3)
} finally {
  key.destroy()
}
