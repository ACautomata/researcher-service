import { resolveModelRef, type ProviderConfigSnapshot, type ProviderRegistry } from '../providerRegistry'
import { ToolCallJudgeClient } from './judge'
import { JUDGE_POLICY_MARKDOWN } from './values'

/** 单目标判定：端点故障交漏斗升级人工，不以调用失败触发模型降级。 */
export async function createUserJudgeClient(registry: Pick<ProviderRegistry, 'getModel'>, snapshot: ProviderConfigSnapshot): Promise<ToolCallJudgeClient> {
  const assignment = snapshot.pluginAssignments.get('judge')
  const provider = assignment?.providerId
    ? snapshot.providers.find((p) => p.providerId === assignment.providerId)
    : snapshot.providers[0]
  if (!provider) throw new Error('judge 端点未指派或不可用')
  const modelId = assignment?.providerId ? assignment.modelId ?? provider.models[0]?.id : provider.models[0]?.id
  if (!modelId) throw new Error('judge 模型不可用')
  resolveModelRef(snapshot, { providerId: provider.providerId, modelId })
  const base = await registry.getModel(snapshot, provider.providerId)
  const model = modelId === provider.models[0]?.id ? base : base.withConfig({ configurable: { model: modelId } })
  return new ToolCallJudgeClient({ invoke: (messages) => model.invoke(messages as never, { temperature: 0 } as never) }, { policy: JUDGE_POLICY_MARKDOWN })
}
