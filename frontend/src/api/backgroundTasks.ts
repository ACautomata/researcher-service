import { apiJson } from './client'

import type { BackgroundTask, BackgroundOutput } from '@/chat/backgroundTaskTypes'
export type { BackgroundTask, BackgroundOutput } from '@/chat/backgroundTaskTypes'
const path = (session: string) => `/api/v1/sessions/${encodeURIComponent(session)}/background-tasks`
export const listBackgroundTasks = (session: string) => apiJson<BackgroundTask[]>(path(session))
export const getBackgroundOutput = (session: string, task: string, offset = 0) =>
  apiJson<BackgroundOutput>(`${path(session)}/${encodeURIComponent(task)}?offset=${offset}`)
export const cancelBackgroundTask = (session: string, task: string) =>
  apiJson<null>(`${path(session)}/${encodeURIComponent(task)}/cancel`, { method: 'POST', body: '{}' })
