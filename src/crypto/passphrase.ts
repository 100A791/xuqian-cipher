/**
 * 口令强度估算（纯函数，无依赖）。
 *
 * 为什么需要它：`.XUQIANKEY` 的密码保护完全依赖 PBKDF2，600k 迭代只能拖慢离线爆破，
 * 真正决定强度的是**口令本身的熵**。SECURITY.md 要求"≥ 16 位随机"，但界面上原本
 * 只检查长度 ≥ 8 —— 要求了却没帮用户做到，这里补上。
 *
 * 本估算刻意保守：字符集熵 × 长度，再对重复、连续序列、键盘步、常见口令做惩罚。
 * 它不是 zxcvbn 那样的字典攻击模拟器，结论用于"提示"，不用于放行/拦截的密码学判断。
 */

export type PassphraseLevel = 'weak' | 'fair' | 'strong' | 'very-strong'

export type PassphraseWarning =
  | 'short'
  | 'single-class'
  | 'repeated'
  | 'sequence'
  | 'common'

export interface PassphraseEstimate {
  /** 估算熵（bit） */
  bits: number
  level: PassphraseLevel
  warnings: PassphraseWarning[]
}

/** 极常见口令（小样本，命中即视为可被字典直接猜中）。 */
const COMMON = new Set([
  'password', 'passw0rd', '123456', '12345678', '123456789', '1234567890',
  'qwerty', 'qwerty123', 'abc123', '111111', '000000', 'iloveyou', 'admin',
  'admin888', 'letmein', 'welcome', 'monkey', 'dragon', 'sunshine', 'princess',
  'football', 'baseball', 'master', 'login', 'starwars', 'whatever', 'trustno1',
  'xuqian', 'xuqian123', 'woaini', 'woaini1314', '5201314', 'a123456', 'qazwsx',
])

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz']

function charsetSize(pw: string): number {
  let size = 0
  if (/[a-z]/.test(pw)) size += 26
  if (/[A-Z]/.test(pw)) size += 26
  if (/\d/.test(pw)) size += 10
  if (/[^A-Za-z0-9]/.test(pw)) size += 33
  return Math.max(size, 1)
}

/** 是否含长度 ≥ 4 的连续升/降序列，或键盘上相邻的滑动。 */
function hasSequence(lower: string): boolean {
  for (let i = 0; i + 3 < lower.length; i++) {
    const a = lower.charCodeAt(i)
    const d1 = lower.charCodeAt(i + 1) - a
    const d2 = lower.charCodeAt(i + 2) - lower.charCodeAt(i + 1)
    const d3 = lower.charCodeAt(i + 3) - lower.charCodeAt(i + 2)
    if (d1 === d2 && d2 === d3 && (d1 === 1 || d1 === -1)) return true
  }
  for (const row of KEYBOARD_ROWS) {
    for (let i = 0; i + 3 < row.length; i++) {
      const seg = row.slice(i, i + 4)
      if (lower.includes(seg) || lower.includes([...seg].reverse().join(''))) return true
    }
  }
  return false
}

export function estimatePassphrase(password: string): PassphraseEstimate {
  const warnings = new Set<PassphraseWarning>()
  if (password.length === 0) return { bits: 0, level: 'weak', warnings: ['short'] }

  const lower = password.toLowerCase()
  let bits = password.length * Math.log2(charsetSize(password))

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (classes <= 1) {
    bits *= 0.6
    warnings.add('single-class')
  }

  const unique = new Set(password).size
  if (unique <= Math.max(1, Math.ceil(password.length / 3))) {
    bits *= 0.5
    warnings.add('repeated')
  }

  if (hasSequence(lower)) {
    bits *= 0.6
    warnings.add('sequence')
  }

  if (COMMON.has(lower)) {
    bits = Math.min(bits, 12)
    warnings.add('common')
  }
  // 常见词根 + 简单数字后缀（password123 / qwerty2026 …）
  if (/^(password|passw0rd|admin|qwerty|abc123|letmein|welcome|iloveyou|woaini|xuqian)/.test(lower)) {
    bits = Math.min(bits, 20)
    warnings.add('common')
  }

  if (password.length < 12) warnings.add('short')

  const rounded = Math.max(0, Math.round(bits))
  const level: PassphraseLevel = rounded < 40 ? 'weak' : rounded < 60 ? 'fair' : rounded < 90 ? 'strong' : 'very-strong'
  return { bits: rounded, level, warnings: [...warnings] }
}

/** 0–100 的展示分（用于进度条宽度）。 */
export function passphraseScore(estimate: PassphraseEstimate): number {
  return Math.max(2, Math.min(100, Math.round((estimate.bits / 100) * 100)))
}
