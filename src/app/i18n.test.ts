/**
 * 双语字典完整性测试。
 *
 * 为什么值得单独测：`translate()` 在英文键缺失时会**静默回退到中文**（见 i18n.ts 的
 * `?? (MESSAGES.zh)[key] ?? key`），而 `MessageKey` 类型是从中文表推导出来的，
 * 所以 TypeScript **不会**拦住"只在中文表里加了键"这件事。结果是英文界面上悄悄出现中文，
 * 没有任何报错。这个测试把那种沉默变成红灯。
 */
import { describe, expect, it } from 'vitest'
import { MESSAGES, translate, type MessageKey } from './i18n.ts'

const zhKeys = Object.keys(MESSAGES.zh)
const enKeys = Object.keys(MESSAGES.en)

describe('双语字典完整性', () => {
  it('中英字典的键集合必须完全一致', () => {
    expect(zhKeys.length).toBeGreaterThan(0)

    const missingInEn = zhKeys.filter((k) => !(k in MESSAGES.en))
    const missingInZh = enKeys.filter((k) => !(k in MESSAGES.zh))

    // 分别断言，失败时能直接看出是哪一侧漏了哪个键
    expect(missingInEn).toEqual([])
    expect(missingInZh).toEqual([])
  })

  it('两侧文案都非空（空串会在界面上留下一个隐形的空标签）', () => {
    for (const lang of ['zh', 'en'] as const) {
      const empty = Object.entries(MESSAGES[lang])
        .filter(([, value]) => !String(value).trim())
        .map(([key]) => key)
      expect({ lang, empty }).toEqual({ lang, empty: [] })
    }
  })

  it('translate() 对每个键都返回真实文案，绝不返回原始键名', () => {
    const fallen = (Object.keys(MESSAGES.zh) as MessageKey[]).flatMap((key) =>
      (['zh', 'en'] as const).filter((lang) => translate(lang, key) === key).map((lang) => `${lang}:${key}`),
    )
    expect(fallen).toEqual([])
  })

  it('英文侧不应与中文侧完全相同（防止"加了键但忘了翻译"）', () => {
    // 允许少量两种语言写法相同的键（如纯符号、算法名），但不允许大面积雷同
    const identical = zhKeys.filter(
      (k) => (MESSAGES.en as Record<string, string>)[k] === (MESSAGES.zh as Record<string, string>)[k],
    )
    expect(identical.length / zhKeys.length).toBeLessThan(0.1)
  })
})
