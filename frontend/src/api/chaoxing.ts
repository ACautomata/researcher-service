import { apiJson } from './client'
export interface ChaoxingStatus { configured: boolean; connected: boolean; expiresAt: string | null }
const base = '/api/v1/integrations/chaoxing'
export const getChaoxingStatus = () => apiJson<ChaoxingStatus>(base)
export const authorizeChaoxing = () => apiJson<{ url: string }>(`${base}/authorize`, { method: 'POST', body: '{}' })
export const unlinkChaoxing = () => apiJson<null>(base, { method: 'DELETE', body: '{}' })
export interface LearningCourse { id: string; name: string; classId?: string }
export const listChaoxingCourses = () => apiJson<{ rows: LearningCourse[]; truncated: boolean }>(`${base}/courses`)
export const getLearningScope = (sessionId: string) => apiJson<{ courseId: string | null }>(`${base}/sessions/${encodeURIComponent(sessionId)}/scope`)
export const setLearningScope = (sessionId: string, courseId: string | null) => apiJson<{ courseId: string | null }>(`${base}/sessions/${encodeURIComponent(sessionId)}/scope`, { method: 'PUT', body: JSON.stringify({ courseId }) })
