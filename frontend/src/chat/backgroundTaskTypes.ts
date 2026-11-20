export interface BackgroundTask {
  id: string
  executorName?: string
  threadId: string
  runId: string
  command: string
  state: string
  delivery: string
  exitCode: number | null
  truncated: boolean
  createdAt: string
  finishedAt: string | null
  updatedAt: string
}
export interface BackgroundOutput {
  stdout: string
  stderr: string
  nextOffset: number | null
  truncated: boolean
}
