import type { SessionProjection, LiveTurn, SessionApproval } from '@/api/sessions'
export interface SessionEvent { type: string; sessionId?: string; teammateId?: string; runId?: string; payload: Record<string, unknown> }

/** Both leader and named peers consume the same turn shape used by REST replay. */
export function applySessionEvent(projection: SessionProjection, event: SessionEvent): SessionProjection {
  if (event.sessionId !== projection.sessionId) return projection
  const next = structuredClone(projection)
  const peer = event.teammateId ? next.teammates?.find(item => item.id === event.teammateId) : undefined
  if (event.teammateId && !peer) return projection // A started event triggers REST discovery of new members.
  const target = peer ?? next
  const payload = event.payload
  if (event.type === 'run.started' || event.type === 'run.resumed') {
    target.inFlight = { runId: event.runId ?? '', state: 'running', turn: { content: '' } }
    if (peer) peer.status = 'running'
  } else if (event.type === 'text.delta' || event.type === 'thinking.delta') {
    if (!target.inFlight) target.inFlight = { runId: event.runId ?? '', state: 'running', turn: { content: '' } }
    if (typeof payload.delta === 'string') {
      if (event.type === 'text.delta') target.inFlight.turn.content += payload.delta
      else target.inFlight.turn.thinking = (target.inFlight.turn.thinking ?? '') + payload.delta
    }
  } else if (event.type === 'tool.start' || event.type === 'tool.end') {
    const live: LiveTurn = target.inFlight ?? { runId: event.runId ?? '', state: 'running', turn: { content: '' } }
    target.inFlight = live
    const tools = live.turn.tools ??= []
    if (typeof payload.toolCallId === 'string') {
      let tool = tools.find(item => item.toolCallId === payload.toolCallId)
      if (!tool) { tool = { toolCallId: payload.toolCallId, name: typeof payload.name === 'string' ? payload.name : '工具', input: '', state: 'running' }; tools.push(tool) }
      if (typeof payload.input === 'string') tool.input = payload.input
      if (payload.state === 'success' || payload.state === 'error') tool.state = payload.state
      if (typeof payload.details === 'string') tool.details = payload.details
      if (typeof payload.durationMs === 'number') tool.durationMs = payload.durationMs
    }
  } else if (event.type === 'approval.requested') {
    const escalation = payload.escalation
    if (escalation && typeof escalation === 'object' && 'id' in escalation && typeof escalation.id === 'string') {
      const approval = { escalation, ...(peer ? { teammateId: peer.id } : {}) } as SessionApproval
      next.approvals = [...(next.approvals ?? []).filter(item => item.escalation.id !== approval.escalation.id), approval]
      if (peer) peer.status = 'suspended'
    }
  } else if (event.type === 'approval.resolved') {
    next.approvals = (next.approvals ?? []).filter(item => item.escalation.id !== payload.escalationId)
  } else if (event.type === 'attachment') {
    if (target.inFlight && typeof payload.attachmentId === 'string' && typeof payload.fileName === 'string' && typeof payload.mime === 'string' && typeof payload.size === 'number') {
      const media = target.inFlight.turn.media ??= []
      if (!media.some(item => item.attachmentId === payload.attachmentId)) media.push({ attachmentId: payload.attachmentId, fileName: payload.fileName, mime: payload.mime, size: payload.size })
    }
  } else if (peer && event.type.startsWith('teammate.')) {
    if (typeof payload.status === 'string') peer.status = payload.status
    if (event.type === 'teammate.archived') peer.status = 'archived'
  }
  return next
}

export function reconcileSessionProjection(current: SessionProjection | null, incoming: SessionProjection): SessionProjection {
  if (!current || current.sessionId !== incoming.sessionId) return incoming
  const mergeLive = (live?: LiveTurn, fresh?: LiveTurn): LiveTurn | undefined => {
    if (!live || !fresh || live.runId !== fresh.runId) return fresh
    const longest = (local: string, remote: string) => local.startsWith(remote) ? local : remote
    const tools = new Map((live.turn.tools ?? []).map(tool => [tool.toolCallId, tool]))
    for (const tool of fresh.turn.tools ?? []) {
      const local = tools.get(tool.toolCallId)
      tools.set(tool.toolCallId, local && local.state !== 'running' && tool.state === 'running' ? local : tool)
    }
    const media = new Map([...(live.turn.media ?? []), ...(fresh.turn.media ?? [])].map(item => [item.attachmentId, item]))
    return { ...fresh, turn: { ...fresh.turn, content: longest(live.turn.content, fresh.turn.content), thinking: longest(live.turn.thinking ?? '', fresh.turn.thinking ?? ''), tools: [...tools.values()], media: [...media.values()] } }
  }
  return {
    ...incoming,
    ...(incoming.inFlight ? { inFlight: mergeLive(current.inFlight, incoming.inFlight) } : {}),
    ...(incoming.teammates ? { teammates: incoming.teammates.map(peer => {
      const local = current.teammates?.find(item => item.id === peer.id)
      return { ...peer, ...(peer.inFlight ? { inFlight: mergeLive(local?.inFlight, peer.inFlight) } : {}) }
    }) } : {}),
  }
}
