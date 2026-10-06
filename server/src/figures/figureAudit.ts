// figure_run 事件族（#744 §11.2 形状定稿 · #792）：progress 落 SSE 用户面，其余五类落
// TextTrace 审计域（弱关联，sessionKey/runId 关联会话 run）——对齐 wiki_run.* 定位。
//
// 双面事实同源（#752 R6 域级形态）：插件 execute 内经 onUpdate({stage}) 上报一次，
// runner 同时发 figure_run.progress（SSE）与落 figure_run.stage_transitions（TextTrace）
//——翻译面在 RunService（本模块只出白名单校验纯函数与审计 sink 工厂）。
//
// stage 枚举单源：本文件定义六值（核心域——SSE 白名单校验面所在），插件 pipeline/values
// 经 re-export 消费（插件→核心方向，#788 plugins → server 源目录直引同向）。

import type { AuthUser } from '../types'
import type { PrismaClient } from '../generated/prisma/client'
import type { FigureRunAuditEvent, PluginAuditPort } from '../plugins/api'
import { TRACE_TEXT_MAX, recordTextTrace } from '../traceLogs/service'

// SSE 用户面事件名（#747 §C 事件目录增补，对齐 wiki_run.progress 先例）。
export const FIGURE_RUN_PROGRESS = 'figure_run.progress'

// stage 白名单（#744 §5.5 六值 = §3.1 六节点）。
export const FIGURE_RUN_STAGES = [
  'generating',
  'segmenting',
  'preparing',
  'templating',
  'assembling',
  'rendering',
] as const

export type FigureStage = (typeof FIGURE_RUN_STAGES)[number]

// onUpdate partial 的白名单校验（runner 翻译面入口）：形状 {stage: 六值之一}——白名单外
// （未知形状/未知 stage）一律丢弃不放大（对齐 projector「多出的不进投影」纪律）。
export function parseFigureRunProgress(partial: unknown): { readonly stage: FigureStage } | null {
  if (typeof partial !== 'object' || partial === null) return null
  const stage = (partial as { stage?: unknown }).stage
  if (typeof stage !== 'string') return null
  return (FIGURE_RUN_STAGES as readonly string[]).includes(stage) ? { stage: stage as FigureStage } : null
}

// methodText 审计截断（created 载荷「methodText 截断」，#744 §11.2；与 TextTrace 落库
// 上限同口径）。
export function truncateAuditMethodText(methodText: unknown): string {
  if (typeof methodText !== 'string') return ''
  return methodText.length <= TRACE_TEXT_MAX ? methodText : methodText.slice(0, TRACE_TEXT_MAX)
}

// ---------------------------------------------------------------------------
// TextTrace 审计 sink（audit 面核心实现）：五类事件逐条落 text_trace_logs——
//   inputText = created 事件的 methodText 截断（其余类空）；outputText = 事件 JSON；
//   status = failed/aborted → 'failed'，其余 'success'；sessionKey=sessionId、runId=runId
//   弱关联。落库走 recordTextTrace 单一实现（traceId HMAC、outputHash 同口径）。
// emitFigureRun 签名 void（#744 §11.1 钉死）→ fire-and-forget，落库失败 fail-soft warn
//（审计面不放大为 run 故障；overwriteAudit fail-soft 先例）。
// ---------------------------------------------------------------------------

export interface FigureRunAuditSinkIdentity {
  readonly ownerId: string
  readonly username: string
  readonly sessionId: string
  readonly runId: string
}

export function createPrismaFigureRunAuditSink(
  prisma: PrismaClient,
  identity: FigureRunAuditSinkIdentity,
): PluginAuditPort {
  return {
    emitFigureRun(event: FigureRunAuditEvent): void {
      const outputText = JSON.stringify({ event: event.event, toolCallId: event.toolCallId, ...event.detail })
      const methodText = event.event === 'created' ? truncateAuditMethodText(event.detail.methodText) : ''
      const status = event.event === 'failed' || event.event === 'aborted' ? 'failed' : 'success'
      // recordTextTrace 只消费 user.id/user.username——runner 面身份只有这两件，余字段
      // 以类型面中性值补齐（AuthUser 形状要求；不参与落库）。
      const runnerIdentity = {
        id: identity.ownerId,
        username: identity.username,
        email: null,
        role: 'user',
        isActive: true,
        mustChangePassword: false,
        maxContainers: 0,
      } as const satisfies AuthUser
      void recordTextTrace(prisma, {
        user: runnerIdentity,
        ipAddress: '',
        containerName: null,
        sessionKey: identity.sessionId,
        runId: identity.runId,
        inputText: methodText,
        outputText,
        status,
      }).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[figures] figure_run 审计落库失败: run=${identity.runId}: ${String(err)}`)
      })
    },
  }
}
