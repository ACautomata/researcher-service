// #780 片 3 下载校验节点（S3 纯逻辑）：wrapToolCall 后置钩子——write/edit 成功后校验声明
// 路径（/lab 白名单 + 存在性），正确 → 物化 + 下载引用追加进 tool 输出（tool.end details
// 承载）；不正确 → 错误 ToolMessage 回喂 agent loop 重新生成；非声明工具/wiki 路径/工具自身
// 失败 → 原样透传。

import { describe, it, expect, vi } from 'vitest'
import { ToolMessage } from '@langchain/core/messages'
import { createDownloadNode, type DownloadNodeDeps } from '../src/runner/runtime/downloadNode'

// WrapToolCallHook 的 request 形状（ToolCallRequest 含 tool/state 图通道字段——S3 直调只消费
// toolCall/runtime，其余字段以最小形状断言补齐，类型断言收窄）。
type HookReq = Parameters<ReturnType<typeof createDownloadNode>['wrapToolCall']>[0]

function makeDeps(
  overrides: Partial<Pick<DownloadNodeDeps, 'resolveContainer'>> = {},
): Omit<DownloadNodeDeps, 'materialize' | 'audit' | 'resolveContainer'> & {
  materialize: ReturnType<typeof vi.fn>
  audit: ReturnType<typeof vi.fn>
  resolveContainer: (threadId: string) => string
} {
  const materialize = vi.fn(async () => ({
    attachmentId: '9007199254740993',
    fileName: 'report.md',
    mimeType: 'application/octet-stream',
    size: 12,
  }))
  const audit = vi.fn()
  return { materialize, audit, resolveContainer: (t) => `researcher-sandbox-${t}`, ...overrides }
}

function writeRequest(path: string, toolName = 'write'): HookReq {
  return {
    toolCall: { id: 'call-1', name: toolName, args: { file_path: path, content: 'x' } },
    runtime: { configurable: { thread_id: 'sess-1' } },
  } as unknown as HookReq
}

function okTool(): ToolMessage {
  return new ToolMessage({ tool_call_id: 'call-1', name: 'write', content: 'File written successfully' })
}

describe('#780 片 3 下载校验节点（S3）', () => {
  it('正确路径 → 物化 + 下载引用追加进 tool 输出（[download ...] 行，tool.end details 承载）', async () => {
    const deps = makeDeps()
    const node = createDownloadNode(deps)
    const handler = vi.fn(async () => okTool())
    const result = (await node.wrapToolCall(writeRequest('/lab/report.md'), handler)) as ToolMessage
    expect(deps.materialize).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      declaredPath: '/lab/report.md',
      mime: 'application/octet-stream', // .md 不在媒体白名单 → 下载不受限回退
      container: 'researcher-sandbox-sess-1',
    })
    expect(String(result.content)).toBe(
      'File written successfully\n[download attachmentId=9007199254740993 fileName=report.md mime=application/octet-stream size=12]',
    )
    expect(result.status).not.toBe('error')
    expect(deps.audit).toHaveBeenCalledWith({ sessionId: 'sess-1', path: '/lab/report.md', outcome: 'reference_added' })
  })

  it('路径不正确（物化 null：产物未落盘/已删）→ 错误 ToolMessage 回喂 agent 重新生成', async () => {
    const deps = makeDeps()
    deps.materialize.mockResolvedValue(null)
    const node = createDownloadNode(deps)
    const handler = vi.fn(async () => okTool())
    const result = (await node.wrapToolCall(writeRequest('/lab/gone.md'), handler)) as ToolMessage
    expect(result.status).toBe('error')
    expect(String(result.content)).toContain('文件校验失败')
    expect(String(result.content)).toContain('/lab/gone.md')
    expect(deps.audit).toHaveBeenCalledWith({ sessionId: 'sess-1', path: '/lab/gone.md', outcome: 'feedback_error' })
  })

  it('非声明工具（execute）/wiki 路径/穿越路径 → 原样透传不物化', async () => {
    const deps = makeDeps()
    const node = createDownloadNode(deps)
    const handler = vi.fn(async () => okTool())
    // execute（shell 写旁路——D8 exec 显式降级同哲学）
    await node.wrapToolCall(
      {
        toolCall: { id: 'c', name: 'execute', args: { command: 'echo hi' } },
        runtime: { configurable: { thread_id: 's' } },
      } as unknown as HookReq,
      handler,
    )
    // wiki 路径（/wiki/ 前缀不进产物面）
    await node.wrapToolCall(writeRequest('/wiki/main/a.md'), handler)
    // 穿越路径
    await node.wrapToolCall(writeRequest('/lab/../etc/passwd'), handler)
    expect(deps.materialize).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('工具自身失败（status error）→ 原样透传（agent 自纠面，不做产物校验）', async () => {
    const deps = makeDeps()
    const node = createDownloadNode(deps)
    const failed = new ToolMessage({ tool_call_id: 'call-1', name: 'write', content: 'write failed', status: 'error' })
    const handler = vi.fn(async () => failed)
    const result = (await node.wrapToolCall(writeRequest('/lab/x.md'), handler)) as ToolMessage
    expect(result).toBe(failed) // 同一对象透传
    expect(deps.materialize).not.toHaveBeenCalled()
  })
})
