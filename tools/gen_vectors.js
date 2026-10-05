/**
 * 测试向量生成器 —— SPEC 第 2 节 tools 目录（gen_vectors.js）。
 *
 * 为什么生成而不手抄：手抄的标准向量一旦打错一位，测试就会去迁就错误值。
 * 这里用 node:crypto（OpenSSL，与被测的自研实现完全独立）算出期望值，
 * 再由 tests/unit/test_*.js 用**自研实现**去比对 —— 两边独立才有意义。
 *
 * 用法：node tools/gen_vectors.js
 */
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { materialize } from '../tests/unit/_helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectorsDir = resolve(here, '../tests/vectors')
mkdirSync(vectorsDir, { recursive: true })

const hex = (buf) => Buffer.from(buf).toString('hex')
const rep = (byte, times) => ({ repeat: { byte, times } })

function write(name, payload) {
  const path = resolve(vectorsDir, name)
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  console.log(`已生成 ${payload.cases.length} 条向量 → ${path}`)
}

// ---------------------------------------------------------------- SHA-256
const sha256Cases = [
  { name: '空串', input: { utf8: '' } },
  { name: 'abc', input: { utf8: 'abc' } },
  { name: 'FIPS 常见 56 字节', input: { utf8: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq' } },
  { name: '单个字节 0x00', input: { bytes: [0] } },
  { name: '单字节边界 len=54', input: rep(97, 54) },
  { name: '填充边界 len=55', input: rep(97, 55) },
  { name: '进入新块 len=56', input: rep(97, 56) },
  { name: '填充边界 len=63', input: rep(97, 63) },
  { name: '整块 len=64', input: rep(97, 64) },
  { name: '整块+1 len=65', input: rep(97, 65) },
  { name: '双块边界 len=119', input: rep(97, 119) },
  { name: '双块 len=120', input: rep(97, 120) },
  { name: '一百万个 a', input: rep(97, 1000000) },
  { name: '多字节 UTF-8（中文）', input: { utf8: '许七安密匣 · XUQIAN 加密站' } },
]
write('sha256_vectors.json', {
  algorithm: 'sha256',
  specSection: 'SPEC 第 5 节阶段一 —— sha256.js，跑 FIPS 180-4 测试向量',
  generatedBy: 'node:crypto (OpenSSL 独立实现)，见 tools/gen_vectors.js',
  note: '期望值由 OpenSSL 算出，与被测的自研实现相互独立；不要手改此文件，改请重跑生成器。',
  cases: sha256Cases.map((c) => ({
    name: c.name,
    input: c.input,
    expect: createHash('sha256').update(materialize(c.input)).digest('hex'),
  })),
})

// ------------------------------------------------------------------ HMAC
const longText =
  'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'
const hmacCases = [
  { name: 'RFC4231-1 短密钥 20×0x0b', key: rep(0x0b, 20), message: { utf8: 'Hi There' } },
  { name: 'RFC4231-2 文本密钥 Jefe', key: { utf8: 'Jefe' }, message: { utf8: 'what do ya want for nothing?' } },
  { name: 'RFC4231-3 20×0xaa / 50×0xdd', key: rep(0xaa, 20), message: rep(0xdd, 50) },
  { name: 'RFC4231-4 25 字节递增密钥 / 50×0xcd', key: { bytes: Array.from({ length: 25 }, (_, i) => i + 1) }, message: rep(0xcd, 50) },
  { name: 'RFC4231-6 超块长密钥 131×0xaa', key: rep(0xaa, 131), message: { utf8: 'Test Using Larger Than Block-Size Key - Hash Key First' } },
  { name: 'RFC4231-7 超块长密钥 + 超块长数据', key: rep(0xaa, 131), message: { utf8: longText } },
  { name: '密钥恰好 64 字节（不哈希边界）', key: rep(0x5c, 64), message: { utf8: 'boundary-64' } },
  { name: '密钥 65 字节（触发先哈希）', key: rep(0x5c, 65), message: { utf8: 'boundary-65' } },
  { name: '空密钥 + 空消息', key: { bytes: [] }, message: { bytes: [] } },
]
write('hmac_vectors.json', {
  algorithm: 'hmac-sha256',
  specSection: 'SPEC 第 5 节阶段一 —— hmac.js，跑 RFC 4231 测试向量',
  generatedBy: 'node:crypto (OpenSSL 独立实现)，见 tools/gen_vectors.js',
  note: 'RFC 4231 即 HMAC-SHA256 的官方向量集，与 SPEC 的算法清单一致。',
  cases: hmacCases.map((c) => ({
    name: c.name,
    key: c.key,
    message: c.message,
    expect: createHmac('sha256', materialize(c.key)).update(materialize(c.message)).digest('hex'),
  })),
})

// ---------------------------------------------------------------- PBKDF2
const pbkdf2Cases = [
  { name: 'passwd/salt/c=1/dkLen=64（RFC 7914 §11 用例）', password: { utf8: 'passwd' }, salt: { utf8: 'salt' }, iterations: 1, dkLen: 64 },
  { name: 'Password/NaCl/c=80000/dkLen=64（RFC 7914 §11 用例）', password: { utf8: 'Password' }, salt: { utf8: 'NaCl' }, iterations: 80000, dkLen: 64 },
  { name: 'passwd/salt/c=4096/dkLen=32', password: { utf8: 'passwd' }, salt: { utf8: 'salt' }, iterations: 4096, dkLen: 32 },
  { name: '空口令 / 空盐 / c=1', password: { bytes: [] }, salt: { bytes: [] }, iterations: 1, dkLen: 32 },
  { name: '8×0x00 口令 / 4×0x00 盐 / c=1', password: rep(0, 8), salt: rep(0, 4), iterations: 1, dkLen: 32 },
  { name: '多块输出 dkLen=100（4 块，末块截断）', password: { utf8: 'multi-block' }, salt: { utf8: 'salty' }, iterations: 2, dkLen: 100 },
  { name: '极端短输出 dkLen=1', password: { utf8: 'short' }, salt: { utf8: 's' }, iterations: 3, dkLen: 1 },
  { name: '长口令（>块长的密钥路径）', password: rep(0x61, 100), salt: rep(0x62, 40), iterations: 2, dkLen: 48 },
]
write('pbkdf2_vectors.json', {
  algorithm: 'pbkdf2-hmac-sha256',
  specSection: 'SPEC 第 5 节阶段一 —— pbkdf2.js',
  generatedBy: 'node:crypto pbkdf2Sync(..., "sha256") (OpenSSL 独立实现)，见 tools/gen_vectors.js',
  specConflict:
    'SPEC §5 写的是「跑 RFC 6070 测试向量」，但 RFC 6070 是 PBKDF2-HMAC-SHA1 的向量集；' +
    '使用它需要实现 SHA-1，而 SHA-1 不在 SPEC §7 允许自研的算法清单内。故此处改用 PBKDF2-HMAC-SHA256 向量（含 RFC 7914 §11 的两个公开用例）。',
  cases: pbkdf2Cases.map((c) => ({
    name: c.name,
    password: c.password,
    salt: c.salt,
    iterations: c.iterations,
    dkLen: c.dkLen,
    expect: pbkdf2Sync(materialize(c.password), materialize(c.salt), c.iterations, c.dkLen, 'sha256').toString('hex'),
  })),
})

// ------------------------------------------------------------------- AES
const bytes = (arr) => ({ bytes: arr })
const seq = (start, len) => bytes(Array.from({ length: len }, (_, i) => start + i))

const aesCases = [
  { name: 'FIPS197 C.1 AES-128', algo: 'aes-128-ecb', key: seq(0x00, 16), plaintext: bytes([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]) },
  { name: 'FIPS197 C.2 AES-192', algo: 'aes-192-ecb', key: seq(0x00, 24), plaintext: bytes([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]) },
  { name: 'FIPS197 C.3 AES-256', algo: 'aes-256-ecb', key: seq(0x00, 32), plaintext: bytes([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]) },
  { name: '全零密钥 / 全零分组', algo: 'aes-128-ecb', key: rep(0x00, 16), plaintext: rep(0x00, 16) },
  { name: '全 ff 密钥 / 全 ff 分组', algo: 'aes-256-ecb', key: rep(0xff, 32), plaintext: rep(0xff, 16) },
  { name: 'AES-128 随机样态', algo: 'aes-128-ecb', key: bytes([0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf, 0x4f, 0x3c]), plaintext: bytes([0x6b, 0xc1, 0xbe, 0xe2, 0x2e, 0x40, 0x9f, 0x96, 0xe9, 0x3d, 0x7e, 0x11, 0x73, 0x93, 0x17, 0x2a]) },
]

const ecbEncrypt = (algo, key, block) => {
  const c = createCipheriv(algo, key, null)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(Buffer.from(block)), c.final()])
}

write('aes_vectors.json', {
  algorithm: 'aes-block',
  specSection: 'SPEC 第 5 节阶段一 —— aes.js 密钥扩展 + 单块加密，跑 FIPS 197 测试向量',
  generatedBy: 'node:crypto createCipheriv(*-ecb, setAutoPadding(false)) (OpenSSL 独立实现)，见 tools/gen_vectors.js',
  cases: aesCases.map((c) => ({
    name: c.name,
    algo: c.algo,
    key: c.key,
    plaintext: c.plaintext,
    expect: hex(ecbEncrypt(c.algo, materialize(c.key), materialize(c.plaintext))),
  })),
})

// ------------------------------------------------------------------- CTR
const ctrKey128 = bytes([0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6, 0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf, 0x4f, 0x3c])
const ctrKey192 = bytes([0x8e, 0x73, 0xb0, 0xf7, 0xda, 0x0e, 0x64, 0x52, 0xc8, 0x10, 0xf3, 0x2b, 0x80, 0x90, 0x79, 0xe5, 0x62, 0xf8, 0xea, 0xd2, 0x52, 0x2c, 0x6b, 0x7b])
const ctrKey256 = bytes([0x60, 0x3d, 0xeb, 0x10, 0x15, 0xca, 0x71, 0xbe, 0x2b, 0x73, 0xae, 0xf0, 0x85, 0x7d, 0x77, 0x81, 0x1f, 0x35, 0x2c, 0x07, 0x3b, 0x61, 0x08, 0xd7, 0x2d, 0x98, 0x10, 0xa3, 0x09, 0x14, 0xdf, 0xf4])
const ctrInitial = bytes([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff])
// SP 800-38A F.5.1 的 4 个明文块（保留原始数组，便于截取子串构造其它用例）
const CTR_PLAIN_RAW = [
  0x6b, 0xc1, 0xbe, 0xe2, 0x2e, 0x40, 0x9f, 0x96, 0xe9, 0x3d, 0x7e, 0x11, 0x73, 0x93, 0x17, 0x2a,
  0xae, 0x2d, 0x8a, 0x57, 0x1e, 0x03, 0xac, 0x9c, 0x9e, 0xb7, 0x6f, 0xac, 0x45, 0xaf, 0x8e, 0x51,
  0x30, 0xc8, 0x1c, 0x46, 0xa3, 0x5c, 0xe4, 0x11, 0xe5, 0xfb, 0xc1, 0x19, 0x1a, 0x0a, 0x52, 0xef,
  0xf6, 0x9f, 0x24, 0x45, 0xdf, 0x4f, 0x9b, 0x17, 0xad, 0x2b, 0x41, 0x7b, 0xe6, 0x6c, 0x37, 0x10,
]
const ctrPlain15 = bytes(CTR_PLAIN_RAW)

const ctrCases = [
  { name: 'SP800-38A F.5.1 CTR-AES128（4 块）', algo: 'aes-128-ctr', key: ctrKey128, counter: ctrInitial, plaintext: ctrPlain15 },
  { name: 'SP800-38A F.5.3 CTR-AES192（4 块）', algo: 'aes-192-ctr', key: ctrKey192, counter: ctrInitial, plaintext: ctrPlain15 },
  { name: 'SP800-38A F.5.5 CTR-AES256（4 块）', algo: 'aes-256-ctr', key: ctrKey256, counter: ctrInitial, plaintext: ctrPlain15 },
  { name: '非整块长度 17 字节（跨块边界）', algo: 'aes-128-ctr', key: ctrKey128, counter: ctrInitial, plaintext: bytes(Array.from({ length: 17 }, (_, i) => i)) },
  { name: '空输入', algo: 'aes-128-ctr', key: ctrKey128, counter: ctrInitial, plaintext: bytes([]) },
  { name: '计数器末字节全 ff（回绕到全零）', algo: 'aes-128-ctr', key: ctrKey128, counter: bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff]), plaintext: bytes(CTR_PLAIN_RAW.slice(0, 32)) },
]

const ctrEncrypt = (algo, key, counter, data) => {
  const c = createCipheriv(algo, materialize(key), materialize(counter))
  c.setAutoPadding(false)
  return Buffer.concat([c.update(materialize(data)), c.final()])
}

write('ctr_vectors.json', {
  algorithm: 'aes-ctr',
  specSection: 'SPEC 第 5 节阶段一 —— ctr.js，跑 NIST SP 800-38A 测试向量',
  generatedBy: 'node:crypto createCipheriv(*-ctr) (OpenSSL 独立实现)，见 tools/gen_vectors.js',
  note: 'CTR 加解密同构：同一份密文再用同样参数跑一遍即可还原明文，测试里会双向验证。',
  cases: ctrCases.map((c) => ({
    name: c.name,
    algo: c.algo,
    key: c.key,
    counter: c.counter,
    plaintext: c.plaintext,
    expect: hex(ctrEncrypt(c.algo, c.key, c.counter, c.plaintext)),
  })),
})
