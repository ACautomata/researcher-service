import { describe, it, expect } from 'vitest'
import { GraphRecursionError } from '@langchain/langgraph'
import { classifyRunError, describeRunError } from '../src/runner/runtime/errorKind'
import { fail } from '../src/envelope'
import { CODE } from '../src/codes'

// S3 纯逻辑（#777 · story 10 错误三分类）：run.failed{errorKind} 的判定面。
// 判据白名单锁定：GraphRecursionError 类型 → recursion_limit；LLM 信封码 + HTTP status
// → llm_error；其余（含无类型异常）→ infra。abort 独立终态不经分类。

describe('classifyRunError（错误三分类，story 10）', () => {
  it('GraphRecursionError → recursion_limit', () => {
    expect(classifyRunError(new GraphRecursionError('too deep'))).toBe('recursion_limit')
  })

  it('LLM 信封码白名单（凭证缺失/provider 不存在）→ llm_error', () => {
    expect(classifyRunError(fail(CODE.LLM_NOT_CONFIGURED))).toBe('llm_error')
    expect(classifyRunError(fail(CODE.PROVIDER_NOT_FOUND))).toBe('llm_error')
  })

  it('40042（白名单拒绝）退役：语义随 #881 白名单链移除——常量保留但出 llm_error 白名单 → infra 兜底', () => {
    expect(classifyRunError(fail(CODE.PROVIDER_ENDPOINT_NOT_ALLOWED))).toBe('infra')
  })

  it('provider SDK 的 HTTP status 故障形态（数字 status 属性）→ llm_error', () => {
    const e = Object.assign(new Error('429 too many requests'), { status: 429 })
    expect(classifyRunError(e)).toBe('llm_error')
    const e5xx = Object.assign(new Error('502 bad gateway'), { status: 502 })
    expect(classifyRunError(e5xx)).toBe('llm_error')
  })

  it('MiddlewareError 包装（langchain agents 中间件形态 {~brand, cause}）→ 剥链取判据', () => {
    const inner = Object.assign(new Error('502 from provider'), { status: 502 })
    const wrapped = Object.assign(new Error('MiddlewareError'), { cause: inner })
    expect(classifyRunError(wrapped)).toBe('llm_error')
    // 深层包装（两层 cause）
    const deep = Object.assign(new Error('outer'), { cause: Object.assign(new Error('mid'), { cause: inner }) })
    expect(classifyRunError(deep)).toBe('llm_error')
    // 包装层包 GraphRecursionError → recursion_limit
    const recWrapped = Object.assign(new Error('MiddlewareError'), { cause: new GraphRecursionError('deep') })
    expect(classifyRunError(recWrapped)).toBe('recursion_limit')
  })

  it('非 LLM 信封码（如 50002 会话域）→ infra（白名单外不信纳）', () => {
    expect(classifyRunError(fail(CODE.SESSION_NOT_FOUND))).toBe('infra')
  })

  it('docker/DB/未知异常 → infra 兜底', () => {
    expect(classifyRunError(new Error('docker daemon down'))).toBe('infra')
    expect(classifyRunError('raw string')).toBe('infra')
    expect(classifyRunError(undefined)).toBe('infra')
  })
})

// describeRunError（诊断盲区修复）：run.failed{message} 的提取面——错误对象 → 一行可读根因。
describe('describeRunError（run.failed{message} 提取）', () => {
  it('Error 实例 → message', () => {
    expect(describeRunError(new Error('sqlite corrupted'))).toBe('sqlite corrupted')
  })

  it('非 Error（裸字符串/undefined）→ String() 兜底', () => {
    expect(describeRunError('raw string')).toBe('raw string')
    expect(describeRunError(undefined)).toBe('undefined')
  })

  it('超长消息截断到 500 字符（防 SSE 帧/横幅被堆栈撑爆；全量由服务端日志留痕）', () => {
    const long = 'x'.repeat(600)
    const out = describeRunError(new Error(long))
    expect(out).toHaveLength(501)
    expect(out.endsWith('…')).toBe(true)
  })
})
