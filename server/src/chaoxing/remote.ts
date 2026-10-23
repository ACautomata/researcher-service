import { z } from 'zod'

export const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().refine(v => v.toLowerCase() === 'bearer'),
  expires_in: z.coerce.number().positive().finite().max(31536000).optional(),
})
export type ChaoxingToken = z.infer<typeof tokenSchema>
export interface LearningResource {
  id: string
  name: string
  courseId: string
  courseName: string
  url?: string
  text?: string
  kind: 'resource' | 'topic'
}
export interface LearningResult { resources: LearningResource[]; limitations: string[] }
export type ChaoxingQueryTarget = 'all' | 'resources' | 'topics'
/** 部署映射缺失等本地配置问题：文案由本模块产生，可安全直出。 */
export class ChaoxingConfigError extends Error {}
export type McpStage = 'initialize' | 'tools/list' | 'tools/call'
/** 仅由传输适配器构造的静态诊断；不携带原异常正文、请求头或令牌。 */
export class ChaoxingMcpError extends Error {
  constructor(readonly stage: McpStage, readonly httpStatus?: number, readonly timedOut = false) {
    const label = { initialize: '初始化', 'tools/list': '工具目录读取', 'tools/call': '只读工具调用' }[stage]
    super(`超星 MCP ${label}${timedOut ? '超时' : '失败'}${httpStatus ? `（HTTP ${httpStatus}）` : ''}`)
  }
}
export interface McpInspection {
  tools: { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }[]
  /** 仅表示已经配置且在当前目录出现，不等于真实调用或业务语义验收通过。 */
  capabilities: string[]
  connection?: {
    initialized: true
    transport: 'streamable-http'
    protocolVersion: string
    authentication: 'oauth-bearer'
    sessionMode: 'stateful' | 'stateless'
  }
  mappingChecks?: { capability: string; toolName?: string; status: 'not-configured' | 'tool-missing' | 'not-read-only' | 'listed'; callVerified: false }[]
}
export interface ChaoxingRemote {
  exchange(code: string, verifier: string): Promise<ChaoxingToken>
  refresh(refreshToken: string): Promise<ChaoxingToken>
  courses?(token: string, signal?: AbortSignal): Promise<{ rows: { id: string; name: string; classId?: string }[]; truncated: boolean }>
  inspect(token: string, signal?: AbortSignal): Promise<McpInspection>
  learn(token: string, topic: string, courseId?: string, signal?: AbortSignal, target?: ChaoxingQueryTarget): Promise<LearningResult>
}
