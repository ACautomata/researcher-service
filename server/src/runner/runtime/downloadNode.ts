// #780 下载校验节点（agent→用户，图内 wrapToolCall 后置钩子）：file 写类工具成功后校验声明
// 路径——/lab 白名单 + 存在性 + 非穿越。正确 → 物化 Attachment 行 + 下载引用追加进 tool 输出
// 文本（projector tool.end details ≤4KB 承载，前端工具结果卡渲染下载入口；字节经
// GET /attachments/:id/download）；不正确 → 错误 ToolMessage 回喂 agent loop 重新生成（与
// reject 回喂同哲学，spec §2.4 节点化语义）。
// V1 覆盖工具：write/edit（deepagents fs 工具，FILE_PATH_PARAM_NAMES 提取路径）。execute 的
// shell 写是旁路（与 D8 exec 显式降级同哲学，不做产物面）。中间件是运行期行为非拓扑因子
//（同 #783 漏斗先例）——不入图缓存键。

import { createMiddleware } from 'langchain'
import type { WrapToolCallHook } from 'langchain'
import { ToolMessage } from '@langchain/core/messages'
import { FILE_PATH_PARAM_NAMES } from '../approval/values'
import { mimeFromPath } from './mediaBlocks'

type NodeRequest = Parameters<WrapToolCallHook>[0]
type NodeHandler = Parameters<WrapToolCallHook>[1]

// V1 覆盖的写类工具（deepagents fs 工具名）。
const DOWNLOAD_DECLARING_TOOLS: readonly string[] = ['write', 'edit']

export interface DownloadNodeDeps {
  /** 物化（校验/拷贝/建行；ownerId 由装配层按 session 解析）。null = 校验失败 → 回喂面 */
  readonly materialize: (p: {
    sessionId: string
    declaredPath: string
    mime: string
    container: string
  }) => Promise<{ attachmentId: string; fileName: string; mimeType: string; size: number } | null>
  /** 沙箱容器名解析（threadId = sessionId；researcher-sandbox-<sessionId> 单一来源派生） */
  readonly resolveContainer: (threadId: string) => string | Promise<string>
  /** 降级/失败审计计数（V1 warn 留痕——静默失败不可接受，#766 D8 观测面纪律） */
  readonly audit?: (info: { sessionId: string; path: string; outcome: 'feedback_error' | 'reference_added' }) => void
}

// 工具结果文本提取（仅 string content 可追加引用；块数组 content V1 不改写——原样透传）。
function resultText(result: ToolMessage): string | null {
  const c = (result as { content?: unknown }).content
  return typeof c === 'string' ? c : null
}

export function createDownloadNode(deps: DownloadNodeDeps) {
  const wrapToolCall: WrapToolCallHook = async (request: NodeRequest, handler: NodeHandler) => {
    const name = String((request.toolCall as { name?: unknown })?.name ?? '')
    if (!DOWNLOAD_DECLARING_TOOLS.includes(name)) return handler(request)
    const args = ((request.toolCall as { args?: unknown })?.args ?? {}) as Record<string, unknown>
    const rawPath = FILE_PATH_PARAM_NAMES.map((k) => args[k]).find((v) => typeof v === 'string' && v !== '')
    if (typeof rawPath !== 'string') return handler(request)
    if (!rawPath.startsWith('/lab/') || rawPath.includes('..')) return handler(request) // wiki 写/非法路径不进产物面

    const result = await handler(request)
    const msg = result as ToolMessage
    // 工具自身失败（status error）原样透传——agent 自纠面，不做产物校验（避免双重错误语义）
    if ((msg as { status?: unknown }).status === 'error') return result

    const threadId = String(
      (request.runtime as { configurable?: { thread_id?: unknown } } | undefined)?.configurable?.thread_id ?? '',
    )
    const meta = await deps.materialize({
      sessionId: threadId,
      declaredPath: rawPath,
      mime: mimeFromPath(rawPath) ?? 'application/octet-stream',
      container: await deps.resolveContainer(threadId),
    })
    if (meta === null) {
      // 路径不正确（产物未落盘/已删/穿越）→ 错误回喂 agent loop 重新生成
      deps.audit?.({ sessionId: threadId, path: rawPath, outcome: 'feedback_error' })
      return new ToolMessage({
        tool_call_id: String((request.toolCall as { id?: unknown })?.id ?? ''),
        name,
        content: `文件校验失败：声明的产物 ${rawPath} 未落盘或路径无效，请重新生成后再声明`,
        status: 'error',
      })
    }
    // 正确 → 下载引用追加进 tool 输出（tool.end details 承载；≤4KB 截断由 projector 统一纪律）
    const text = resultText(msg)
    deps.audit?.({ sessionId: threadId, path: rawPath, outcome: 'reference_added' })
    if (text === null) return result // 块数组 content：V1 不改写（引用面缺席可接受）
    return new ToolMessage({
      tool_call_id: String((request.toolCall as { id?: unknown })?.id ?? ''),
      name,
      content: `${text}\n[download attachmentId=${meta.attachmentId} fileName=${meta.fileName} mime=${meta.mimeType} size=${meta.size}]`,
      status: (msg as { status?: unknown }).status === 'error' ? 'error' : undefined,
    })
  }

  return {
    // 与 ApprovalFunnel.middleware 同形（graphFactory middleware 数组元素；AnyAgentMiddleware）
    middleware: createMiddleware({
      name: 'attachment-download-node',
      wrapToolCall,
    }),
    // 测试直调面（S3：hook 纯逻辑断言；生产消费 middleware 字段）
    wrapToolCall,
  }
}
