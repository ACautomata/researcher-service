import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { disableLangsmithTracing } from '../src/runner/runtime/tracing'

// S3（#777 验收「tracing 关闭有验证（无 langsmith 泄漏）」）：
// 显式关 = 无条件覆写（用户 env 误配 LANGCHAIN_TRACING_V2=true 也被压掉——凭证纪律，
// prompt/补全绝不外送 api.smith.langchain.com）。行为面（无 smith 域名请求）由 S1
// runnerRunService 集成用例以 fetch spy 复核；此处锁 env 覆写语义。

describe('disableLangsmithTracing', () => {
  const saved: Record<string, string | undefined> = {}
  const KEYS = ['LANGCHAIN_TRACING_V2', 'LANGSMITH_TRACING']

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('未设置 → 显式置 false（缺省安全面）', () => {
    disableLangsmithTracing()
    expect(process.env.LANGCHAIN_TRACING_V2).toBe('false')
    expect(process.env.LANGSMITH_TRACING).toBe('false')
  })

  it('用户 env 误开 true → 无条件覆写为 false（非「未设置才设置」）', () => {
    process.env.LANGCHAIN_TRACING_V2 = 'true'
    process.env.LANGSMITH_TRACING = 'true'
    disableLangsmithTracing()
    expect(process.env.LANGCHAIN_TRACING_V2).toBe('false')
    expect(process.env.LANGSMITH_TRACING).toBe('false')
  })
})
