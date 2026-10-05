/**
 * 统一失败出口 —— SPEC 第 4 节阶段零、第 5 节阶段二「接入统一失败和统一延迟」。
 *
 * SPEC 第 7 节禁止事项中与本模块直接相关的两条：
 *   · 禁止提示解密失败的具体原因
 *   · 禁止在失败时输出部分明文
 * 因此这里对外只有**一个**失败结论与**一个**延迟，内部原因不进入对外文案。
 */
import { uniformDelay } from './delay.js'

/** 对外唯一失败文案：不区分"密钥错"与"文件被改"，避免给出可利用的区分信息。 */
export const FAIL_MESSAGE = '解密失败'

/** 内部诊断钩子：默认关闭。SPEC §7 禁止把密钥/明文写入日志，故这里只允许接收不含敏感数据的字符串。 */
let internalSink = null
export function setInternalDiagnostics(fn) {
  internalSink = typeof fn === 'function' ? fn : null
}

/**
 * 统一失败：先走 4~5 秒随机延迟，再抛出**不含原因**的统一错误。
 * @param {string} internalReason 仅用于内部诊断（默认不落盘、不外发），绝不进入 Error.message
 */
export async function fail(internalReason = '') {
  if (internalSink && internalReason) {
    try {
      internalSink(internalReason)
    } catch {
      /* 诊断永远不能影响失败路径本身 */
    }
  }
  await uniformDelay()
  const error = new Error(FAIL_MESSAGE)
  error.code = 'XQ_UNIFORM_FAIL'
  throw error
}

/** 同步版：用于无法 await 的路径；语义相同（延迟由调用方在更外层补）。 */
export function failSync(internalReason = '') {
  if (internalSink && internalReason) {
    try {
      internalSink(internalReason)
    } catch {
      /* 同上 */
    }
  }
  const error = new Error(FAIL_MESSAGE)
  error.code = 'XQ_UNIFORM_FAIL'
  throw error
}
