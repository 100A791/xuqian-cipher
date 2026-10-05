/**
 * 自研加密路线的测试基座 —— SPEC 第 2 节 tests/unit、第 5 节「Node.js 用于跑测试向量」。
 * 不引入任何第三方测试框架（SPEC 第 7 节禁第三方库的同类精神），用原生 node 跑。
 */

/** 把向量文件里的输入描述还原成实际字节（生成器与测试共用，避免两处实现分叉）。 */
export function materialize(input) {
  if ('utf8' in input) return Buffer.from(input.utf8, 'utf8')
  if ('bytes' in input) return Buffer.from(input.bytes)
  if ('repeat' in input) return Buffer.alloc(input.repeat.times, input.repeat.byte)
  throw new Error('未知的输入描述: ' + JSON.stringify(input))
}

/** 极简断言收集器：跑完打印汇总，有失败则进程退出码非 0。 */
export function createRunner(title) {
  const results = []
  return {
    results,
    /** @param {string} name @param {() => void | Promise<void>} fn */
    async test(name, fn) {
      try {
        await fn()
        results.push({ name, ok: true })
        console.log(`  PASS ${name}`)
      } catch (error) {
        results.push({ name, ok: false, detail: error.message })
        console.log(`  FAIL ${name} — ${error.message}`)
      }
    },
    finish() {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${title}：合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`)
      if (failed.length > 0) process.exitCode = 1
      return failed.length === 0
    },
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label ?? '值'} 不符：期望 ${expected}，实际 ${actual}`)
}

export function assertTrue(value, label) {
  if (!value) throw new Error(`${label ?? '断言'} 不成立`)
}

/** 十六进制 ⇄ 字节。 */
export const hexToBytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))
export const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
