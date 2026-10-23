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
export interface ChaoxingRemote {
  exchange(code: string, verifier: string): Promise<ChaoxingToken>
  refresh(refreshToken: string): Promise<ChaoxingToken>
  courses?(token: string, signal?: AbortSignal): Promise<{ rows: { id: string; name: string; classId?: string }[]; truncated: boolean }>
  inspect(token: string, signal?: AbortSignal): Promise<{ tools: { name: string; description?: string; inputSchema: unknown }[]; capabilities: string[] }>
  learn(token: string, topic: string, courseId?: string, signal?: AbortSignal, target?: ChaoxingQueryTarget): Promise<LearningResult>
}
