// #405 spec 决定 1/6/10：subagent 审批识别纯函数（与 eventTranslate/timeline 并列的纯翻译层）。
// #394 实测定案：识别首选 payload.request.agentId（恒下发 string|null，入参原样回显）；
// 缺失时降级 sessionKey 形态判定——正确形态 `agent:<id>:subagent:<uuid>`（r13:41 文档
// `agent:<agentId>:<name>` 不准确，#394 实测勘误）；皆缺视为主会话审批。spawnedBy 审批事件
// 不下发，不可用。caps 门控（CONNECT_CAPS 无 approvals 族）→ 实时广播不可达、本票不改 caps，
// 实时事件可达性移交别票（spec Out of Scope）。

// sessionKey 形态判定（#394 实测决议，子票权威）：`agent:<id>:subagent:<uuid>`——`agent:` 头 +
// 含 `:subagent:` 段（mintSpawnSessionKey = `agent:${targetAgentId}:${kind}:${uuid}`，kind=subagent；
// id 为自定义键原样透传，可为 main 或 sub-agent id，`subagent:` 位于其后的冒号段）。
// 非裸 `agent:` 头判定——主会话 sessionKey 也可带 `agent:` 头（实测形态首段即 agentId），
// 前缀匹配有误报（#395 钉死）。
// 注：spec 文本「`agent::` 头」为勘误（空 agentId 无意义），以 #394 实测为准。
export function isSubagentSessionKey(sessionKey: string | null | undefined): boolean {
  if (typeof sessionKey !== 'string') return false
  return sessionKey.startsWith('agent:') && sessionKey.includes(':subagent:')
}

// 审批卡是否 subagent 发起：agentId 非空（string）→ true（agentId 即来源语义）；
// null/非 string（0 信任防御，视同缺失）→ 降级 isSubagentSessionKey；皆缺 → false（main 审批）。
export function isSubagentApproval(approval: { agentId: string | null; sessionKey: string | null }): boolean {
  if (typeof approval.agentId === 'string' && approval.agentId) return true
  return isSubagentSessionKey(approval.sessionKey)
}
