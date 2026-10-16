/**
 * Worker 客户端 —— 主线程侧封装（G11）。
 *
 * 设计要点：
 *   ① 若环境不支持 Worker（或创建失败），**退回主线程执行**，功能不变、只是会卡一下 —— 宁可慢，不要不能用；
 *   ② 取消 = `terminate()`：Worker 连同内存里的密钥一起消失，比"发个取消标志等它自己停"彻底；
 *   ③ 进度事件原样透传，界面画的就是内核真实上报的块计数（不伪造进度）。
 */
import { encryptFile } from '../../selfcrypto/file/encrypt.js'
import { decryptFile } from '../../selfcrypto/file/decrypt.js'
import type { SelfImage } from './browser.ts'

export interface ProgressEvent {
  phase: string
  done: number
  total: number
}

export interface EncryptResult {
  cipherBytes: Uint8Array
  keyK: Uint8Array
}

export interface DecryptResult {
  plainBytes: Uint8Array
  metadata: Map<string, unknown>
}

export interface RunHandle<T> {
  promise: Promise<T>
  /** 取消：终止 Worker（若走主线程回退则无法中断，返回 false 表示没能取消）。 */
  cancel: () => boolean
}

const supportsWorker = () => typeof Worker !== 'undefined'

function createWorker(): Worker | null {
  if (!supportsWorker()) return null
  try {
    return new Worker(new URL('./self.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

let nextId = 1

/** 把一次请求发给 Worker，返回 handle（含 cancel）。 */
function runInWorker<T>(
  payload: Record<string, unknown>,
  onProgress?: (progress: ProgressEvent) => void,
  fallback?: (onProgress?: (p: ProgressEvent) => void) => Promise<T>,
): RunHandle<T> {
  const worker = createWorker()
  if (!worker) {
    if (!fallback) return { promise: Promise.reject(new Error('当前环境不支持 Worker')), cancel: () => false }
    return { promise: fallback(onProgress), cancel: () => false }
  }

  const id = nextId++
  let settled = false
  const promise = new Promise<T>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data ?? {}
      if (data.id !== id) return
      if (data.type === 'progress') {
        onProgress?.({ phase: data.phase, done: data.done, total: data.total })
        return
      }
      settled = true
      worker.terminate()
      if (data.type === 'done') resolve(data.result as T)
      else reject(new Error(data.message ?? '操作失败'))
    }
    worker.onerror = (event) => {
      if (settled) return
      settled = true
      worker.terminate()
      reject(new Error(event.message || 'Worker 执行出错'))
    }
    worker.postMessage({ id, ...payload })
  })

  return {
    promise,
    cancel: () => {
      if (settled) return false
      settled = true
      // terminate 会连同 Worker 内存里的密钥一起释放
      worker.terminate()
      return true
    },
  }
}

export function runEncrypt(
  bytes: Uint8Array,
  meta: { name: string; mime: string; created: number },
  onProgress?: (progress: ProgressEvent) => void,
): RunHandle<EncryptResult> {
  return runInWorker<EncryptResult>(
    { op: 'encrypt', bytes, name: meta.name, mime: meta.mime, created: meta.created },
    onProgress,
    // 回退：主线程直跑（会阻塞界面，但功能可用）
    (report) =>
      Promise.resolve(
        encryptFile(
          bytes,
          [
            ['name', meta.name],
            ['size', BigInt(bytes.length)],
            ['mime', meta.mime],
            ['created', BigInt(meta.created)],
          ],
          { onProgress: report },
        ),
      ).then((r) => ({ cipherBytes: r.cipherBytes, keyK: r.keyK })),
  )
}

export function runDecrypt(
  bytes: Uint8Array,
  masterKey: Uint8Array,
  onProgress?: (progress: ProgressEvent) => void,
): RunHandle<DecryptResult> {
  const keyCopy = new Uint8Array(masterKey)
  return runInWorker<DecryptResult>({ op: 'decrypt', bytes, masterKey: keyCopy }, onProgress, async (report) => {
    const result = await decryptFile(bytes, keyCopy, { onProgress: report })
    return { plainBytes: result.plainBytes, metadata: result.metadata as Map<string, unknown> }
  })
}

export { supportsWorker }
export type { SelfImage }
