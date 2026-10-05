/**
 * 本地存储：把**密文**存进浏览器 IndexedDB —— SPEC 第 5 节阶段六「纯前端方案写 indexeddb.js 存密文」。
 * 零第三方依赖（SPEC §7）。
 *
 * ⚠ 三条红线（SPEC §7），本模块用**允许字段白名单**强制执行：
 *   ① 「禁止把主密码密钥明文写入日志、存储或网络」→ 记录里只允许出现密文与展示用的元信息；
 *      任何 key / passphrase / secret / WK 字段都会被 `assertNoKeyMaterial` 拒绝写入。
 *   ② 「禁止在服务器端存明文密钥」→ 本模块只在浏览器本地落库，不做任何网络请求。
 *   ③ 「禁止用 UTF-8 文本格式存储密文文件」→ 落库的是**原始字节**（Uint8Array），不做 base64/文本化。
 *
 * 换句话说：这里存的东西**本来就是加密后的字节**，读出来也没有密钥可用；
 * 密钥永远只在用户手上（写下来 / 密钥文件），本模块不接触、不缓存、不代管。
 */

export const DB_NAME = 'xuqian-self-crypto'
export const DB_VERSION = 1
export const STORE = 'ciphertext'

/**
 * 允许落库的字段。**白名单**而非黑名单：新增字段必须显式加进来，
 * 避免"顺手多存一个密钥"这种无声的越界。
 */
export const ALLOWED_FIELDS = Object.freeze(['id', 'name', 'bytes', 'size', 'savedAt', 'version', 'note'])

/** 记录形状里的 id 规则：由密文自身派生，便于"同一密文重复保存"时去重。 */
export function recordId(name, bytes) {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${bytes.length}-${hash.toString(16).padStart(8, '0')}-${String(name).slice(0, 64)}`
}

/**
 * 拒绝写入任何密钥类字段。**会递归检查嵌套对象与数组**，不只查顶层。
 * 抛出的错误信息刻意不包含字段值（避免把疑似密钥打进日志）。
 */
export function assertNoKeyMaterial(record, path = 'record') {
  if (record === null || typeof record !== 'object') return true
  if (Array.isArray(record)) {
    record.forEach((item, i) => assertNoKeyMaterial(item, `${path}[${i}]`))
    return true
  }
  if (record instanceof Uint8Array) return true
  for (const [key, value] of Object.entries(record)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      throw new Error(`本地存储只允许这些字段：${ALLOWED_FIELDS.join(', ')}；出现了「${path}.${key}」`)
    }
    assertNoKeyMaterial(value, `${path}.${key}`)
  }
  return true
}

/** 校验一条待写入记录（形状 + 安全性）。 */
export function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('记录必须是对象')
  assertNoKeyMaterial(record)
  if (!(record.bytes instanceof Uint8Array)) throw new TypeError('只接受 Uint8Array 形式的密文')
  if (record.bytes.length === 0) throw new RangeError('空密文不应入库')
  if (typeof record.name !== 'string' || record.name.length === 0) throw new TypeError('记录必须有名字')
  return record
}

/** 是否具备 IndexedDB 能力（Node 环境或隐私模式下可能没有）。 */
export function isAvailable() {
  return typeof indexedDB !== 'undefined'
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

/** 打开（必要时创建）数据库。 */
export function openDatabase() {
  if (!isAvailable()) return Promise.reject(new Error('当前环境没有 IndexedDB'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开本地库失败'))
  })
}

/** 存一条密文（只涉及密文与展示信息，绝不涉及密钥）。 */
export async function saveCiphertext({ name, bytes, version = 1, note = '', savedAt = Date.now() }) {
  const record = validateRecord({
    id: recordId(name, bytes),
    name,
    bytes,
    size: bytes.length,
    savedAt,
    version,
    note,
  })
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('写入本地库失败'))
      tx.onabort = () => reject(tx.error ?? new Error('写入本地库被中止'))
    })
    return record.id
  } finally {
    db.close()
  }
}

/** 列出已存密文（**不含字节**，避免把整库密文读进内存）。 */
export async function listCiphertexts() {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const all = await requestToPromise(tx.objectStore(STORE).getAll())
    return all
      .map(({ id, name, size, savedAt, version, note }) => ({ id, name, size, savedAt, version, note }))
      .sort((a, b) => b.savedAt - a.savedAt)
  } finally {
    db.close()
  }
}

/** 读出一条密文（返回原始字节，供解密流程使用）。 */
export async function loadCiphertext(id) {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const record = await requestToPromise(tx.objectStore(STORE).get(id))
    if (!record) throw new Error('本地库里没有这条记录')
    return { id: record.id, name: record.name, bytes: new Uint8Array(record.bytes), version: record.version }
  } finally {
    db.close()
  }
}

export async function deleteCiphertext(id) {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('删除失败'))
    })
    return true
  } finally {
    db.close()
  }
}

export async function clearAll() {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('清空失败'))
    })
    return true
  } finally {
    db.close()
  }
}

/** 本地配额用量（用于界面上如实说明"数据存在本机"）。 */
export async function storageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

/**
 * 密文库用量汇总（决策 D38）。
 *
 * 为什么要它：只告诉用户"已存入"是不够的 —— 浏览器配额满了以后写入会**静默失败或抛错**，
 * 用户往往在丢失数据时才意识到。这里把"库里多少条 / 多少字节 / 占配额多少"摆出来，
 * 并在接近上限时提前警告。
 *
 * 注意：**只警告、不自动删**。自动清理用户数据是不可接受的行为（可能是唯一一份密文）。
 */
export async function libraryUsage() {
  const list = await listCiphertexts()
  const bytes = list.reduce((sum, item) => sum + (item.size ?? 0), 0)
  const estimate = await storageEstimate()
  const ratio = estimate && estimate.quota > 0 ? estimate.usage / estimate.quota : null
  return {
    records: list.length,
    bytes,
    usage: estimate?.usage ?? null,
    quota: estimate?.quota ?? null,
    ratio,
    /** 接近上限的阈值：≥80% 视为需要提醒（经验值，见 D38）。 */
    nearQuota: ratio !== null && ratio >= 0.8,
  }
}

// ---------------------------------------------------------------------------
// 整库导出 / 导入（决策 D36）
//
// 为什么需要：本地密文库存在浏览器里，**用户清一次浏览器数据就全没了**。
// 导出一份备份能把"清数据即丢"变成"可自救"。
//
// 格式（自定义二进制，刻意**不用 base64/JSON**）：
//   magic(8) = "XQLIB" + 0x00 0x00 0x01   count(4 BE)
//   每条记录：nameLen(1) name(UTF-8) dataLen(4 BE) data dataVersion(1) savedAt(8 BE)
//
// 说明：备份里**只有密文与展示信息、没有密钥** —— 备份文件泄露不等于明文泄露。
// ---------------------------------------------------------------------------

export const ARCHIVE_MAGIC = Object.freeze([0x58, 0x51, 0x4c, 0x49, 0x42, 0x00, 0x00, 0x01]) // "XQLIB" + 版本 1

/** 把若干条记录打包成备份字节。 */
export function exportLibraryArchive(records) {
  if (!Array.isArray(records)) throw new TypeError('记录列表必须是数组')
  for (const record of records) validateRecord(record)

  const encoded = records.map((record) => {
    const name = new TextEncoder().encode(record.name)
    if (name.length > 255) throw new RangeError(`记录名过长：${record.name}`)
    return { name, bytes: record.bytes, version: record.version ?? 1, savedAt: BigInt(record.savedAt ?? Date.now()) }
  })

  let total = ARCHIVE_MAGIC.length + 4
  for (const item of encoded) total += 1 + item.name.length + 4 + item.bytes.length + 1 + 8

  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let off = 0
  out.set(ARCHIVE_MAGIC, off)
  off += ARCHIVE_MAGIC.length
  dv.setUint32(off, records.length)
  off += 4

  for (const item of encoded) {
    out[off] = item.name.length
    off += 1
    out.set(item.name, off)
    off += item.name.length
    dv.setUint32(off, item.bytes.length)
    off += 4
    out.set(item.bytes, off)
    off += item.bytes.length
    out[off] = item.version & 0xff
    off += 1
    dv.setBigUint64(off, item.savedAt)
    off += 8
  }
  return out
}

/** 解析备份字节。要求整块被消费完（尾部多余字节即报错，避免"被追加过内容"悄悄通过）。 */
export function importLibraryArchive(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('备份必须是字节串')
  const headerLen = ARCHIVE_MAGIC.length + 4
  if (bytes.length < headerLen) throw new RangeError('备份文件过短')
  for (let i = 0; i < ARCHIVE_MAGIC.length; i++) {
    if (bytes[i] !== ARCHIVE_MAGIC[i]) throw new RangeError('不是本工具的密文库备份（magic 不匹配）')
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = dv.getUint32(ARCHIVE_MAGIC.length)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const records = []
  let off = headerLen

  for (let i = 0; i < count; i++) {
    if (off + 1 > bytes.length) throw new RangeError('备份损坏：记录头不完整')
    const nameLen = bytes[off]
    off += 1
    if (off + nameLen + 4 > bytes.length) throw new RangeError('备份损坏：记录名越界')
    const name = decoder.decode(bytes.subarray(off, off + nameLen))
    off += nameLen
    const dataLen = dv.getUint32(off)
    off += 4
    if (off + dataLen + 1 + 8 > bytes.length) throw new RangeError('备份损坏：密文越界')
    const data = bytes.slice(off, off + dataLen)
    off += dataLen
    const version = bytes[off]
    off += 1
    const savedAt = Number(dv.getBigUint64(off))
    off += 8
    records.push({ id: recordId(name, data), name, bytes: data, size: data.length, savedAt, version, note: '' })
  }
  if (off !== bytes.length) throw new RangeError('备份尾部有多余字节（可能被追加过内容）')
  return records
}

/** 导出整个本地密文库（需要 IndexedDB）。 */
export async function exportAllCiphertexts() {
  const listed = await listCiphertexts()
  const records = []
  for (const item of listed) {
    const full = await loadCiphertext(item.id)
    records.push({
      id: item.id,
      name: full.name,
      bytes: full.bytes,
      size: full.bytes.length,
      savedAt: item.savedAt,
      version: full.version ?? 1,
      note: '',
    })
  }
  return exportLibraryArchive(records)
}

/** 导入一份备份，返回成功条数（同名同内容的记录会覆盖，不重复堆积）。 */
export async function importCiphertextsFromArchive(bytes) {
  const records = importLibraryArchive(bytes)
  let saved = 0
  for (const record of records) {
    await saveCiphertext({ name: record.name, bytes: record.bytes, version: record.version, savedAt: record.savedAt })
    saved += 1
  }
  return saved
}
