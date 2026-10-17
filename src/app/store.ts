/**
 * 全局 UI 状态（Zustand）。
 *
 * 安全约束：
 * - 这里**不保存密钥本身**，只在"密钥弹窗打开期间"保存一次性的文本视图，关闭时立即清空。
 * - 主题/语言/日志持久化到 localStorage，但日志内容经过白名单过滤，绝不包含密钥、密码或子密钥。
 * - 主密钥的权威副本始终在 Worker 内（见 src/worker/）。
 */
import { create } from 'zustand'
import type { AlgoId } from '../crypto/aead.ts'
import type { KeyView } from '../worker/crypto.worker.ts'
import { cryptoClient } from '../worker/client.ts'
import { type Lang, translate, type MessageKey } from './i18n.ts'

export type Theme = 'dark' | 'light'
export type TabKey = 'encrypt' | 'decrypt' | 'text' | 'tools'
/**
 * 加密路线（开始页二选一）：
 * - `simple`：现有实现——多层 AEAD（AES-GCM / ChaCha20 / XChaCha20 / SM4-GCM），走成熟加密库 + 浏览器 WebCrypto
 * - `self`：自研实现——SHA-256 / HMAC / PBKDF2 / AES / CTR 全部本项目自研，不依赖第三方加密库
 * - `null`：尚未选择 → 显示开始页
 */
export type CryptoMode = 'simple' | 'self'
/**
 * 自研路线内部的页面（SPEC §2 的 src/ui 五个入口 + 状态页共六个）。
 * SPEC 原设计是原生 main.js/file_page.js…，但用户已定「不重做界面」，
 * 因此用现有 React 栈实现同样的页面划分（决策 D25）。
 */
export type SelfTab = 'home' | 'file' | 'decrypt' | 'watermark' | 'ai' | 'status'
export const SELF_TABS: SelfTab[] = ['file', 'decrypt', 'watermark', 'ai', 'status']

export interface LogEntry {
  id: number
  ts: number
  level: 'info' | 'warn' | 'error'
  /** 白名单动作码 */
  action: 'encrypt' | 'decrypt' | 'text' | 'keyGen' | 'keyDestroy' | 'hash' | 'shamir' | 'settings'
  /** 已本地化或简短描述；绝不写入密钥、密码、子密钥 */
  detail: string
}

export interface QueueItem {
  id: string
  name: string
  path: string
  size: number
  status: 'pending' | 'encrypting' | 'done' | 'error'
  outputName?: string
  outputBlob?: Blob
  message?: string
  progress: number
  /** 原始 File 引用（仅存在于内存，不参与持久化） */
  fileRef?: File
}

export interface DecryptItem {
  id: string
  name: string
  size: number
  status: 'pending' | 'decrypting' | 'done' | 'error'
  outputName?: string
  outputBlob?: Blob
  message?: string
  progress: number
  hashMatched?: boolean | null
  headerJson?: string
}

interface PersistedSettings {
  theme: Theme
  lang: Lang
  clipboardClear: boolean
  /** 加密标识性元数据（原文件名 / MIME / 备注…），默认开启 */
  encryptMeta: boolean
  /** 时间戳附加盐（仅域分离，不提升安全性），默认关闭 */
  timestampSalt: boolean
  /** 空闲自动锁定：无操作达到该分钟数即锁定；0 = 关闭 */
  autoLockMinutes: number
  /** 开始页选择的加密路线；null = 还没选过（下次仍显示开始页） */
  mode: CryptoMode | null
}

export interface KeyModalState {
  open: boolean
  /** 一次性视图：关闭弹窗时立即置空 */
  view: KeyView | null
  fingerprint: string
  /** 用户是否至少复制过一次 */
  copiedHex: boolean
  copiedBase64: boolean
  downloaded: boolean
  /** 触发弹窗的加密任务上下文（用于生成密钥文件名） */
  contextLabel: string
  layers: AlgoId[]
  chunkSize: number
  gzip: boolean
  expiresAt?: number
  notBefore?: number
}

const SETTINGS_KEY = 'xuqian.settings.v1'
const LOG_KEY = 'xuqian.log.v1'
const LOG_LIMIT = 200

function loadSettings(): PersistedSettings {
  const fallback: PersistedSettings = {
    theme: 'dark',
    lang: 'zh',
    clipboardClear: true,
    encryptMeta: true,
    timestampSalt: false,
    autoLockMinutes: 5,
    mode: null,
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>
    const autoLock = Number(parsed.autoLockMinutes)
    return {
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      lang: parsed.lang === 'en' ? 'en' : 'zh',
      clipboardClear: parsed.clipboardClear !== false,
      encryptMeta: parsed.encryptMeta !== false,
      timestampSalt: parsed.timestampSalt === true,
      autoLockMinutes:
        Number.isFinite(autoLock) && autoLock >= 0 && autoLock <= 120 ? autoLock : fallback.autoLockMinutes,
      mode: parsed.mode === 'self' ? 'self' : parsed.mode === 'simple' ? 'simple' : null,
    }
  } catch {
    return fallback
  }
}

/**
 * 合并式写入设置。
 * 早期写法是每个 setter 自己拼一个完整对象，新增字段时极易被别的 setter 覆盖掉
 * （例如"切换主题"会把刚选好的加密路线抹掉），故统一走这里做浅合并。
 */
function saveSettings(patch: Partial<PersistedSettings>): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const current = raw ? (JSON.parse(raw) as Partial<PersistedSettings>) : {}
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...patch }))
  } catch {
    /* 隐私模式下可能写入失败，忽略 */
  }
}

function loadLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as LogEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry && typeof entry.detail === 'string' && typeof entry.ts === 'number')
      .slice(-LOG_LIMIT)
  } catch {
    return []
  }
}

function persistLog(entries: LogEntry[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-LOG_LIMIT)))
  } catch {
    /* 隐私模式下可能写入失败，忽略 */
  }
}

const settings = loadSettings()

export interface AppState {
  tab: TabKey
  theme: Theme
  lang: Lang
  /** 加密路线选择；null = 显示开始页 */
  mode: CryptoMode | null
  /** 自研路线内部的当前页面 */
  selfTab: SelfTab
  clipboardClear: boolean
  /** 加密标识性元数据（原文件名 / MIME / 备注…） */
  encryptMeta: boolean
  /** 时间戳附加盐（域分离，不提升安全性） */
  timestampSalt: boolean
  /** 空闲自动锁定分钟数；0 = 关闭 */
  autoLockMinutes: number
  /** 会话锁定态：锁定后一次性密钥视图与已解出明文一律清空 */
  locked: boolean
  log: LogEntry[]

  // 加密面板
  encryptFiles: QueueItem[]
  layers: AlgoId[]
  gzip: boolean
  note: string
  /** 加密声明（不可去除；留空时写入默认声明） */
  notice: string
  expiresAt: string
  notBefore: string
  chunkSize: number
  encrypting: boolean
  encryptProgress: number

  // 解密面板
  decryptFile: DecryptItem | null
  decrypting: boolean
  decryptProgress: number

  // 密钥弹窗
  keyModal: KeyModalState

  setTab: (tab: TabKey) => void
  setTheme: (theme: Theme) => void
  setLang: (lang: Lang) => void
  /** 选择加密路线；传 null 回到开始页 */
  setMode: (mode: CryptoMode | null) => void
  setSelfTab: (tab: SelfTab) => void
  setClipboardClear: (value: boolean) => void
  setEncryptMeta: (value: boolean) => void
  setTimestampSalt: (value: boolean) => void
  setAutoLockMinutes: (value: number) => void
  /** 立即锁定会话（空闲超时或用户手动触发） */
  lockNow: () => void
  /** 解除锁定态（密钥已销毁，用户需重新导入密钥才能继续） */
  setLocked: (value: boolean) => void
  t: (key: MessageKey) => string

  logEvent: (action: LogEntry['action'], detail: string, level?: LogEntry['level']) => void
  clearLog: () => void

  setEncryptFiles: (files: QueueItem[]) => void
  patchEncryptFile: (id: string, patch: Partial<QueueItem>) => void
  setLayers: (layers: AlgoId[]) => void
  setLayerAt: (index: number, algo: AlgoId) => void
  moveLayer: (index: number, delta: number) => void
  addLayer: () => void
  removeLayer: (index: number) => void
  setGzip: (value: boolean) => void
  setNote: (value: string) => void
  setNotice: (value: string) => void
  setExpiresAt: (value: string) => void
  setNotBefore: (value: string) => void
  setChunkSize: (value: number) => void
  setEncrypting: (value: boolean) => void
  setEncryptProgress: (value: number) => void

  setDecryptFile: (item: DecryptItem | null) => void
  patchDecryptFile: (patch: Partial<DecryptItem>) => void
  setDecrypting: (value: boolean) => void
  setDecryptProgress: (value: number) => void

  openKeyModal: (init: Omit<KeyModalState, 'open'>) => void
  /** 关闭弹窗并把一次性视图立即销毁 */
  closeKeyModal: () => void
  patchKeyModal: (patch: Partial<KeyModalState>) => void
}

export const useApp = create<AppState>((set, get) => ({
  tab: 'encrypt',
  theme: settings.theme,
  lang: settings.lang,
  mode: settings.mode,
  selfTab: 'home',
  clipboardClear: settings.clipboardClear,
  encryptMeta: settings.encryptMeta,
  timestampSalt: settings.timestampSalt,
  autoLockMinutes: settings.autoLockMinutes,
  locked: false,
  log: loadLog(),

  encryptFiles: [],
  layers: ['AES-128-GCM'],
  gzip: false,
  note: '',
  notice: '',
  expiresAt: '',
  notBefore: '',
  chunkSize: 64 * 1024 * 1024,
  encrypting: false,
  encryptProgress: 0,

  decryptFile: null,
  decrypting: false,
  decryptProgress: 0,

  keyModal: {
    open: false,
    view: null,
    fingerprint: '',
    copiedHex: false,
    copiedBase64: false,
    downloaded: false,
    contextLabel: '',
    layers: [],
    chunkSize: 64 * 1024 * 1024,
    gzip: false,
  },

  setTab: (tab) => set({ tab }),

  setTheme: (theme) => {
    saveSettings({ theme })
    document.documentElement.dataset.theme = theme
    set({ theme })
  },

  setLang: (lang) => {
    saveSettings({ lang })
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    set({ lang })
  },

  setMode: (mode) => {
    saveSettings({ mode })
    set({ mode, selfTab: 'home' })
  },

  setSelfTab: (selfTab) => set({ selfTab }),

  setClipboardClear: (value) => {
    saveSettings({ clipboardClear: value })
    set({ clipboardClear: value })
  },

  setEncryptMeta: (value) => {
    saveSettings({ encryptMeta: value })
    set({ encryptMeta: value })
  },

  setTimestampSalt: (value) => {
    saveSettings({ timestampSalt: value })
    set({ timestampSalt: value })
  },

  setAutoLockMinutes: (value) => {
    const safe = Math.max(0, Math.min(120, Math.round(value)))
    saveSettings({ autoLockMinutes: safe })
    set({ autoLockMinutes: safe })
  },

  lockNow: () => {
    // 锁定 = 销毁 Worker 内的主密钥 + 清空一切派生物（一次性视图、已解出明文）
    try {
      cryptoClient.destroyKeySync()
    } catch {
      /* Worker 未启动时忽略 */
    }
    set({
      locked: true,
      keyModal: {
        ...get().keyModal,
        open: false,
        view: null,
        copiedHex: false,
        copiedBase64: false,
        downloaded: false,
      },
      decryptFile: null,
      decrypting: false,
      encrypting: false,
    })
    get().logEvent('keyDestroy', '已锁定：销毁主密钥并清空明文与一次性密钥视图', 'warn')
  },

  setLocked: (value) => set({ locked: value }),

  t: (key) => translate(get().lang, key),

  logEvent: (action, detail, level = 'info') => {
    // 防御性过滤：绝不把可疑的长密钥串写进日志
    const safe = detail.replace(/[0-9a-fA-F]{32,}/g, '[redacted]').replace(/[A-Za-z0-9+/]{20,}={0,2}/g, '[redacted]')
    // 日志 id 用 CSPRNG 生成（不再用 Math.random）：本项目对"随机"只有一条路径，避免留下例外。
    const rand = new Uint32Array(1)
    crypto.getRandomValues(rand)
    const entry: LogEntry = {
      id: Date.now() * 1000 + (rand[0] % 1000),
      ts: Date.now(),
      level,
      action,
      detail: safe.slice(0, 200),
    }
    const next = [...get().log, entry].slice(-LOG_LIMIT)
    persistLog(next)
    set({ log: next })
  },

  clearLog: () => {
    persistLog([])
    set({ log: [] })
  },

  setEncryptFiles: (files) => set({ encryptFiles: files }),
  patchEncryptFile: (id, patch) =>
    set({ encryptFiles: get().encryptFiles.map((item) => (item.id === id ? { ...item, ...patch } : item)) }),
  setLayers: (layers) => set({ layers: layers.slice(0, 10) }),
  setLayerAt: (index, algo) => {
    const layers = [...get().layers]
    if (index < 0 || index >= layers.length) return
    layers[index] = algo
    set({ layers })
  },
  moveLayer: (index, delta) => {
    const layers = [...get().layers]
    const target = index + delta
    if (target < 0 || target >= layers.length) return
    const [item] = layers.splice(index, 1)
    layers.splice(target, 0, item)
    set({ layers })
  },
  addLayer: () => {
    const layers = [...get().layers]
    if (layers.length >= 10) return
    const pool: AlgoId[] = ['AES-128-GCM', 'AES-256-GCM', 'CHACHA20-POLY1305', 'XCHACHA20-POLY1305', 'SM4-GCM']
    const next = pool.find((algo) => !layers.includes(algo)) ?? 'AES-256-GCM'
    layers.push(next)
    set({ layers })
  },
  removeLayer: (index) => {
    const layers = [...get().layers]
    if (layers.length <= 1) return
    layers.splice(index, 1)
    set({ layers })
  },
  setGzip: (value) => set({ gzip: value }),
  setNote: (value) => set({ note: value.slice(0, 200) }),
  setNotice: (value) => set({ notice: value.slice(0, 2000) }),
  setExpiresAt: (value) => set({ expiresAt: value }),
  setNotBefore: (value) => set({ notBefore: value }),
  setChunkSize: (value) => set({ chunkSize: value }),
  setEncrypting: (value) => set({ encrypting: value }),
  setEncryptProgress: (value) => set({ encryptProgress: value }),

  setDecryptFile: (item) => set({ decryptFile: item }),
  patchDecryptFile: (patch) => {
    const current = get().decryptFile
    if (!current) return
    set({ decryptFile: { ...current, ...patch } })
  },
  setDecrypting: (value) => set({ decrypting: value }),
  setDecryptProgress: (value) => set({ decryptProgress: value }),

  openKeyModal: (init) => set({ keyModal: { ...init, open: true } }),
  closeKeyModal: () =>
    set({
      keyModal: {
        open: false,
        view: null, // 立即丢弃一次性文本视图
        fingerprint: '',
        copiedHex: false,
        copiedBase64: false,
        downloaded: false,
        contextLabel: '',
        layers: [],
        chunkSize: 64 * 1024 * 1024,
        gzip: false,
      },
    }),
  patchKeyModal: (patch) => set({ keyModal: { ...get().keyModal, ...patch } }),
}))

/** 应用启动时同步 DOM 上的主题/语言标记。 */
export function syncDocumentChrome(): void {
  const { theme, lang } = useApp.getState()
  document.documentElement.dataset.theme = theme
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
}
