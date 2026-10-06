// openwiki 生命周期工具（#790 · #747 G 节 wiki 三通道②：wiki-update teammate 的治理驱动面）。
//
// HostSessionManager.tools()（session-manager.d.ts）返回共 10 个 ProtocolTool = 4 只读检索 +
// 6 生命周期（protocol.d.ts ProtocolToolName 十值联合）。本模块**按名挑六个生命周期工具**
// 包装成 LangChain 工具进 teammate 图：openwiki_begin/submit_plan/next_page/inspect_page_claims/
// submit_page/finish——检索四工具不包（#789 常驻检索已在每图装配，重复包装 = 模型面同名冲突）。
//
// root 注入：openwiki_begin 的上游 schema 含必填 root（仓库根）——治理语义下 root = 控制面
// 落地镜像根（per-run 临时目录，非 agent 可控），模型面 schema 裁掉 root（#789 检索工具
// schema 裁剪先例），wrapper 在 handle 入参注入。其余工具的 runId/jobId 是运行期返回值，
// 模型面保留。
//
// Result 契约（#737，wikisearch.ts 同形）：`{ok:true,data}|{ok:false,error:{code,message,hint?}}`
// 永不 throw——openwiki 生命周期异常（RepositoryRunError 经 session-manager 映射为
// HostIntegrationError，code ∈ invalid_input/invalid_state/conflict）在 wrapper 归类转译；
// code 增 'conflict'（base-hash 冲突中止不静默覆盖的 agent 可读回喂）。
//
// finish 追加治理副作用：上游 finish 只落镜像（durable completion），推回容器 = 本模块
// onFinished 钩子（RunService 注入「base-hash 复检 → pushBack → 冲突信箱邮件」）——只有
// finish 工具触发推回，中断/失败路径不推回（runService finally dispose 镜像）。
//
// 模型面 schema 用本仓 zod 实例重建（键集镜像上游 strict 形状，S3 锁定防漂移）；上游
// handle() 内部仍经 openwiki 自有 zod 复验（BeginInput.parse 等）——校验权威在上游，键集
// 测试是漂移哨兵。deep-import 路径属包内部面（openwiki 无 exports 字段），升级时跑本模块
// 测试作契约测试（wikisearch.ts 头注同纪律）。

import { tool, type DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { HostSessionManager } from 'openwiki/dist/integrations/core/session-manager.js'
import type { ProtocolTool, ProtocolToolName } from 'openwiki/dist/integrations/core/protocol.js'
import { HostIntegrationError } from 'openwiki/dist/integrations/core/errors.js'
import type { WikiToolError, WikiToolOk, WikiToolResult } from '../wikisearch'

// 六个生命周期工具名（包装白名单；检索四工具 openwiki_list_workspaces/list_wikis/search/read
// 刻意不在面内）。
export const WIKI_LIFECYCLE_TOOL_NAMES: readonly ProtocolToolName[] = [
  'openwiki_begin',
  'openwiki_submit_plan',
  'openwiki_next_page',
  'openwiki_inspect_page_claims',
  'openwiki_submit_page',
  'openwiki_finish',
] as const

// ---------------------------------------------------------------------------
// 模型面 schema（键集镜像 openwiki/integrations/core/protocol.js strict 形状；root 裁掉）
// ---------------------------------------------------------------------------

const BeginModelSchema = z.object({
  mode: z.enum(['init', 'update']).describe('Repository generation command to start or resume.'),
  language: z.string().optional().describe('Optional BCP-47 output language (e.g. "zh-CN"); omit to keep the wiki\'s existing language.'),
  force: z.boolean().optional().describe('Whether update no-op detection must be bypassed.'),
})

const RunModelSchema = z.object({
  runId: z.string().describe('Stable UUID returned by openwiki_begin for the active run.'),
})

const PlanPageModelSchema = z.object({
  path: z.string().describe('Canonical wiki page path, e.g. "openwiki/concepts/demo.md".'),
  title: z.string(),
  purpose: z.string(),
  seedPaths: z.array(z.string()).optional(),
  relatedPages: z.array(z.string()).optional(),
  instructions: z.array(z.string()).optional(),
})

const SubmitPlanModelSchema = z.object({
  runId: z.string(),
  pages: z.array(PlanPageModelSchema).describe('Complete ordered page plan.'),
  deletePages: z.array(z.string()).optional(),
})

const InspectPageClaimsModelSchema = z.object({
  runId: z.string(),
  jobId: z.string().describe('Pending page job id returned by openwiki_next_page.'),
})

const SubmitPageModelSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  confirmedClaimIds: z.array(z.string()).optional(),
  claims: z
    .array(
      z.object({
        id: z.string().optional(),
        statement: z.string(),
        evidence: z.array(z.object({ resource: z.string() })).min(1),
      }),
    )
    .optional(),
  retractedClaimIds: z.array(z.string()).optional(),
})

const MODEL_SCHEMAS: Record<ProtocolToolName, z.ZodObject<z.ZodRawShape>> = {
  openwiki_list_workspaces: z.object({}), // 检索四工具不包——占位仅为 Record 完整性
  openwiki_list_wikis: z.object({}),
  openwiki_search: z.object({}),
  openwiki_read: z.object({}),
  openwiki_begin: BeginModelSchema,
  openwiki_submit_plan: SubmitPlanModelSchema,
  openwiki_next_page: RunModelSchema,
  openwiki_inspect_page_claims: InspectPageClaimsModelSchema,
  openwiki_submit_page: SubmitPageModelSchema,
  openwiki_finish: RunModelSchema,
}

// ---------------------------------------------------------------------------
// 包装
// ---------------------------------------------------------------------------

export interface WikiLifecycleToolDeps {
  /** openwiki 单 run 生命周期适配器（per-run 新建——process-local 运行时） */
  readonly manager: HostSessionManager
  /** 落地镜像仓库根（openwiki_begin 的 root 注入值；模型面不可见） */
  readonly mirrorRoot: string
  /**
   * finish 落定后的治理副作用（base-hash 复检 → 推回 → 冲突信箱邮件，RunService 注入）。
   * 返回非 ok Result = 冲突/失败——finish 工具原样回传（不推回语义由本钩子兑现）。
   */
  readonly onFinished: () => Promise<WikiToolResult>
}

function classifyLifecycleError(e: unknown): WikiToolError['error'] {
  if (e instanceof HostIntegrationError) {
    return { code: e.code, message: e.message }
  }
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) }
}

// 包装一个上游 ProtocolTool：zod 模型面 + Result 回传 + begin root 注入 + finish 副作用钩子。
function wrapLifecycleTool(upstream: ProtocolTool, deps: WikiLifecycleToolDeps): DynamicStructuredTool {
  return tool(
    async (input) => {
      try {
        const payload =
          upstream.name === 'openwiki_begin'
            ? { ...(input as Record<string, unknown>), root: deps.mirrorRoot }
            : input
        const data = await upstream.handle(payload)
        if (upstream.name !== 'openwiki_finish') {
          return JSON.stringify({ ok: true, data } satisfies WikiToolOk)
        }
        const push = await deps.onFinished()
        if (!push.ok) return JSON.stringify(push) // conflict/failed Result 原样回传（不推回）
        return JSON.stringify({ ok: true, data: { finish: data, push: push.data } } satisfies WikiToolOk)
      } catch (e) {
        return JSON.stringify({ ok: false, error: classifyLifecycleError(e) } satisfies WikiToolError)
      }
    },
    {
      name: upstream.name,
      description: upstream.description,
      schema: MODEL_SCHEMAS[upstream.name],
    },
  )
}

// 按名挑六包装（上游缺名 = openwiki 面漂移，构造期即红——静默缺工具不可接受）。
export function createWikiLifecycleTools(deps: WikiLifecycleToolDeps): DynamicStructuredTool[] {
  const byName = new Map<ProtocolToolName, ProtocolTool>(deps.manager.tools().map((t) => [t.name, t]))
  return WIKI_LIFECYCLE_TOOL_NAMES.map((name) => {
    const upstream = byName.get(name)
    if (!upstream) {
      throw new Error(`openwiki HostSessionManager is missing lifecycle tool: ${name}（上游面漂移，核对 openwiki/dist/integrations/core/protocol.js）`)
    }
    return wrapLifecycleTool(upstream, deps)
  })
}
