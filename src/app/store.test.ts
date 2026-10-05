import { beforeEach, describe, expect, it } from 'vitest'
import { useApp } from './store.ts'

const sampleView = { hex: 'AABBCC'.repeat(4), base64: 'qrvM', fingerprint: 'FF00FF00FF00FF00', bytes: 16 }

describe('空闲锁定与数据保护设置', () => {
  beforeEach(() => {
    useApp.setState({
      locked: false,
      autoLockMinutes: 5,
      encryptMeta: true,
      decryptFile: null,
      keyModal: { ...useApp.getState().keyModal, open: true, view: sampleView, copiedHex: true, downloaded: true },
    })
  })

  it('lockNow：进入锁定态，并清空一次性密钥视图与已解出明文', () => {
    expect(useApp.getState().decryptFile).toBeNull()
    useApp.setState({
      decryptFile: {
        id: 'x',
        name: 'a.bin',
        size: 1,
        status: 'done',
        outputName: 'a.bin',
        progress: 100,
      },
    })
    useApp.getState().lockNow()
    const s = useApp.getState()
    expect(s.locked).toBe(true)
    expect(s.keyModal.open).toBe(false)
    expect(s.keyModal.view).toBeNull()
    expect(s.keyModal.copiedHex).toBe(false)
    expect(s.keyModal.downloaded).toBe(false)
    expect(s.decryptFile).toBeNull()
  })

  it('setLocked 解除锁定', () => {
    useApp.getState().lockNow()
    expect(useApp.getState().locked).toBe(true)
    useApp.getState().setLocked(false)
    expect(useApp.getState().locked).toBe(false)
  })

  it('setAutoLockMinutes 夹取到 0..120 并取整', () => {
    useApp.getState().setAutoLockMinutes(9999)
    expect(useApp.getState().autoLockMinutes).toBe(120)
    useApp.getState().setAutoLockMinutes(-7)
    expect(useApp.getState().autoLockMinutes).toBe(0)
    useApp.getState().setAutoLockMinutes(15.6)
    expect(useApp.getState().autoLockMinutes).toBe(16)
  })

  it('元数据加密开关可切换（默认开启）', () => {
    expect(useApp.getState().encryptMeta).toBe(true)
    useApp.getState().setEncryptMeta(false)
    expect(useApp.getState().encryptMeta).toBe(false)
  })
})
