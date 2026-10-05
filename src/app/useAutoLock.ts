/**
 * 空闲自动锁定。
 *
 * 数据保护角度：主密钥只在 Worker 内驻留，但"人离开工位"这个场景下，
 * 未锁屏的浏览器既可能被人直接操作，也可能被旁人看到刚解出的明文。
 * 本 hook 在**无操作**达到设定时长后调用 store.lockNow()：
 * 销毁主密钥、清空一次性密钥视图与已解出的明文。
 *
 * 注意：这是"降低暴露窗口"的缓解措施，不是防破解手段；
 * 真正的机密性由密码学保证（见 docs/SECURITY.md）。
 */
import { useEffect, useRef } from 'react'
import { useApp } from './store.ts'

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'] as const

export function useAutoLock(): void {
  const minutes = useApp((s) => s.autoLockMinutes)
  const locked = useApp((s) => s.locked)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (minutes <= 0 || locked) return
    const timeoutMs = minutes * 60_000

    const arm = () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        useApp.getState().lockNow()
      }, timeoutMs)
    }

    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, arm, { passive: true })
    document.addEventListener('visibilitychange', arm)
    arm()

    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, arm)
      document.removeEventListener('visibilitychange', arm)
    }
  }, [minutes, locked])
}
