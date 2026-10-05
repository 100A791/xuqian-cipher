/**
 * 主线程侧的 Worker 客户端。
 *
 * 关键约定（对应验收标准 15–19）：
 * - 主密钥的唯一权威副本在 Worker 内；主线程只在弹窗打开期间持有临时文本视图。
 * - destroyKey() 会同时做三件事：命令 Worker 覆写密钥、清空本模块所有引用、抹掉弹窗状态。
 * - 本模块不写 localStorage / sessionStorage / IndexedDB / Cookie / URL / 日志。
 */
import type { AlgoId } from '../crypto/aead.ts'
import type { KeyView, WorkerRequest, WorkerResponse } from './crypto.worker.ts'

export interface EncryptRequest {
  bytes: ArrayBuffer
  name: string
  mime?: string
  layers: AlgoId[]
  chunkSize?: number
  gzip?: boolean
  note?: string
  /** 加密声明文本；留空则回退默认（本站不提供"不写声明"的选项） */
  notice?: string
  lang?: 'zh' | 'en'
  expiresAt?: number
  kind?: 'bytes' | 'text'
}

export type EncryptResult = Extract<WorkerResponse, { op: 'encrypt'; ok: true }>
export type DecryptResult = Extract<WorkerResponse, { op: 'decrypt'; ok: true }>
export type KeyCheckResult = Extract<WorkerResponse, { op: 'key-check'; ok: true }>

type Pending = {
  resolve: (value: WorkerResponse) => void
  reject: (reason: Error) => void
}

class CryptoClient {
  #worker: Worker | null = null
  #pending = new Map<number, Pending>()
  #seq = 0
  /** 是否持有"当前可展示"的密钥（由 Worker 持有）；弹窗关闭后置 false */
  #keyPresent = false

  get keyPresent(): boolean {
    return this.#keyPresent
  }

  #ensure(): Worker {
    if (!this.#worker) {
      this.#worker = new Worker(new URL('./crypto.worker.ts', import.meta.url), {
        type: 'module',
        name: 'xuqian-crypto',
      })
      this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data
        const pending = this.#pending.get(response.id)
        if (!pending) return
        this.#pending.delete(response.id)
        pending.resolve(response)
      }
      this.#worker.onerror = (event) => {
        const error = new Error(event.message || 'WORKER_ERROR')
        for (const [, pending] of this.#pending) pending.reject(error)
        this.#pending.clear()
      }
    }
    return this.#worker
  }

  #send(request: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const worker = this.#ensure()
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.#pending.set(request.id, { resolve, reject })
      worker.postMessage(request, transfer)
    })
  }

  /** 发送并断言返回的是指定操作的成功结果。 */
  async #call<T extends WorkerResponse['op']>(
    request: WorkerRequest,
    op: T,
    transfer: Transferable[] = [],
  ): Promise<Extract<WorkerResponse, { op: T; ok: true }>> {
    const response = await this.#send(request, transfer)
    if (!response.ok) throw new Error(response.error)
    if (response.op !== op) throw new Error('UNKNOWN')
    return response as Extract<WorkerResponse, { op: T; ok: true }>
  }

  /** 生成新的 128 位主密钥（会先销毁旧的）。 */
  async generateKey(): Promise<{ fingerprint: string }> {
    const res = await this.#call({ id: ++this.#seq, op: 'key-generate' }, 'key-generate')
    this.#keyPresent = true
    return { fingerprint: res.fingerprint }
  }

  /** 导入用户提供的密钥（用于解密；导入的密钥不会被再次展示）。 */
  async importKey(input: { hex?: string; base64?: string }): Promise<{ fingerprint: string }> {
    const res = await this.#call({ id: ++this.#seq, op: 'key-import', ...input }, 'key-import')
    this.#keyPresent = true
    return { fingerprint: res.fingerprint }
  }

  /** 读取一次性密钥视图（仅密钥弹窗使用）。 */
  viewKey(): Promise<KeyView> {
    return this.#call({ id: ++this.#seq, op: 'key-view' }, 'key-view').then((res) => res.view)
  }

  /**
   * 销毁密钥：命令 Worker 覆写并释放，同时清空主线程状态。
   * 调用后 viewKey() 会失败，任何入口都无法再取回该密钥。
   */
  async destroyKey(): Promise<void> {
    this.#keyPresent = false
    if (!this.#worker) return
    try {
      await this.#call({ id: ++this.#seq, op: 'key-destroy' }, 'key-destroy')
    } catch {
      /* Worker 可能已不可用；#keyPresent 已置 false，页面刷新会销毁全部内存 */
    }
  }

  /** 立即销毁（不等待确认），用于页面卸载。 */
  destroyKeySync(): void {
    this.#keyPresent = false
    try {
      this.#worker?.postMessage({ id: ++this.#seq, op: 'key-destroy' } satisfies WorkerRequest)
    } catch {
      /* ignore */
    }
  }

  encrypt(request: EncryptRequest): Promise<EncryptResult> {
    return this.#call({ id: ++this.#seq, op: 'encrypt', ...request }, 'encrypt', [request.bytes])
  }

  decrypt(bytes: ArrayBuffer, verifyHash = true): Promise<DecryptResult> {
    return this.#call({ id: ++this.#seq, op: 'decrypt', bytes, verifyHash }, 'decrypt', [bytes])
  }

  /**
   * 密钥自检：只认证第一块，回答"当前这把密钥是不是这个文件的"。
   * 不写出任何文件，也不改变密钥状态。
   */
  keyCheck(bytes: ArrayBuffer, verifyHash = true): Promise<KeyCheckResult> {
    return this.#call({ id: ++this.#seq, op: 'key-check', bytes, verifyHash }, 'key-check', [bytes])
  }

  hash(bytes: ArrayBuffer, algorithms: Array<'SHA-256' | 'SHA-512'> = ['SHA-256', 'SHA-512']): Promise<Record<string, string>> {
    return this.#call({ id: ++this.#seq, op: 'hash', bytes, algorithms }, 'hash', [bytes]).then((res) => res.digests)
  }
}

export const cryptoClient = new CryptoClient()

// 页面卸载时主动请求销毁（浏览器随后会回收整个 Worker）
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => cryptoClient.destroyKeySync())
  window.addEventListener('beforeunload', () => cryptoClient.destroyKeySync())
}
