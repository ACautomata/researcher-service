// containerKind 标签识别（#858 三值收敛 wiki|sandbox 后的单测锁定）。
// 消费点 = wikiContainers/dockerRuntime 防御性识别（kind ≠ wiki 不触碰）——识别规则漂移
// 即跨 kind 误删风险，故规则层钉死。

import { describe, expect, it } from 'vitest'
import { KIND_SANDBOX, KIND_WIKI, LABEL_KIND_KEY, LABEL_OWNER_KEY, LABEL_SESSION_KEY } from '../src/containers/constants'
import { containerKind } from '../src/containers/kind'

describe('containerKind（#858 收敛 wiki|sandbox）', () => {
  it('researcher.kind=wiki|sandbox → 对应 kind', () => {
    expect(containerKind({ [LABEL_KIND_KEY]: KIND_WIKI })).toBe('wiki')
    expect(containerKind({ [LABEL_KIND_KEY]: KIND_SANDBOX })).toBe('sandbox')
  })

  it('无标签 / 空 labels / 未知值 → null（非本编排资产，防御性不触碰）', () => {
    expect(containerKind({})).toBeNull()
    expect(containerKind(null)).toBeNull()
    expect(containerKind(undefined)).toBeNull()
    expect(containerKind({ [LABEL_KIND_KEY]: 'legacy' })).toBeNull()
    expect(containerKind({ [LABEL_KIND_KEY]: 'anything-else' })).toBeNull()
  })

  it('kind 之外的标签不影响识别；session/owner 标签 schema 与 constants 同源', () => {
    expect(containerKind({ [LABEL_SESSION_KEY]: 's1', [LABEL_OWNER_KEY]: 'u1' })).toBeNull()
    expect(containerKind({ [LABEL_KIND_KEY]: KIND_WIKI, [LABEL_OWNER_KEY]: 'u1' })).toBe('wiki')
    expect(containerKind({ [LABEL_KIND_KEY]: KIND_SANDBOX, [LABEL_SESSION_KEY]: 's1' })).toBe('sandbox')
  })
})
