/**
 * 更新日志数据源。
 *
 * 单一事实来源是仓库根的 CHANGELOG.md：通过 Vite 的 `?raw` 导入把原文打包进产物，
 * 工具箱的「更新日志」面板在运行时解析渲染。这样发版时只改 CHANGELOG.md 一处，
 * 网页里就自动出现新版本；离线（PWA）也可查，因为内容随 JS 打包。
 *
 * 解析规则（刻意保守，只为展示服务）：
 * - `## [版本] - 日期` 开启一个版本；
 * - `### 小节标题` 开启小节；
 * - `- ` 行是一条目；缩进/表格/代码围栏等续行**追加进上一条目**（原文保留）；
 * - `> ` 行聚合为该版本的摘要（渲染在版本标题下）。
 * 不做通用 Markdown 渲染——那会引入 XSS 面与依赖，这里只需要"能读"。
 */
import pkgRaw from '../../package.json?raw'

export const APP_VERSION: string = (JSON.parse(pkgRaw) as { version: string }).version

export interface ChangelogSection {
  title: string
  items: string[]
}

export interface ChangelogVersion {
  version: string
  date?: string
  summary: string
  sections: ChangelogSection[]
  /** 与当前运行的 package.json 版本一致时为 true（用于默认展开与高亮） */
  current: boolean
}

const VERSION_HEADING = /^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/

export function parseChangelog(raw: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = []
  let cur: ChangelogVersion | null = null
  let section: ChangelogSection | null = null

  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.replace(/\s+$/, '')
    const heading = line.match(VERSION_HEADING)
    if (heading) {
      cur = { version: heading[1].trim(), date: heading[2], summary: '', sections: [], current: false }
      versions.push(cur)
      section = null
      continue
    }
    if (!cur) continue
    if (line.startsWith('### ')) {
      section = { title: line.slice(4).trim(), items: [] }
      cur.sections.push(section)
      continue
    }
    if (line.startsWith('## ')) {
      // 其它二级标题（历史遗留章节）——结束当前小节，不产生内容
      section = null
      continue
    }
    if (line.startsWith('> ')) {
      cur.summary = cur.summary ? `${cur.summary} ${line.slice(2).trim()}` : line.slice(2).trim()
      continue
    }
    if (line.startsWith('- ')) {
      if (!section) {
        section = { title: '', items: [] }
        cur.sections.push(section)
      }
      section.items.push(line.slice(2).trim())
      continue
    }
    // 续行（缩进的表格 / 代码 / 折行）原样挂到上一条目，保住"每个版本的完整内容"
    if (line.length > 0 && /^\s/.test(lineRaw) && section && section.items.length > 0) {
      section.items[section.items.length - 1] += `\n${line}`
    }
  }
  return versions
}

/** 标记当前运行的版本（解析后调用；返回同一数组便于链式使用）。 */
export function markCurrent(versions: ChangelogVersion[], version: string): ChangelogVersion[] {
  for (const entry of versions) entry.current = entry.version === version
  return versions
}

/** 把 CHANGELOG 里的 `**粗体**` 拆成 (text, bold) 片段，避免引入 Markdown 渲染器。 */
export function splitBold(text: string): Array<{ text: string; bold: boolean }> {
  return text
    .split('**')
    .map((part, index) => ({ text: part, bold: index % 2 === 1 }))
    .filter((part) => part.text.length > 0)
}
