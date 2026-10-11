// 插件 run 事件族（#744 §11.2 形状定稿 · #792 · #853 §3.2#5/#6 泛化）：progress 落 SSE
// 用户面，其余五类落 TextTrace 审计域（弱关联，sessionKey/runId 关联会话 run）——对齐
// wiki_run.* 定位。
//
// 双面事实同源（#752 R6 域级形态）：插件 execute 内经 onUpdate({stage, ...}) 上报一次，
// runner 同时发 `<kind>_run.progress`（SSE）与落 `<kind>_run.stage_transitions`（TextTrace）
//——翻译面在 RunService（本模块只出白名单校验纯函数与审计 sink 工厂）。
//
// stage 白名单泛化（#853 §3.2#6「插件声明、核心校验」）：figure 六值白名单自核心硬编码改由
// autofigure manifest 声明承载（FIGURE_RUN_STAGES 常量保留于此供其 import——枚举单源不变）；
// 翻译面按「toolCallId→工具名→所属插件」查 manifest 声明，白名单外丢弃不放大（对齐
// projector「多出的不进投影」纪律）。本文件不再内置「查表」职责——只保留枚举与解析纯函数。

import type { AuthUser } from '../types'
import type { PrismaClient } from '../generated/prisma/client'
import type { PluginAuditPort, PluginRunAuditEvent } from '../plugins/api'
import { TRACE_TEXT_MAX, recordTextTrace } from '../traceLogs/service'

// SSE 用户面事件名派生（#853 §3.1：SSE 事件族名按 manifest run.kind 声明派生）。
// 'figure' → 'figure_run.progress' 与既有事件名逐字一致（声明迁移后行为零变）。
export function pluginRunProgressEventName(kind: string): string {
  return `${kind}_run.progress`
}

// SSE 用户面事件名（#747 §C 事件目录增补，对齐 wiki_run.progress 先例）——figure 族常量
// 保留导出（测试锁定派生一致性；`pluginRunProgressEventName('figure') === 本常量`）。
export const FIGURE_RUN_PROGRESS = pluginRunProgressEventName('figure')

// 事件面冻结先例（#853 §3.2#5）：figure_run 五类审计的 TextTrace 载荷形状冻结不动（其
// kind 隐含 'figure'，迁移不做）——翻译面反查 runKind 时命中本值不落 runKind 列；此后
// 声明 run.kind 的插件按新契约落列。
export const FROZEN_RUN_KIND = 'figure'

// figure stage 白名单（#744 §5.5 六值 = §3.1 六节点）——#853 §3.2#6 起由 autofigure
// manifest 的 progressStages 声明承载（常量保留 = 枚举单源，插件 re-export 消费不变）。
export const FIGURE_RUN_STAGES = [
  'generating',
  'segmenting',
  'preparing',
  'templating',
  'assembling',
  'rendering',
] as const

export type FigureStage = (typeof FIGURE_RUN_STAGES)[number]

// onUpdate partial 的白名单校验（runner 翻译面入口）：形状 {stage: 白名单值之一}——白名单
// 外（未知形状/未知 stage）一律丢弃不放大。其余可枚举自有属性作为 extra 透传（#853 §6.1：
// research_run.progress 载荷 {toolCallId, stage, workflow}——workflow 等域字段随 partial
// 进 SSE 载荷与 TextTrace stage_transitions detail（双面同一事实））。保留键（stage/
// toolCallId）不入 extra——载荷身份由 runner 锚定，插件上报同名键不可改写（SSE 载荷与
// 审计检索按 outputText 过滤的身份面）。
// extra 防放大护栏：序列化超限丢弃（对齐 projector 截断纪律——受信插件面，护栏防御性）。
// 量纲为 UTF-16 码元数（JSON.stringify().length），命名 _CHARS 如实。
const PROGRESS_EXTRA_MAX_CHARS = 512

export function parsePluginRunProgress(
  partial: unknown,
  stages: ReadonlySet<string>,
): { readonly stage: string; readonly extra: Readonly<Record<string, unknown>> } | null {
  if (typeof partial !== 'object' || partial === null) return null
  const stage = (partial as { stage?: unknown }).stage
  if (typeof stage !== 'string' || !stages.has(stage)) return null
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(partial as Record<string, unknown>)) {
    if (key !== 'stage' && key !== 'toolCallId') extra[key] = value
  }
  try {
    if (JSON.stringify(extra).length > PROGRESS_EXTRA_MAX_CHARS) return { stage, extra: {} }
  } catch {
    return { stage, extra: {} } // 循环引用等不可序列化 extra——只落 stage
  }
  return { stage, extra }
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
//   runKind 盖章（#853 §3.2#5）：runKindOf 反查非空时并入 outputText 载荷（runKind 列）；
//   反查逻辑归装配面（RunService 按工具名→插件→manifest.run.kind），figure 族由装配面
//   返回 undefined 实现事件面冻结。
// emitPluginRun 签名 void（#744 §11.1 钉死）→ fire-and-forget，落库失败 fail-soft warn
//（审计面不放大为 run 故障；overwriteAudit fail-soft 先例）。
// ---------------------------------------------------------------------------

export interface PluginRunAuditSinkIdentity {
  readonly ownerId: string
  readonly username: string
  readonly sessionId: string
  readonly runId: string
}

export function createPrismaPluginRunAuditSink(
  prisma: PrismaClient,
  identity: PluginRunAuditSinkIdentity,
  opts: { readonly runKindOf?: (toolCallId: string) => string | undefined } = {},
): PluginAuditPort {
  return {
    emitPluginRun(event: PluginRunAuditEvent): void {
      const runKind = opts.runKindOf?.(event.toolCallId)
      // 保留键后置锚定（extra-first）：detail 域字段先铺（workflow 等），身份键
      //（event/toolCallId/runKind）恒以 runner 侧值为准——插件面携带同名键不可改写
      //（审计检索按 outputText 过滤，身份可伪造即误检）。runKind 恒铺键：有值 = 盖章
      // 锚定；undefined（figure 冻结族）= JSON.stringify 剔除该键，detail 假键一并清除
      //（冻结面「载荷无 runKind 列」语义在插件面恶意携带下仍成立）。
      const outputText = JSON.stringify({
        ...event.detail,
        runKind,
        event: event.event,
        toolCallId: event.toolCallId,
      })
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
        console.warn(`[plugins] 插件 run 审计落库失败: run=${identity.runId}: ${String(err)}`)
      })
    },
  }
}
