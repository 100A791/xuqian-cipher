/** 算法与状态页：把已验证的算法、决策记录与缺口如实摆出来（原 SelfModePanel 的内容迁到这里）。 */
import { useApp } from '../../app/store.ts'
import { Alert } from '../ui.tsx'
import { SelfShell } from './SelfShell.tsx'

const ALGORITHMS: Array<[string, string, string]> = [
  ['SHA-256', 'FIPS 180-4', '18/18'],
  ['HMAC-SHA256', 'RFC 4231', '14/14'],
  ['PBKDF2-HMAC-SHA256', 'OpenSSL 交叉', '10/10'],
  ['AES（128/192/256）', 'FIPS 197', '12/12'],
  ['AES-CTR', 'NIST SP 800-38A', '14/14'],
  ['文件格式层', '自描述头部 + KV 帧', '13/13'],
  ['文件加解密', '往返 + OpenSSL 交叉验证', '18/18'],
  ['图片水印', 'LSB / 公开层 / 私有层', '21/21'],
  ['AI 检测', '元数据 / DCT / LSB / 色彩 / 边缘', '21/21'],
]

export function SelfStatusPage() {
  const t = useApp((s) => s.t)

  return (
    <SelfShell title={t('sc.status.title')} description={t('sc.status.desc')}>
      <Alert tone="warn">{t('sc.status.pending')}</Alert>

      <div>
        <h3 className="mb-1 text-sm font-semibold">{t('sc.status.verified')}</h3>
        <p className="mb-2 text-[11px] xq-muted">{t('sc.status.verifiedHint')}</p>
        <table className="w-full text-[12px]">
          <tbody>
            {ALGORITHMS.map(([name, source, result]) => (
              <tr key={name} style={{ borderTop: '1px solid var(--xq-line)' }}>
                <td className="py-1.5 pr-2 xq-mono">{name}</td>
                <td className="py-1.5 pr-2 xq-muted">{source}</td>
                <td className="py-1.5 text-right xq-mono">{result}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] xq-muted">{t('sc.status.vectorNote')}</p>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold">{t('sc.status.gaps')}</h3>
        <ul className="list-disc pl-5 text-[11px] leading-relaxed xq-muted">
          <li>{t('sc.status.gap1')}</li>
          <li>{t('sc.status.gap2')}</li>
          <li>{t('sc.status.gap3')}</li>
        </ul>
      </div>
    </SelfShell>
  )
}
