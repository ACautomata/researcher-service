import { officialSkillTools, type OfficialCatalog } from '../../officialContent/runtime'
// Leader 单 agent 图工厂（#777 · #747 A 节「基础 leader 单 agent loop」）。
//
// createDeepAgent 三扩展点接线（#724 PoC 验证的形态）：
//   model        —— ProviderRegistry 产出的实例（构造期绑定，run 粒度快照语义）
//   backend      —— DockerArchiveBackend（#772；编译期对齐断言见下——#772 protocol.ts
//                   尾注约定的 satisfies 一次性核验落在本文件）
//   checkpointer —— PrismaCheckpointSaver（#774）
//   interruptOn  —— InterruptPolicy 派生（V1 无审批漏斗，默认 undefined；S4 快照/测试注入）
//
// 生产硬约束「图拓扑必须可由持久化状态推导」（PoC 坑 2：resume 重建异拓扑图 → 静默 no-op
// 假 done）：本工厂是纯函数——同参数必同拓扑。拓扑因子 = (systemPrompt, tools 面, interrupt
// policy)；其中 policy 是调用方显式传入的确定性值（V1：构造期静态，#783 审批漏斗接入后由
// session/run 持久化维度派生），**绝不允许运行期可变闭包**（PoC 的 fired 计数器是 throwaway
// 形态，生产禁止——when 恒真或纯输入谓词）。resume 路径（RunService）必须以同 policy 源重建。

import { GENERAL_PURPOSE_SUBAGENT, createDeepAgent, type CreateDeepAgentParams, type DeepAgent } from 'deepagents'
import type { Runnable } from '@langchain/core/runnables'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { SandboxBackendProtocolV2 as DeepAgentsBackendV2 } from 'deepagents'
import type { AnyAgentMiddleware } from 'langchain'
import type { SandboxBackendProtocolV2 as LocalBackendV2 } from '../backend/protocol'

// 编译期对齐断言（#772 预留）：本地协议镜像结构兼容 deepagents 真类型。三包联动升级时
// 此类型红 = 协议漂移，按上游 d.ts 核对 backend/protocol.ts。
type _BackendAlignment = LocalBackendV2 extends DeepAgentsBackendV2 ? true : never
const _BACKEND_ALIGNMENT: _BackendAlignment = true
void _BACKEND_ALIGNMENT

// interrupt 策略（V1 形状）：命中工具名 → 该工具执行前 interrupt（allowedDecisions 恒
// approve/reject 二值，#729 决策集）。数组序无关（deepagents Record 键集）。undefined =
// 无 interrupt 面（生产 V1 默认——审批漏斗归 #783）。
export interface InterruptPolicy {
  readonly tools: readonly string[]
}

type InterruptOnConfig = NonNullable<CreateDeepAgentParams['interruptOn']>

// policy → deepagents interruptOn（确定性派生：when 恒真，无闭包状态——拓扑推导约束）。
export function interruptOnFromPolicy(policy: InterruptPolicy | undefined): InterruptOnConfig | undefined {
  if (!policy || policy.tools.length === 0) return undefined
  const on: InterruptOnConfig = {}
  for (const name of policy.tools) {
    on[name] = { allowedDecisions: ['approve', 'reject'], when: () => true }
  }
  return on
}

export interface LeaderAgentParams {
  // 宽进 Runnable：ProviderRegistry.getDefaultModel 产出 withFallbacks 组合链（#747 F 节
  // 「fallback 链由 runner 从配置快照派生 .withFallbacks」）。
  readonly model: Runnable
  readonly backend: DeepAgentsBackendV2
  readonly checkpointer: BaseCheckpointSaver
  readonly systemPrompt: string
  readonly official?: OfficialCatalog
  readonly interruptPolicy?: InterruptPolicy
  // 审批漏斗中间件（#783；AnyAgentMiddleware 宽进——langchain 中间件类型随版本泛型漂移，
  // 结构面由 runFunnel 的 WrapToolCallHook 推导钉死）。middleware 是运行期行为非拓扑因子，
  // 不入缓存键；跨 run 状态由漏斗自身 per-thread 槽管理。
  readonly middleware?: readonly AnyAgentMiddleware[]
  readonly tools?: NonNullable<CreateDeepAgentParams['tools']>
  // 插件工具集（#788 §4.2）：run 粒度启用集静态过滤产物（LangChain 适配后）。启用集进
  // capabilities.key + 目录版本进图缓存键（runService），同参数必同拓扑约束不受影响。
  readonly pluginTools?: NonNullable<CreateDeepAgentParams['tools']>
  // 系统 prompt 插件段（promptSnippet + guidelines；空集 = 空串不进拼接）。teammate
  // subagent 同步继承（#742 story 47「teammate 默认全继承」的插件维度）。
  readonly pluginPrompt?: string
}

// 构建一个 leader agent 图（纯函数；缓存责任在调用方——RunService 按
// (threadId, 拓扑因子) 缓存实例，版本变更丢缓存重建，见 runService.ts）。
export function buildLeaderAgent(params: LeaderAgentParams): DeepAgent {
  const subagentExtras = [params.official?.prompt, params.pluginPrompt].filter(Boolean).join('\n\n')
  return createDeepAgent({
    // deepagents model 参数类型面只收 BaseLanguageModel；withFallbacks 产物
    // （RunnableBinding）运行时具备完整调用面（invoke/stream/bindTools 全委派），类型面
    // 未被上游宽化。此处 cast 是三包联动升级的核对点：上游宽化后删除。
    model: params.model as unknown as NonNullable<CreateDeepAgentParams['model']>,
    backend: params.backend,
    checkpointer: params.checkpointer,
    systemPrompt: [params.systemPrompt, params.official?.prompt, params.pluginPrompt].filter(Boolean).join('\n\n'),
    ...(params.official || params.pluginPrompt
      ? {
          subagents: [{
            ...GENERAL_PURPOSE_SUBAGENT,
            systemPrompt: [GENERAL_PURPOSE_SUBAGENT.systemPrompt, subagentExtras].filter(Boolean).join('\n\n'),
          }],
        }
      : {}),
    interruptOn: interruptOnFromPolicy(params.interruptPolicy),
    tools: [
      ...(params.official ? officialSkillTools(params.official) : []),
      ...(params.tools ?? []),
      ...(params.pluginTools ?? []),
    ],
    ...(params.middleware !== undefined && params.middleware.length > 0
      ? { middleware: [...params.middleware] }
      : {}),
  })
}

// 图实例的宽化面（RunService 缓存/流消费只依赖 streamEvents/getState——结构子集，避免把
// deepagents 泛型泄漏进编排层签名）。DeepAgent 天然满足：CompiledStateGraph 方法面即此二件，
// getState 顶层直取（deepagents 的 .graph 为图自引用属性，PoC 实测同物）。三包升级时此接口
// 红 = 上游运行时面漂移，按 d.ts 核对。
export interface DeepAgentLike {
  streamEvents(input: unknown, options: object): Promise<AsyncIterable<unknown>>
  getState(config: unknown): Promise<unknown>
  // /compact 显式压缩（#787 story 45）：直接写图状态（_summarizationEvent），返回新 checkpoint config
  updateState(config: unknown, values: unknown): Promise<{ configurable?: { checkpoint_id?: string } }>
}

// policy 的缓存键成分（键序化前 sort——序不敏感，policy 派生面无需保证数组序）。
export function interruptPolicyKey(policy: InterruptPolicy | undefined): string {
  return JSON.stringify([...(policy?.tools ?? [])].sort())
}
