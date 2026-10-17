/**
 * 更新日志功能专项测试。
 *
 * 数据源是仓库根 CHANGELOG.md（经 ?raw 打包），解析器在 src/app/changelog.ts。
 * 测试直接吃真实 CHANGELOG，保证"网页里显示的内容"与"仓库里的更新日志"永远一致。
 */
import { describe, expect, it } from 'vitest'
import changelogRaw from '../../CHANGELOG.md?raw'
import { APP_VERSION, markCurrent, parseChangelog, splitBold } from './changelog.ts'

describe('更新日志解析', () => {
  it('解析真实 CHANGELOG：版本按文件顺序（新→旧）且带日期', () => {
    const list = parseChangelog(changelogRaw)
    expect(list.length).toBeGreaterThanOrEqual(3)
    // 不断言 list[0] === APP_VERSION：发版提交那一刻 package.json 还未 bump
    // （bump 由 release 脚本的第二个提交完成），该等式在提交瞬间恒假。
    expect(list[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(list.map((v) => v.version)).toContain('2.3.0')
    expect(list.map((v) => v.version)).toContain('2.4.0')
  })

  it('小节与条目完整：2.4.0 的时间锁条目在、2.3.0 的表格续行不丢', () => {
    const list = parseChangelog(changelogRaw)
    // 历史版本内容稳定，可按版本号精确断言
    const v240 = list.find((v) => v.version === '2.4.0')
    const added = v240?.sections.find((s) => s.title === '新增')
    expect(added?.items.join('\n')).toContain('时间锁')
    const v230 = list.find((v) => v.version === '2.3.0')
    const olderText = v230?.sections.map((s) => s.items.join('\n')).join('\n') ?? ''
    expect(olderText).toContain('| 改前 |')
    // 最新版本的「新增」小节存在且非空（不写死内容，避免每发一版就改测试）
    const latest = list[0]
    const latestAdded = latest.sections.find((s) => s.title === '新增')
    expect(latestAdded?.items.length ?? 0).toBeGreaterThan(0)
  })

  it('markCurrent 只标记当前运行版本（APP_VERSION 来自 package.json）', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    const list = markCurrent(parseChangelog(changelogRaw), APP_VERSION)
    expect(list.filter((v) => v.current).map((v) => v.version)).toEqual([APP_VERSION])
    // APP_VERSION 一定能在 CHANGELOG 里找到对应小节（发版纪律由 release 脚本守卫）
    expect(list.map((v) => v.version)).toContain(APP_VERSION)
  })

  it('容错：空输入 / 无版本头的文本不抛异常，返回空列表；splitBold 处理粗体片段', () => {
    expect(parseChangelog('')).toEqual([])
    expect(parseChangelog('随手写的说明，没有版本小节')).toEqual([])
    expect(splitBold('普通文本')).toEqual([{ text: '普通文本', bold: false }])
    expect(splitBold('前**加粗**后')).toEqual([
      { text: '前', bold: false },
      { text: '加粗', bold: true },
      { text: '后', bold: false },
    ])
  })
})
