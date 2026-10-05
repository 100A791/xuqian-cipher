/**
 * .XUQIAN 流式加解密引擎。
 *
 * 与 container.ts 的关系：
 * - 本文件是**唯一的实现**，`container.ts` 的 `encryptContainer` / `decryptContainer`
 *   已改为调用本引擎的内存适配器（数组 source + 收集 sink），签名与语义保持不变。
 * - **文件格式完全不变**：仍然是 .XUQIAN v1，头部 + 若干块，每块
 *   `[第 L−1 层完整 AEAD 输出][tag_0]…[tag_{L−2}]`。因此旧文件全部仍可解，
 *   浏览器产物与命令行产物可以互解。
 *
 * 为什么能流式化：容器格式本来就是"分块 + 每块独立 nonce"，块边界由
 * `planChunks(明文总长, chunkSize, 层数)` 唯一决定。所以只要调用方提供明文总长，
 * 就能一块一块地读、加密、写，内存占用与文件总大小解耦（只与单块大小相关）。
 *
 * 内存边界：单块最多 `chunkSize` 字节，多层加密过程中峰值约为
 * `chunkSize × (1 + 层数×16/chunkSize)`，即约 1 倍块大小 + 每层 16 字节。
 */
import { getAead, getAlgoSpec, type AlgoId } from './aead.ts'
import {
  DEFAULT_CHUNK_SIZE,
  FORMAT_VERSION,
  HEADER_FLAG_GZIP,
  HEADER_FIXED_LEN,
  HEADER_LEN_OFFSET,
  MAX_LAYERS,
  MIN_LAYERS,
  TAG_BYTES,
  FormatError,
  hasMagic,
  headerAad,
  parseHeader,
  planChunks,
  serializeHeader,
  type ChunkPlan,
  type XuqianHeader,
  type XuqianMeta,
} from './container.ts'
import { base64ToBytes, bytesToBase64, bytesToHex, concatBytes } from './encoding.ts'
import { MasterKey, randomBytes, SALT_BYTES } from './keys.ts'
import { copyBytes, zeroize } from './zeroize.ts'
import { sha256 } from '@noble/hashes/sha2.js'

/** 可重复迭代的字节源：加密需要两遍（先算 meta.h，再加密）。 */
export interface ByteSource extends AsyncIterable<Uint8Array> {}

/** 字节汇：每块处理完立刻写入，绝不累积。 */
export interface ByteSink {
  write(chunk: Uint8Array): void | Promise<void>
}

export type ProgressFn = (done: number, total: number, phase?: 'encrypt' | 'decrypt') => void

export interface StreamEncryptOptions {
  layers: AlgoId[]
  /** 明文总长度。分块布局与头部 meta.s 都由它唯一决定 */
  plaintextLength: number
  chunkSize?: number
  /** 声明"容器内明文来自 gzip 压缩"。引擎不做压缩，由调用方负责 */
  gzip?: boolean
  meta?: XuqianMeta
  onProgress?: ProgressFn
  /** 随机字节源（默认 CSPRNG；测试可注入确定性序列） */
  randomFn?: (length: number) => Uint8Array
  /**
   * 强制重新扫描内容并重算 `meta.h`（覆盖调用方传入的值）。
   * 内存适配器使用它来保持"哈希永远取自实际内容"的旧语义。
   */
  forceHashScan?: boolean
}

export interface StreamEncryptResult {
  header: XuqianHeader
  /** 容器内明文的 SHA-256（大写 Hex） */
  sourceHash: string
  outputSize: number
}

export interface StreamDecryptResult {
  header: XuqianHeader
  headerLength: number
  plaintextLength: number
}

/** 数组字节源：把若干字节块当成可重复迭代的源。 */
export function bufferSource(chunks: Uint8Array[]): ByteSource {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 收集型字节汇：把写入的块累积到数组（内存适配器使用）。 */
export function collectingSink(): { sink: ByteSink; parts: Uint8Array[]; total(): number } {
  const parts: Uint8Array[] = []
  let total = 0
  return {
    parts,
    total: () => total,
    sink: {
      write(chunk) {
        parts.push(copyBytes(chunk))
        total += chunk.length
      },
    },
  }
}

/**
 * 异步字节队列：把"推入"的字节块变成可异步迭代的源。
 * 供命令行管道（stdin / zlib 变换流）使用。
 *
 * `replayable()` 返回**可重复迭代**的变体（缓存所有已推送的块），
 * 因为 `encryptStream` 需要遍历两遍（先算 meta.h 再加密）。
 * 非重放模式下为真正的单遍流，内存不累积。
 */
export class ByteQueue implements AsyncIterable<Uint8Array> {
  #chunks: Uint8Array[] = []
  #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = []
  #ended = false
  #replayable: boolean
  #history: Uint8Array[] = []

  constructor(options: { replayable?: boolean } = {}) {
    this.#replayable = options.replayable === true
  }

  push(chunk: Uint8Array): void {
    if (this.#ended) throw new Error('QUEUE_ENDED')
    if (chunk.length === 0) return
    if (this.#replayable) this.#history.push(chunk)
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: chunk, done: false })
    else this.#chunks.push(chunk)
  }

  end(): void {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#replayable) {
      // 重放模式：先吐已缓存的历史，再跟随实时推送
      let index = 0
      for (;;) {
        if (index < this.#history.length) {
          yield this.#history[index++]
          continue
        }
        if (this.#ended) return
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    }
    for (;;) {
      const ready = this.#chunks.shift()
      if (ready) {
        yield ready
        continue
      }
      if (this.#ended) return
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => this.#waiters.push(resolve))
      if (next.done) return
      yield next.value
    }
  }
}

/** 带"精确读取"能力的读数器：内部持有 source 的迭代器并按需缓冲。 */
export class ByteReader {
  #iterator: AsyncIterator<Uint8Array>
  #buffered: Uint8Array = new Uint8Array(0)
  #eof = false
  /** 已消费的字节数（用于"是否还有多余数据"判断） */
  consumed = 0

  constructor(source: ByteSource) {
    this.#iterator = source[Symbol.asyncIterator]()
  }

  /** 精确读取恰好 length 字节；不足则抛错。 */
  async readExactly(length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0)
    if (this.#buffered.length >= length) {
      const out = this.#buffered.subarray(0, length)
      this.#buffered = this.#buffered.subarray(length)
      this.consumed += length
      return copyBytes(out)
    }
    const parts: Uint8Array[] = this.#buffered.length > 0 ? [this.#buffered] : []
    let have = this.#buffered.length
    this.#buffered = new Uint8Array(0)
    while (have < length) {
      const next = await this.#iterator.next()
      if (next.done) {
        this.#eof = true
        break
      }
      const value = next.value
      if (!value || value.length === 0) continue
      const need = length - have
      if (value.length <= need) {
        parts.push(value)
        have += value.length
      } else {
        parts.push(value.subarray(0, need))
        this.#buffered = copyBytes(value.subarray(need))
        have = length
      }
    }
    if (have < length) throw new FormatError('SOURCE_TRUNCATED')
    const out = parts.length === 1 ? copyBytes(parts[0]) : concatBytes(...parts)
    this.consumed += out.length
    return out
  }

  /** 读取最多 length 字节（可能少于 length，EOF 时返回已读部分）。 */
  async readUpTo(length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0)
    if (this.#buffered.length >= length) return this.readExactly(length)
    const first = this.#buffered
    this.#buffered = new Uint8Array(0)
    const parts: Uint8Array[] = []
    let have = 0
    if (first.length > 0) {
      const take = first.subarray(0, length)
      parts.push(take)
      have = take.length
      if (first.length > take.length) this.#buffered = copyBytes(first.subarray(take.length))
    }
    while (have < length) {
      const next = await this.#iterator.next()
      if (next.done) {
        this.#eof = true
        break
      }
      const value = next.value
      if (!value || value.length === 0) continue
      const need = length - have
      if (value.length <= need) {
        parts.push(value)
        have += value.length
      } else {
        parts.push(value.subarray(0, need))
        this.#buffered = copyBytes(value.subarray(need))
        have = length
      }
    }
    if (parts.length === 0) return new Uint8Array(0)
    const out = parts.length === 1 ? copyBytes(parts[0]) : concatBytes(...parts)
    this.consumed += out.length
    return out
  }

  /** 检查是否还有剩余数据（buffered 或 source 未结束）。 */
  async hasMore(): Promise<boolean> {
    if (this.#buffered.length > 0) return true
    if (this.#eof) return false
    for (;;) {
      const next = await this.#iterator.next()
      if (next.done) {
        this.#eof = true
        return false
      }
      const value = next.value
      if (!value || value.length === 0) continue
      this.#buffered = copyBytes(value)
      return true
    }
  }
}

/** 计算可重复迭代源的 SHA-256（第一遍预扫，用于把 meta.h 写进 AAD）。 */
async function hashSource(source: ByteSource, expectedLength: number): Promise<{ hash: string; bytes: number }> {
  const hasher = sha256.create()
  let total = 0
  for await (const chunk of source) {
    if (!chunk || chunk.length === 0) continue
    hasher.update(chunk)
    total += chunk.length
    // 提前发现"源比声明的长"，给出比长度不符更准确的错误
    if (total > expectedLength) throw new FormatError('SOURCE_TRAILING_DATA')
  }
  if (total !== expectedLength) throw new FormatError('SOURCE_LENGTH_MISMATCH')
  return { hash: bytesToHex(hasher.digest()).toUpperCase(), bytes: total }
}

/**
 * 流式加密：写入 = 头部 + Σ 块。
 *
 * 会遍历 source **两遍**（先算哈希、再加密），因此 `source` 必须是可重复迭代的。
 * 想避免两遍可以传 `meta.h`，此时只遍历一遍。
 */
export async function encryptStream(
  source: ByteSource,
  sink: ByteSink,
  masterKey: MasterKey,
  options: StreamEncryptOptions,
): Promise<StreamEncryptResult> {
  const algos = options.layers
  if (algos.length < MIN_LAYERS || algos.length > MAX_LAYERS) throw new Error('LAYER_COUNT_INVALID')
  const layerCount = algos.length
  const tagsPerChunk = algos.reduce((sum, a) => sum + getAlgoSpec(a).tagLength, 0)
  if (tagsPerChunk !== layerCount * TAG_BYTES) throw new Error('UNSUPPORTED_TAG_LENGTH')

  const chunkSize = Math.max(tagsPerChunk + 1, options.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const flags = options.gzip ? HEADER_FLAG_GZIP : 0
  const plaintextLength = options.plaintextLength
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0) throw new FormatError('META_SIZE_INVALID')

  const plan = planChunks(plaintextLength, chunkSize, layerCount)

  // 1) 内容哈希：它参与 AAD，因此必须在写头部之前定下来。
  //    只有调用方明确声明"已自行预扫"（提供 meta.h 且未要求强制重算）时才跳过第一遍。
  const providedHash =
    !options.forceHashScan && typeof options.meta?.h === 'string' && options.meta.h.length > 0
      ? options.meta.h.toUpperCase()
      : null
  const sourceHash = providedHash ?? (await hashSource(source, plaintextLength)).hash

  // 2) 每层随机 salt 与 nonce 种子 → 派生子密钥
  const random = options.randomFn ?? randomBytes
  const layers = algos.map((algo, index) => {
    const salt = random(SALT_BYTES)
    const nonceSeed = random(SALT_BYTES)
    return { algo, salt, nonceSeed, subkey: masterKey.deriveSubkey(algo, index, salt) }
  })

  const header: XuqianHeader = {
    v: FORMAT_VERSION,
    flags,
    cs: chunkSize,
    cc: plan.chunkCount,
    lc: layerCount,
    layers: layers.map((l) => ({ a: l.algo, s: bytesToBase64(l.salt), n: bytesToBase64(l.nonceSeed) })),
    meta: { ...options.meta, s: plaintextLength, h: sourceHash },
    crc: 0,
  }
  const aad = headerAad(header)
  const headerBytes = serializeHeader(header)
  await sink.write(headerBytes)

  // 3) 逐块加密
  const reader = new ByteReader(source)
  let written = headerBytes.length
  let processed = 0

  try {
    for (let chunkIndex = 0; chunkIndex < plan.chunkCount; chunkIndex++) {
      const plainSize = plan.plainSizes[chunkIndex]
      const blockTotal = plan.blockTotals[chunkIndex]
      const block = new Uint8Array(blockTotal)

      let current = await reader.readExactly(plainSize)
      // 逐层加密并**当场收集**每层 tag。
      // 第 k 层的 tag 是第 k 层输出（长度 plainSize + (k+1)×16）的末尾 16 字节。
      const layerTags: Uint8Array[] = []
      for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
        const layer = layers[layerIndex]
        const nonce = masterKey.deriveNonce(layer.algo, layerIndex, chunkIndex, layer.nonceSeed)
        const sealed = await getAead(layer.algo).seal(layer.subkey, nonce, current, aad)
        zeroize(nonce)
        if (sealed.length !== current.length + TAG_BYTES) throw new Error('AEAD_LENGTH_MISMATCH')
        layerTags.push(copyBytes(sealed.subarray(sealed.length - TAG_BYTES)))
        zeroize(current)
        current = sealed
      }

      const headLen = plainSize + layerCount * TAG_BYTES
      if (current.length !== headLen) throw new Error('AEAD_LENGTH_MISMATCH')
      // 块内布局：[第 L−1 层完整输出 headLen][tag_0][tag_1]…[tag_{L−2}]
      // 第 L−1 层的 tag 已在 head 的末尾；其余层的 tag 依次追加，
      // 位置与解密端 `block[headLen + k×16]` 的读取位置一一对应。
      block.set(current, 0)
      for (let layerIndex = 0; layerIndex < layerCount - 1; layerIndex++) {
        block.set(layerTags[layerIndex], headLen + layerIndex * TAG_BYTES)
      }
      zeroize(current)
      for (const tag of layerTags) zeroize(tag)

      await sink.write(block)
      zeroize(block)

      written += blockTotal
      processed += plainSize
      options.onProgress?.(processed, plaintextLength, 'encrypt')
    }
  } finally {
    for (const layer of layers) zeroize(layer.subkey, layer.salt, layer.nonceSeed)
  }

  if (await reader.hasMore()) throw new FormatError('SOURCE_TRAILING_DATA')

  return { header, sourceHash, outputSize: written }
}

/** 解析流中的文件头。返回头部与头部总长度。 */
export async function readStreamHeader(reader: ByteReader): Promise<{ header: XuqianHeader; headerLength: number }> {
  // 先读"固定头 + headerLen 字段"（HEADER_FIXED_LEN = 17，headerLen 占紧随其后的 4 字节），
  // 再按 headerLen 读 headerJson —— 两段式，因为 JSON 长度可变。
  const fixed = await reader.readExactly(HEADER_FIXED_LEN + 4)
  if (!hasMagic(fixed)) throw new FormatError('MAGIC_MISMATCH')
  const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength)
  const version = fixed[6]
  if (version !== FORMAT_VERSION) throw new FormatError('VERSION_UNSUPPORTED')
  const jsonLen = view.getUint32(HEADER_LEN_OFFSET)
  if (jsonLen <= 0) throw new FormatError('HEADER_TRUNCATED')
  const rest = await reader.readExactly(jsonLen)
  const full = concatBytes(fixed, rest)
  // 复用 container.ts 的解析与校验逻辑（含 CRC 与字段合法性）
  return parseHeader(full)
}

/**
 * 流式解密：读头部 → 逐块逆序剥层 → 写出。
 * 全程只驻留单块，内存有界。
 */
export async function decryptStream(
  source: ByteSource,
  sink: ByteSink,
  masterKey: MasterKey,
  onProgress?: ProgressFn,
): Promise<StreamDecryptResult> {
  const reader = new ByteReader(source)
  const { header, headerLength } = await readStreamHeader(reader)
  const layerCount = header.layers.length
  const tagsPerChunk = layerCount * TAG_BYTES
  if (tagsPerChunk >= header.cs) throw new FormatError('CHUNK_SIZE_INVALID')

  const declaredPlain = header.meta.s as number
  const plan = planChunks(declaredPlain, header.cs, layerCount)
  if (plan.chunkCount !== header.cc) throw new FormatError('CHUNK_LAYOUT_INVALID')

  const aad = headerAad(header)
  // 注意：子密钥不再一次性全部派生，而是由 openBlock 按块派生并立即擦除，
  // 这样"同时驻留的子密钥数量"从 L 个降到 1 个（大文件多层时内存与暴露面都更小）。

  let processed = 0
  try {
    for (let chunkIndex = 0; chunkIndex < plan.chunkCount; chunkIndex++) {
      const plainSize = plan.plainSizes[chunkIndex]
      const block = await reader.readExactly(plan.blockTotals[chunkIndex])
      const payload = await openBlock(header, block, plainSize, chunkIndex, aad, masterKey)

      await sink.write(payload)
      zeroize(payload)

      processed += plainSize
      onProgress?.(processed, declaredPlain)
    }
  } finally {
    /* 每块的子密钥已在 openBlock 内擦除；这里无需额外清理 */
  }

  if (await reader.hasMore()) throw new FormatError('TRAILING_DATA')

  return { header, headerLength, plaintextLength: processed }
}

/**
 * 剥开一块（块内所有层逆序解开），返回该块明文。
 * 调用方负责该块字节的生命周期；本函数负责擦除每层的中间明文与 nonce。
 *
 * 解密主循环与"密钥自检"共用它，保证两处行为严格一致。
 */
async function openBlock(
  header: XuqianHeader,
  block: Uint8Array,
  plainSize: number,
  chunkIndex: number,
  aad: Uint8Array,
  masterKey: MasterKey,
): Promise<Uint8Array> {
  const layerCount = header.layers.length
  const headLen = plainSize + layerCount * TAG_BYTES
  let payload = copyBytes(block.subarray(0, headLen - TAG_BYTES))
  for (let layerIndex = layerCount - 1; layerIndex >= 0; layerIndex--) {
    const layer = header.layers[layerIndex]
    const tagPos = layerIndex === layerCount - 1 ? headLen - TAG_BYTES : headLen + layerIndex * TAG_BYTES
    const tag = block.subarray(tagPos, tagPos + TAG_BYTES)
    const inputLen = plainSize + layerIndex * TAG_BYTES
    const sealed = concatBytes(payload.subarray(0, inputLen), tag)
    const subkey = masterKey.deriveSubkey(layer.a, layerIndex, base64ToBytes(layer.s))
    const nonce = masterKey.deriveNonce(layer.a, layerIndex, chunkIndex, base64ToBytes(layer.n))
    let out: Uint8Array
    try {
      out = await getAead(layer.a).open(subkey, nonce, sealed, aad)
    } catch {
      zeroize(payload, subkey, nonce)
      throw new Error('AUTH_FAILED')
    }
    zeroize(payload, subkey, nonce)
    payload = out
    if (payload.length !== plainSize + layerIndex * TAG_BYTES) throw new FormatError('PLAINTEXT_LENGTH_MISMATCH')
  }
  if (payload.length !== plainSize) throw new FormatError('PLAINTEXT_LENGTH_MISMATCH')
  return payload
}

export type { ChunkPlan }

// ---------------------------------------------------------------------------
// 密钥自检：只认证第一块，用来回答"这把密钥是不是这个文件的"
// ---------------------------------------------------------------------------

export interface KeyCheckResult {
  /** 密钥是否匹配且首块认证通过 */
  matched: boolean
  /** 文件头记录的算法层栈 */
  layers: AlgoId[]
  /** 容器内明文总长度（文件头声明） */
  plaintextLength: number
  /** 文件头记录的明文哈希（可能不存在） */
  declaredHash?: string
  /** 实际解出的首块哈希（仅单块文件时才有意义） */
  firstChunkHash: string
  /** 是否完成了"解出内容 vs 头部哈希"的全量比对（仅单块文件可能为 true） */
  hashVerified: boolean
}

/**
 * 只认证第一块来判定密钥是否匹配。
 *
 * 原理：AEAD 逐块独立认证，且 AAD 只覆盖固定头 + 规范化头部。因此**任意一块**
 * 都能独立判定密钥是否正确——块内任一字节不符都会让认证失败。
 * 所以自检不需要读完整文件：读头部 + 第一块即可。
 *
 * 注意：认证失败时无法区分"密钥不对"与"块数据被改动"，这也是对外提示统一的原因。
 * 单块文件（cc === 1）时会额外比对 `meta.h`，此时等价于全量完整性校验。
 */
export async function keyCheck(
  masterKey: MasterKey,
  source: ByteSource,
  options: { verifyHash?: boolean } = {},
): Promise<KeyCheckResult> {
  const reader = new ByteReader(source)
  const { header } = await readStreamHeader(reader)
  const layerCount = header.layers.length
  const declaredPlain = Number(header.meta.s ?? 0)
  const plan = planChunks(declaredPlain, header.cs, layerCount)
  const declaredHash = typeof header.meta.h === 'string' ? header.meta.h.toUpperCase() : undefined
  const base = {
    layers: header.layers.map((l) => l.a),
    plaintextLength: declaredPlain,
    declaredHash,
  }

  // 单块文件：解出来直接比对头部哈希，等价于完整校验
  if (plan.chunkCount === 1) {
    const collected = collectingSink()
    try {
      await decryptStream(source, collected.sink, masterKey)
    } catch (error) {
      if (/AUTH_FAILED/.test(String((error as Error)?.message ?? error))) {
        return { ...base, matched: false, firstChunkHash: '', hashVerified: false }
      }
      throw error
    }
    const plaintext = concatBytes(...collected.parts)
    const firstChunkHash = bytesToHex(sha256(plaintext)).toUpperCase()
    zeroize(plaintext)
    const shouldVerify = options.verifyHash !== false && declaredHash !== undefined
    return { ...base, matched: true, firstChunkHash, hashVerified: shouldVerify ? declaredHash === firstChunkHash : false }
  }

  // 多块文件：只读第一块并认证
  const block = await reader.readExactly(plan.blockTotals[0])
  const aad = headerAad(header)
  try {
    const plain = await openBlock(header, block, plan.plainSizes[0], 0, aad, masterKey)
    zeroize(plain)
  } catch (error) {
    if (/AUTH_FAILED/.test(String((error as Error)?.message ?? error))) {
      return { ...base, matched: false, firstChunkHash: '', hashVerified: false }
    }
    throw error
  }
  return { ...base, matched: true, firstChunkHash: '', hashVerified: false }
}
