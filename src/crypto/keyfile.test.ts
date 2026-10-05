import { describe, expect, it } from 'vitest'
import {
  buildPlainKeyFile,
  buildProtectedKeyFile,
  parseKeyFile,
  payloadFromBytes,
  masterKeyFromPayload,
  serializeKeyFile,
  KEYFILE_FORMAT,
} from './keyfile.ts'
import { MasterKey } from './keys.ts'
import { bytesToHex, bytesToBase64 } from './encoding.ts'

describe('.XUQIANKEY 密钥文件', () => {
  it('明文密钥文件可往返解析', async () => {
    const mk = MasterKey.generate()
    const bytes = mk.clone()
    const payload = await payloadFromBytes(bytes, { layers: ['AES-128-GCM'], note: '备份' })
    const text = serializeKeyFile(buildPlainKeyFile(payload))
    const parsed = await parseKeyFile(text)
    expect(parsed.keyHex).toBe(payload.keyHex)
    expect(parsed.fingerprint).toBe(await mk.fingerprint())
    const restored = masterKeyFromPayload(parsed)
    expect(bytesToHex(restored.clone())).toBe(bytesToHex(bytes))
    restored.destroy()
    mk.destroy()
    bytes.fill(0)
  })

  it('密码保护的密钥文件：正确密码可解，错误密码与篡改都被拒绝', async () => {
    const mk = MasterKey.generate()
    const bytes = mk.clone()
    const payload = await payloadFromBytes(bytes)
    const protectedFile = await buildProtectedKeyFile(payload, 'correct horse battery staple')
    const text = serializeKeyFile(protectedFile)

    const ok = await parseKeyFile(text, 'correct horse battery staple')
    expect(ok.keyHex).toBe(payload.keyHex)

    await expect(parseKeyFile(text, 'wrong password')).rejects.toThrow('KEYFILE_PASSWORD_WRONG')
    await expect(parseKeyFile(text)).rejects.toThrow('KEYFILE_PASSWORD_REQUIRED')

    const tampered = JSON.parse(text) as Record<string, unknown>
    const sealed = tampered.sealed as string
    tampered.sealed = (sealed[0] === 'A' ? 'B' : 'A') + sealed.slice(1)
    await expect(parseKeyFile(JSON.stringify(tampered), 'correct horse battery staple')).rejects.toThrow(
      'KEYFILE_PASSWORD_WRONG',
    )

    mk.destroy()
    bytes.fill(0)
  })

  it('明文密钥文件校验和被检测（防手改）', async () => {
    const mk = MasterKey.generate()
    const bytes = mk.clone()
    const payload = await payloadFromBytes(bytes)
    const file = buildPlainKeyFile(payload)
    file.keyHex = file.keyHex.replace(/^../, 'ff')
    await expect(parseKeyFile(JSON.stringify(file))).rejects.toThrow('KEYFILE_CHECKSUM_MISMATCH')
    mk.destroy()
    bytes.fill(0)
  })

  it('非密钥文件被拒绝，且格式标记正确', async () => {
    await expect(parseKeyFile('{"format":"OTHER"}')).rejects.toThrow('KEYFILE_INVALID')
    await expect(parseKeyFile('not json')).rejects.toThrow('KEYFILE_INVALID')
    expect(KEYFILE_FORMAT).toBe('XUQIANKEY')
  })

  it('Key B64 为 24 字符（128 位）', async () => {
    const bytes = new Uint8Array(16).fill(0x2a)
    const payload = await payloadFromBytes(bytes)
    expect(payload.keyHex).toHaveLength(32)
    expect(payload.keyB64).toHaveLength(24)
    expect(bytesToBase64(bytes)).toBe(payload.keyB64)
  })
})
