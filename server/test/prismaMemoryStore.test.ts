// #774 [#747·04] PrismaMemoryStore —— BaseStore V1 五方法 × 真 SQLite（S3 纯逻辑单测）。
//
// 验收依据（逐条对齐 #774 Acceptance criteria）：
//   - 「BaseStore V1 命名空间隔离行为有测试」
//   - 「与 LangGraph SDK 的接口契约核对通过（版本锁定集内）」——BaseStore 经
//     @langchain/langgraph-checkpoint ~1.1.5 导出（对齐 @langchain/langgraph ~1.4.18 依赖集）
//   - #727/#771：memory_items 表（namespace per-user 前缀派生归属，无 user FK 不级联）；
//     V1 无 embedding、前缀检索；#774 补 createdAt 列（Item 契约必填）
//   - 行为参照：同包 InMemoryStore（官方 store 语义对照）——层级前缀检索、
//     filter 比较（$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin）、listNamespaces 排序分页
//
// 接缝：S3 纯逻辑单测——真 SQLite 临时库 + PrismaClient 注入，零 mock。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BaseStore, InvalidNamespaceError } from '@langchain/langgraph-checkpoint'
import type { Operation } from '@langchain/langgraph-checkpoint'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { runDbScript } from './runDbScript'
import { PrismaMemoryStore } from '../src/runner/persistence/prismaMemoryStore'

describe('PrismaMemoryStore（#774 · S3 · 真 SQLite）', () => {
  let dbDir: string
  let prisma: PrismaClient
  let store: PrismaMemoryStore

  beforeAll(() => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'memory-store-test-'))
    const dbPath = path.join(dbDir, 'test.db')
    runDbScript('apply-schema.mjs', dbPath)
    prisma = createPrismaClient(`file:${dbPath}`)
    store = new PrismaMemoryStore(prisma)
  })

  beforeEach(async () => {
    await prisma.memoryItem.deleteMany({})
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('契约：instanceof BaseStore（compile({ store }) 零侵入接入面）', () => {
    expect(store).toBeInstanceOf(BaseStore)
  })

  it('put/get round-trip：value 对象、Item 三元时间戳（createdAt 首写恒定、updatedAt 刷新）', async () => {
    const value = { theme: 'dark', nested: { list: [1, 2, 3] }, note: '跨会话记忆' }
    await store.put(['user-u1'], 'prefs', value)

    const item = await store.get(['user-u1'], 'prefs')
    expect(item).not.toBeNull()
    expect(item!.namespace).toEqual(['user-u1'])
    expect(item!.key).toBe('prefs')
    expect(item!.value).toEqual(value)
    expect(item!.createdAt).toBeInstanceOf(Date)
    expect(item!.updatedAt).toBeInstanceOf(Date)

    // 覆盖写：value/updatedAt 刷新，createdAt 保留（记忆成形时刻不漂移）
    await new Promise((r) => setTimeout(r, 5)) // 保证 updatedAt 时钟前进
    await store.put(['user-u1'], 'prefs', { theme: 'light' })
    const updated = await store.get(['user-u1'], 'prefs')
    expect(updated!.value).toEqual({ theme: 'light' })
    expect(updated!.createdAt.getTime()).toBe(item!.createdAt.getTime())
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(item!.updatedAt.getTime())

    // 未命中 → null（官方 getOperation 语义）
    expect(await store.get(['user-u1'], 'missing')).toBeNull()
    expect(await store.get(['user-other'], 'prefs')).toBeNull()
  })

  it('命名空间隔离：per-user 前缀互不越权（#774 核心验收）', async () => {
    await store.put(['user-a'], 'profile', { name: '甲' })
    await store.put(['user-b'], 'profile', { name: '乙' })
    await store.put(['user-a', 'projects'], 'p1', { title: 'A 的项目' })

    expect((await store.get(['user-a'], 'profile'))!.value).toEqual({ name: '甲' })
    expect((await store.get(['user-b'], 'profile'))!.value).toEqual({ name: '乙' })
    expect(await store.get(['user-c'], 'profile')).toBeNull()

    // 层级边界：join(":") 编码下 ["user-a","projects"] 不泄漏给 ["user-a"] 前缀检索，
    // 也不与字面量 "user-a:projects" 命名空间混同
    const aRoot = await store.search(['user-a'])
    expect(aRoot.map((i) => i.key).sort()).toEqual(['p1', 'profile'])
    const aExact = await store.search(['user-a', 'projects'])
    expect(aExact.map((i) => i.key)).toEqual(['p1'])
    expect(await store.search(['user-a-projects'])).toEqual([])
  })

  it('search：limit/offset 分页 + filter 比较（$eq/$gt/$in 组合）', async () => {
    await store.put(['docs'], 'd1', { title: 'Alpha', score: 3 })
    await store.put(['docs'], 'd2', { title: 'Beta', score: 5 })
    await store.put(['docs'], 'd3', { title: 'Gamma', score: 7 })
    await store.put(['docs', 'archive'], 'd4', { title: 'Old', score: 9 })
    await store.put(['other'], 'd5', { title: 'Outside', score: 9 })

    // 默认 limit=10、前缀含子命名空间
    expect((await store.search(['docs'])).map((i) => i.key).sort()).toEqual(['d1', 'd2', 'd3', 'd4'])

    const page1 = await store.search(['docs'], { limit: 2, offset: 0 })
    const page2 = await store.search(['docs'], { limit: 2, offset: 2 })
    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(page1.map((i) => i.key)).not.toEqual(page2.map((i) => i.key))

    const highScore = await store.search(['docs'], { filter: { score: { $gte: 5 } } })
    expect(highScore.map((i) => i.key).sort()).toEqual(['d2', 'd3', 'd4'])
    const named = await store.search(['docs'], { filter: { title: { $in: ['Alpha', 'Gamma'] } } })
    expect(named.map((i) => i.key).sort()).toEqual(['d1', 'd3'])
    const combined = await store.search(['docs'], { filter: { score: 3 } })
    expect(combined.map((i) => i.key)).toEqual(['d1'])
  })

  it('search：V1 无 embedding——query 参数显式拒绝（防静默降级）', async () => {
    await store.put(['docs'], 'd1', { title: 'Alpha' })
    await expect(store.search(['docs'], { query: 'anything' })).rejects.toThrow(/query/)
  })

  it('delete：按 namespace+key 精确删除；batch put(value:null) 同语义', async () => {
    await store.put(['user-a'], 'k1', { v: 1 })
    await store.put(['user-a'], 'k2', { v: 2 })
    await store.delete(['user-a'], 'k1')
    expect(await store.get(['user-a'], 'k1')).toBeNull()
    expect(await store.get(['user-a'], 'k2')).not.toBeNull()

    // batch 删除路径（官方 put-null 语义）
    await store.batch([{ namespace: ['user-a'], key: 'k2', value: null }])
    expect(await store.get(['user-a'], 'k2')).toBeNull()

    // 删不存在 → 不抛（官方 putOperation 语义）
    await expect(store.delete(['user-a'], 'nope')).resolves.toBeUndefined()
  })

  it('listNamespaces：去重 + 字典序 + prefix/suffix/maxDepth 过滤 + 分页', async () => {
    await store.put(['user-a'], 'k', { v: 1 })
    await store.put(['user-a', 'projects'], 'k', { v: 1 })
    await store.put(['user-b', 'projects'], 'k', { v: 1 })
    await store.put(['user-b', 'archive'], 'k', { v: 1 })

    const all = await store.listNamespaces()
    expect(all).toEqual([
      ['user-a'],
      ['user-a', 'projects'],
      ['user-b', 'archive'],
      ['user-b', 'projects'],
    ])

    const prefixed = await store.listNamespaces({ prefix: ['user-b'] })
    expect(prefixed).toEqual([
      ['user-b', 'archive'],
      ['user-b', 'projects'],
    ])

    const suffixed = await store.listNamespaces({ suffix: ['projects'] })
    expect(suffixed).toEqual([
      ['user-a', 'projects'],
      ['user-b', 'projects'],
    ])

    const shallow = await store.listNamespaces({ maxDepth: 1 })
    expect(shallow).toEqual([['user-a'], ['user-b']])

    const paged = await store.listNamespaces({ limit: 2, offset: 1 })
    expect(paged).toEqual([
      ['user-a', 'projects'],
      ['user-b', 'archive'],
    ])
  })

  it('listNamespaces：空表 → 空数组；put 后前缀即时可见', async () => {
    expect(await store.listNamespaces()).toEqual([])
    await store.put(['fresh', 'ns'], 'k', { v: 1 })
    expect(await store.listNamespaces({ prefix: ['fresh'] })).toEqual([['fresh', 'ns']])
  })

  it('namespace 校验：空 / 含 "." / 根 "langgraph" 抛 InvalidNamespaceError（BaseStore 契约）', async () => {
    await expect(store.put([], 'k', { v: 1 })).rejects.toBeInstanceOf(InvalidNamespaceError)
    await expect(store.put(['a.b'], 'k', { v: 1 })).rejects.toBeInstanceOf(InvalidNamespaceError)
    await expect(store.put(['langgraph'], 'k', { v: 1 })).rejects.toBeInstanceOf(InvalidNamespaceError)
    // 合法层级照常写入
    await store.put(['langgraph-x', 'ns'], 'k', { v: 1 })
    expect(await store.get(['langgraph-x', 'ns'], 'k')).not.toBeNull()
  })

  it('batch：混合 operations 一次提交，结果按序对应（默认实现经五方法分派）', async () => {
    await store.put(['batch'], 'seed', { n: 0 })
    const results = await store.batch([
      { namespace: ['batch'], key: 'seed' }, // get
      { namespacePrefix: ['batch'] }, // search
      { namespace: ['batch'], key: 'added', value: { n: 1 } }, // put
      { namespace: ['batch'], key: 'seed', value: null }, // delete
      { matchConditions: [{ matchType: 'prefix', path: ['batch'] }], limit: 10, offset: 0 }, // listNamespaces
    ])
    expect((results[0] as { key: string }).key).toBe('seed') // get 命中
    expect((results[1] as unknown[]).length).toBeGreaterThan(0) // search
    expect(results[2]).toBeUndefined() // put → void
    expect(results[3]).toBeUndefined() // delete → void
    expect(results[4]).toEqual([['batch']]) // listNamespaces
    // batch 生效
    expect(await store.get(['batch'], 'seed')).toBeNull()
    expect(await store.get(['batch'], 'added')).not.toBeNull()
  })

  it('batch：批前快照语义——批内读看不到同批写，同 key 后者覆盖（镜像官方 InMemoryStore.batch）', async () => {
    await store.put(['snap'], 'k', { n: 1 })
    const results = await store.batch([
      { namespace: ['snap'], key: 'k' }, // get：批前快照 → 旧值
      { namespace: ['snap'], key: 'k', value: { n: 2 } }, // put 延后执行
      { namespace: ['snap'], key: 'k', value: { n: 3 } }, // 同 key 后者覆盖前者
      { namespacePrefix: ['snap'] }, // search：批前快照 → 旧值
    ])
    expect((results[0] as { value: { n: number } }).value.n).toBe(1)
    expect((results[3] as Array<{ value: { n: number } }>)[0].value.n).toBe(1)
    // 批落库后：两次 put 顺序执行，最终值为后者
    expect((await store.get(['snap'], 'k'))!.value.n).toBe(3)
  })

  it('search：空前缀 fail-closed 恒空（官方返全量；per-user 隔离方向有意收紧）', async () => {
    await store.put(['user-a'], 'k1', { v: 1 })
    expect(await store.search([])).toEqual([])
  })

  it('batch：listNamespaces 手写 op 多 matchConditions 全量 every + 未知 matchType 抛错（镜像官方）', async () => {
    await store.put(['user-a', 'projects'], 'k', { v: 1 })
    await store.put(['user-b', 'projects'], 'k', { v: 1 })
    await store.put(['user-a', 'archive'], 'k', { v: 1 })

    // 两 prefix 同批：every 语义下不可同时满足 → 恒空（第 1 轮「只取首个条件」缺陷回归）。
    // 官方 ListNamespacesOperation 类型 limit/offset 必填（实现仍 ?? 防御 JS 调用方）。
    const twoPrefix = await store.batch([
      {
        matchConditions: [
          { matchType: 'prefix', path: ['user-a'] },
          { matchType: 'prefix', path: ['user-b'] },
        ],
        limit: 100,
        offset: 0,
      },
    ])
    expect(twoPrefix[0]).toEqual([])

    // prefix + suffix 组合：交集命中
    const prefixSuffix = await store.batch([
      {
        matchConditions: [
          { matchType: 'prefix', path: ['user-a'] },
          { matchType: 'suffix', path: ['projects'] },
        ],
        limit: 100,
        offset: 0,
      },
    ])
    expect(prefixSuffix[0]).toEqual([['user-a', 'projects']])

    // 未知 matchType：官方 doesMatch 无条件抛错。path 长 3 > fixture ns 深 2——若长度
    // 检查前置（第 3 轮修复前形态）会返 false 短路而不抛，用例真判别回归
    const bogusOp = {
      matchConditions: [{ matchType: 'bogus', path: ['x', 'y', 'z'] }],
    } as unknown as Operation
    await expect(store.batch([bogusOp])).rejects.toThrow('Unsupported match type: bogus')
  })

  it('batch：listNamespaces op maxDepth 截断后重排（官方 sort 在截断后；截断可改变相对序）', async () => {
    // 全量字典序：encode("a-b")="a-b" < encode(["a","z"])="a:z"（'-' 45 < ':' 58）
    await store.put(['a-b'], 'k', { v: 1 })
    await store.put(['a', 'z'], 'k', { v: 1 })
    const results = await store.batch([{ maxDepth: 1, limit: 100, offset: 0 }])
    // 截断到 depth 1 后排序：encode(["a"])="a" 是 "a-b" 前缀，短者小 → ["a"] 在前
    expect(results[0]).toEqual([
      ['a'],
      ['a-b'],
    ])
    // 对照五方法路径（不走 batch op）同语义
    expect(await store.listNamespaces({ maxDepth: 1 })).toEqual([
      ['a'],
      ['a-b'],
    ])
  })

  it('search：空前缀对 ":" 开头 label 的退化 namespace 仍恒空（fail-closed 显式 guard）', async () => {
    // validateNamespace 镜像官方不禁 ":"——[':colon'] 编码为 ":colon"，startsWith(':') 会命中
    await store.put([':colon'], 'k', { v: 1 })
    expect(await store.search([])).toEqual([])
  })
})
