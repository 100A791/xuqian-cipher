/** 口令强度指示条：供"设置密钥文件密码"等场景复用。 */
import { useMemo } from 'react'
import { useApp } from '../app/store.ts'
import type { MessageKey } from '../app/i18n.ts'
import {
  estimatePassphrase,
  passphraseScore,
  type PassphraseLevel,
  type PassphraseWarning,
} from '../crypto/passphrase.ts'

const LEVEL_KEY: Record<PassphraseLevel, MessageKey> = {
  weak: 'strength.weak',
  fair: 'strength.fair',
  strong: 'strength.strong',
  'very-strong': 'strength.veryStrong',
}

const WARN_KEY: Record<PassphraseWarning, MessageKey> = {
  short: 'strength.warn.short',
  'single-class': 'strength.warn.singleClass',
  repeated: 'strength.warn.repeated',
  sequence: 'strength.warn.sequence',
  common: 'strength.warn.common',
}

const TONE: Record<PassphraseLevel, string> = {
  weak: '#E24B4A',
  fair: '#BA7517',
  strong: '#639922',
  'very-strong': '#1D9E75',
}

export function PassphraseMeter({ password, className = '' }: { password: string; className?: string }) {
  const t = useApp((s) => s.t)
  const estimate = useMemo(() => estimatePassphrase(password), [password])
  if (password.length === 0) return null
  const tone = TONE[estimate.level]
  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-1 text-[10px]">
        <span style={{ color: tone }}>
          {t('tools.strength')}：{t(LEVEL_KEY[estimate.level])} · {estimate.bits} bit
        </span>
        {estimate.warnings.length > 0 ? (
          <span className="xq-muted">{estimate.warnings.map((w) => t(WARN_KEY[w])).join(' · ')}</span>
        ) : null}
      </div>
      <div className="h-1 w-full overflow-hidden rounded bg-black/10">
        <div className="h-1 rounded" style={{ width: `${passphraseScore(estimate)}%`, background: tone }} />
      </div>
    </div>
  )
}
