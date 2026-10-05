/**
 * 自研路线的 Web Worker —— G11：大文件加密不该把页面卡死
 * （同步加密在约 2MB/s 下会让 100MB 冻结约 50 秒、且无法取消）。
 *
 * 协议（主线程 ↔ Worker）：
 *   主 → Worker：{ id, op: 'encrypt' | 'decrypt', ... }
 *   Worker → 主：{ id, type: 'progress', phase, done, total }
 *                { id, type: 'done', result }
 *                { id, type: 'error', message }
 *
 * 安全（SPEC §7）：
 *   · 主密钥只经 structured clone 进入本 Worker 的内存，**不落存储、不发网络**；
 *   · 用完立刻 `fill(0)` 清零。注意：清零必须放在 **await 之后**的 finally 里 ——
 *     如果写成"包一层同步 helper"，helper 会在 Promise 还没 settle 时就返回并清零密钥；
 *   · 取消 = `terminate()`，整个 Worker 连同内存里的密钥一起消失（比"标记取消"彻底）。
 */
/// <reference lib="webworker" />
import { encryptFile } from '../../selfcrypto/file/encrypt.js'
import { decryptFile } from '../../selfcrypto/file/decrypt.js'

const ctx = self as unknown as DedicatedWorkerGlobalScope

interface Progress {
  phase: string
  done: number
  total: number
}

interface EncryptRequest {
  id: number
  op: 'encrypt'
  bytes: Uint8Array
  name: string
  mime: string
  created: number
  masterKey?: Uint8Array
}

interface DecryptRequest {
  id: number
  op: 'decrypt'
  bytes: Uint8Array
  masterKey: Uint8Array
}

type Request = EncryptRequest | DecryptRequest

ctx.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  if (!request || typeof request.id !== 'number') return
  const { id } = request

  const post = (message: Record<string, unknown>): void => ctx.postMessage(message)
  const onProgress = (progress: Progress): void => post({ id, type: 'progress', ...progress })

  try {
    if (request.op === 'encrypt') {
      const { bytes, name, mime, created, masterKey } = request
      try {
        const result = encryptFile(
          bytes,
          [
            ['name', name],
            ['size', BigInt(bytes.length)],
            ['mime', mime],
            ['created', BigInt(created)],
          ],
          { masterKey, onProgress },
        )
        post({ id, type: 'done', result: { cipherBytes: result.cipherBytes, keyK: result.keyK } })
      } finally {
        masterKey?.fill(0)
      }
      return
    }

    const { bytes, masterKey } = request
    try {
      const result = await decryptFile(bytes, masterKey, { onProgress })
      post({
        id,
        type: 'done',
        result: {
          plainBytes: result.plainBytes,
          // Map 里可能有 BigInt，转成条目数组更省心（BigInt 本身可结构化克隆）
          metadata: Array.from(result.metadata.entries()),
          header: {
            timestamp: result.header.timestamp,
            segments: result.header.segments,
            chunkSize: result.header.chunkSize,
          },
        },
      })
    } finally {
      // 必须等 await 结束再清零：deriveSubkeys 之前的同步步骤需要它，
      // 而 fail() 分支还会 await 4~5 秒。
      masterKey.fill(0)
    }
  } catch (error) {
    // 统一失败已在内核里归一（含 4~5 秒延迟），这里只回传**归一后的文案**
    post({ id, type: 'error', message: (error as { message?: string } | null)?.message ?? '操作失败' })
  }
}
