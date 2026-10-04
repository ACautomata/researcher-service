// kind 三值分派单测（#784 AC · S2 延伸）：create/health/delete 三操作按 kind label 分派到
// 正确支路。纯函数直锁（零 IO），覆盖：三 kind 显式标签识别 / legacy 识别（无 kind 标签的
// fleet 容器 + 显式 kind=legacy + 外来无标签容器）/ 分派路由三操作逐一锁路径。

import { describe, it, expect } from 'vitest'
import { containerKind, dispatchByKind, type KindRoutes } from '../src/containers/kind'
import { KIND_LEGACY, KIND_SANDBOX, KIND_WIKI, LABEL_KIND_KEY } from '../src/containers/constants'

// 三支路操作表 stub：create/health/delete 各记录自己的支路名——断言「哪个支路被路由到」
// 即 AC 的「create/health/delete 路径正确」。
function recordingRoutes(log: string[]): KindRoutes<Record<string, () => string>> {
  const make = (branch: string) => ({
    create: () => {
      log.push(`${branch}.create`)
      return `${branch}.create`
    },
    health: () => {
      log.push(`${branch}.health`)
      return `${branch}.health`
    },
    delete: () => {
      log.push(`${branch}.delete`)
      return `${branch}.delete`
    },
  })
  return { wiki: make('wiki'), sandbox: make('sandbox'), legacy: make('legacy') }
}

describe('containerKind 识别（#747 B 节三值）', () => {
  it('researcher.kind=wiki|sandbox → 新世界支路', () => {
    expect(containerKind({ [LABEL_KIND_KEY]: KIND_WIKI })).toBe('wiki')
    expect(containerKind({ [LABEL_KIND_KEY]: KIND_SANDBOX })).toBe('sandbox')
  })

  it('legacy 识别：显式 kind=legacy / fleet 无 kind 标签 / 外来无标签容器 → legacy 支路', () => {
    expect(containerKind({ [LABEL_KIND_KEY]: KIND_LEGACY })).toBe('legacy')
    // fleet 容器：app=openclaw-fleet + instance/port 标签，无 researcher.kind
    expect(containerKind({ app: 'openclaw-fleet', 'openclaw.instance': 'demo1', 'openclaw.port': '19000' })).toBe('legacy')
    expect(containerKind({})).toBe('legacy')
    expect(containerKind(null)).toBe('legacy')
    expect(containerKind(undefined)).toBe('legacy')
  })

  it('未知 kind 值保守归 legacy（分派层永不因标签值漂移而抛错）', () => {
    expect(containerKind({ [LABEL_KIND_KEY]: 'future-kind' })).toBe('legacy')
  })
})

describe('dispatchByKind：create/health/delete 路径正确（#784 AC）', () => {
  const CASES: { kind: 'legacy' | 'wiki' | 'sandbox'; op: 'create' | 'health' | 'delete' }[] = [
    { kind: 'wiki', op: 'create' },
    { kind: 'wiki', op: 'health' },
    { kind: 'wiki', op: 'delete' },
    { kind: 'sandbox', op: 'create' },
    { kind: 'sandbox', op: 'health' },
    { kind: 'sandbox', op: 'delete' },
    { kind: 'legacy', op: 'create' },
    { kind: 'legacy', op: 'health' },
    { kind: 'legacy', op: 'delete' },
  ]

  for (const { kind, op } of CASES) {
    it(`${kind} 容器的 ${op} 分派到 ${kind} 支路`, () => {
      const log: string[] = []
      const routes = recordingRoutes(log)
      const branch = dispatchByKind(kind, routes)
      expect(branch[op]()).toBe(`${kind}.${op}`)
      expect(log).toEqual([`${kind}.${op}`])
    })
  }

  it('标签 → 支路全链：containerKind + dispatchByKind 组合（wiki REST ensure / T0 清理的调用形态）', () => {
    const log: string[] = []
    const routes = recordingRoutes(log)
    // wiki 容器标签（researcher.kind=wiki + owner）走 wiki 支路
    dispatchByKind(containerKind({ [LABEL_KIND_KEY]: KIND_WIKI }), routes).health()
    // 沙箱标签走 sandbox 支路
    dispatchByKind(containerKind({ [LABEL_KIND_KEY]: KIND_SANDBOX }), routes).delete()
    // 无标签 fleet 容器走 legacy 支路（T0 删除路径识别标记的消费形态）
    dispatchByKind(containerKind({ app: 'openclaw-fleet' }), routes).delete()
    expect(log).toEqual(['wiki.health', 'sandbox.delete', 'legacy.delete'])
  })
})
