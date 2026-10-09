import { describe, it, expect, vi } from 'vitest'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ProviderConfigSnapshot } from '../src/runner/providerRegistry'
import { createUserJudgeClient } from '../src/runner/approval/userJudge'

const providers = ['byok', 'platform'].map((providerId) => ({
  providerId, lcProvider: 'openai' as const, baseUrl: 'https://api.openai.com/v1',
  authHeader: true, credentialCipher: null, models: [{ id: `${providerId}-model` }, { id: 'other' }],
}))
function snapshot(assignment?: { providerId: string | null; modelId: string | null }): ProviderConfigSnapshot {
  return { ownerId: 'owner', version: 1, providers, pluginAssignments: new Map(assignment ? [['judge', assignment]] : []) }
}
describe('judge 用户端点链（#884）', () => {
  it.each([
    [undefined, 'byok'],
    [{ providerId: null, modelId: null }, 'byok'],
    [{ providerId: 'platform', modelId: null }, 'platform'],
  ] as const)('指派优先，其次默认链 primary', async (assignment, expected) => {
    const getModel = vi.fn().mockResolvedValue({ invoke: vi.fn() })
    await createUserJudgeClient({ getModel }, snapshot(assignment))
    expect(getModel).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner' }), expected)
  })
  it('零用户端点落平台默认', async () => {
    const getModel = vi.fn().mockResolvedValue({ invoke: vi.fn() })
    await createUserJudgeClient({ getModel }, { ...snapshot(), providers: providers.slice(1) })
    expect(getModel.mock.calls[0]?.[1]).toBe('platform')
  })
  it('显式非首模型绑定，不切换端点', async () => {
    const withConfig = vi.fn().mockReturnValue({ invoke: vi.fn() })
    await createUserJudgeClient({ getModel: vi.fn().mockResolvedValue({ withConfig } as unknown as BaseChatModel) }, snapshot({ providerId: 'byok', modelId: 'other' }))
    expect(withConfig).toHaveBeenCalledWith({ configurable: { model: 'other' } })
  })
  it('悬挂指派拒绝解析，不静默切换平台', async () => {
    const getModel = vi.fn()
    await expect(createUserJudgeClient({ getModel }, snapshot({ providerId: 'deleted', modelId: 'missing' }))).rejects.toThrow('judge 端点')
    expect(getModel).not.toHaveBeenCalled()
  })
})
