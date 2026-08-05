// seam: chat/subagentApproval —— subagent 审批识别纯函数（#405 spec 决定 1/6/10）。
// #394 实测定案：识别首选 payload.request.agentId（恒下发 string|null）；缺失时降级
// sessionKey 形态判定——实测形态 `agent:<id>:subagent:<uuid>`（#394 决议勘误 r13:41，
// spec 文本「`agent::` 头」为错误写法，实现以 #394 实测为准）；皆缺视为主会话审批。
// caps 门控（CONNECT_CAPS 无 approvals 族）→ 实时广播不可达、本票不改 caps，
// 实时事件可达性移交别票（spec Out of Scope）。
import { describe, expect, it } from 'vitest'
import { isSubagentApproval, isSubagentSessionKey } from './subagentApproval'

describe('isSubagentSessionKey（#394 实测形态：agent: 头 + rest 以 subagent: 开头）', () => {
  it('实测形态 `agent:<id>:subagent:<uuid>` → true', () => {
    // #394 真网关实测键（自定义键原样透传）；源码 mintSpawnSessionKey =
    // `agent:${targetAgentId}:${kind}:${crypto.randomUUID()}`，kind=subagent
    expect(isSubagentSessionKey('agent:sub-agent-1:subagent:child-1')).toBe(true)
    expect(isSubagentSessionKey('agent:main:subagent:asst_abc123')).toBe(true)
  })

  it('主会话 sessionKey（agent: 头 + rest 非 subagent:）→ false（前缀匹配有误报）', () => {
    expect(isSubagentSessionKey('agent:main')).toBe(false)
    expect(isSubagentSessionKey('agent:main:other')).toBe(false)
    expect(isSubagentSessionKey('agent:subagent')).toBe(false)
    // 非 agent: 头的 subagent 形态（防其余命名空间误判）→ false
    expect(isSubagentSessionKey('session:subagent:child-1')).toBe(false)
  })

  it('非 agent 头 / null / 空 → false', () => {
    expect(isSubagentSessionKey('sk-1')).toBe(false)
    expect(isSubagentSessionKey('')).toBe(false)
    expect(isSubagentSessionKey(null)).toBe(false)
    expect(isSubagentSessionKey(undefined)).toBe(false)
  })
})

describe('isSubagentApproval（agentId 优先 → sessionKey 降级 → 皆缺 false）', () => {
  it('agentId 非空 → true（agentId 即来源语义，不依赖 sessionKey）', () => {
    expect(isSubagentApproval({ agentId: 'sub-1', sessionKey: null })).toBe(true)
    expect(isSubagentApproval({ agentId: 'sub-1', sessionKey: 'agent:main' })).toBe(true)
    expect(isSubagentApproval({ agentId: '', sessionKey: 'agent:main:subagent:child-1' })).toBe(true) // 空串降级形态
  })

  it('agentId null → 降级 isSubagentSessionKey 判定（#394 完整形态）', () => {
    expect(isSubagentApproval({ agentId: null, sessionKey: 'agent:main:subagent:child-1' })).toBe(true)
    expect(isSubagentApproval({ agentId: null, sessionKey: 'agent:main' })).toBe(false)
    expect(isSubagentApproval({ agentId: null, sessionKey: null })).toBe(false)
  })

  it('非 string agentId（0 信任防御）→ 按 null 处理走降级链', () => {
    expect(isSubagentApproval({ agentId: 42 as unknown as string, sessionKey: 'agent:main:subagent:child-1' })).toBe(true)
    expect(isSubagentApproval({ agentId: 42 as unknown as string, sessionKey: 'sk-1' })).toBe(false)
  })
})
