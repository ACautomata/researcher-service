import { ToolMessage } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'

/** All delegation in a team must pass through named, persisted teammate tools. */
export const teammateDelegation = createMiddleware({
  name: 'TeammateDelegation',
  wrapModelCall: (request, handler) => handler({
    ...request,
    tools: request.tools.filter(tool => !('name' in tool && tool.name === 'task')),
  }),
  wrapToolCall: (request, handler) => request.toolCall.name === 'task'
    ? new ToolMessage({ tool_call_id: request.toolCall.id!, content: 'Use spawn_teammate as the leader, or request_teammate as a teammate. Nested task delegation is unavailable.' })
    : handler(request),
})
