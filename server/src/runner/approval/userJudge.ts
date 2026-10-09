import { resolveModelRef, type ProviderConfigSnapshot, type ProviderRegistry } from '../providerRegistry'
import { ToolCallJudgeClient } from './judge'
import { JUDGE_POLICY_MARKDOWN } from './values'

/** 单目标判定：端点故障交漏斗升级人工，不以调用失败触发模型降级。 */
export async function createUserJudgeClient(registry: Pick<ProviderRegistry, 'getModel'>, snapshot: ProviderConfigSnapshot): Promise<ToolCallJudgeClient> {
  const assignment = snapshot.pluginAssignments.get('judge')
  let provider = assignment?.providerId
    ? snapshot.providers.find((p) => p.providerId === assignment.providerId)
    : snapshot.providers[0]
  const dangling = !!assignment?.providerId && (!provider || (assignment.modelId !== null && !provider.models.some((m) => m.id === assignment.modelId)))
  if (dangling) {
    // #880：悬挂引用回落平台；实际调用故障不降级。
    provider = snapshot.providers.find((p) => p.providerId === 'platform')
    // eslint-disable-next-line no-console
    console.warn('[runner] judge 指派悬挂，回落平台默认')
  }
  if (!provider) throw new Error('judge 端点未指派或不可用')
  const modelId = dangling ? provider.models[0]?.id : assignment?.providerId ? assignment.modelId ?? provider.models[0]?.id : provider.models[0]?.id
  if (!modelId) throw new Error('judge 模型不可用')
  resolveModelRef(snapshot, { providerId: provider.providerId, modelId })
  const base = await registry.getModel(snapshot, provider.providerId)
  const model = base.withConfig({ configurable: { model: modelId, temperature: 0 } })
  // judge 只返回判定给漏斗；不继承主会话的消息流/usage 回调。
  // 保留隐式 signal/configurable，取消仍随当前 run；用量仍由 judge 回包进入审批审计。
  return new ToolCallJudgeClient({
    invoke: (messages) => model.invoke(messages as never, { callbacks: [], tags: ['langsmith:nostream'] }),
  }, { policy: JUDGE_POLICY_MARKDOWN })
}
