// #774 [#747·04] PrismaMemoryStore —— BaseStore（V1：无 embedding、前缀检索）落 memory_items。
//
// 契约来源：@langchain/langgraph-checkpoint ~1.1.5 的 BaseStore（对齐 @langchain/langgraph
// ~1.4.18 依赖集）；行为对照同包 InMemoryStore（语义锁定先例同 backend/protocol.ts）。
//
// 关键约束（#727/#771）：
//   - memory_items 归属经 namespace 前缀派生（per-user，如 ["user-<ownerId>"]），刻意不建
//     user FK（memory 跟 user 不级联）；namespace 数组 join(":") 编码进单列（label 校验禁
//     "."，":" 天然无歧义——层级前缀检索 = 精确 or startsWith(joined + ":")）。
//   - V1 无 embedding：search 的 query 参数显式拒绝（防静默降级）；filter 内存比较
//     （$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin，语义照抄官方 store/utils）。
//   - 五方法（get/put/delete/search/listNamespaces）直落 Prisma 为唯一落点；batch 语义镜像
//     官方 InMemoryStore.batch（批前快照：读先写后，同 key 后者胜），结果按原 index 对应。
//   - createdAt 首写恒定、updatedAt 覆盖刷新（#774 补列——Item 契约必填）。

import { BaseStore, InvalidNamespaceError } from '@langchain/langgraph-checkpoint'
import type {
  Item,
  ListNamespacesOperation,
  Operation,
  OperationResults,
  SearchItem,
} from '@langchain/langgraph-checkpoint'
import type { PrismaClient } from '../../generated/prisma/client'

const NS_SEPARATOR = ':'

/** namespace 数组 ⇄ 单列编码（join(":")）——label 校验禁 "."，":" 分隔无歧义 */
function encodeNamespace(namespace: string[]): string {
  return namespace.join(NS_SEPARATOR)
}

function decodeNamespace(encoded: string): string[] {
  return encoded.split(NS_SEPARATOR)
}

// 校验规则对齐官方 validateNamespace（store/base.ts；官方未导出该函数，规则逐条镜像，
// InvalidNamespaceError 从包导入——消息文案保持行为快照一致）
function assertValidNamespace(namespace: string[]): void {
  if (namespace.length === 0) throw new InvalidNamespaceError('Namespace cannot be empty.')
  for (const label of namespace) {
    if (typeof label !== 'string') {
      throw new InvalidNamespaceError(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels must be strings, but got ${typeof label}.`,
      )
    }
    if (label.includes('.')) {
      throw new InvalidNamespaceError(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels cannot contain periods ('.').`,
      )
    }
    if (label === '') {
      throw new InvalidNamespaceError(
        `Namespace labels cannot be empty strings. Got ${label} in ${namespace}`,
      )
    }
  }
  if (namespace[0] === 'langgraph') {
    throw new InvalidNamespaceError(
      `Root label for namespace cannot be "langgraph". Got: ${namespace}`,
    )
  }
}

// filter 比较语义照抄官方 store/utils.compareValues（操作符全集 + 直接相等回退）
function isFilterOperators(obj: unknown): obj is Record<string, unknown> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    Object.keys(obj).every((k) =>
      ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin'].includes(k),
    )
  )
}

function compareValues(itemValue: unknown, filterValue: unknown): boolean {
  if (isFilterOperators(filterValue)) {
    return Object.keys(filterValue)
      .filter((k) => k.startsWith('$'))
      .every((op) => {
        const value = filterValue[op]
        switch (op) {
          case '$eq':
            return itemValue === value
          case '$ne':
            return itemValue !== value
          case '$gt':
            return Number(itemValue) > Number(value)
          case '$gte':
            return Number(itemValue) >= Number(value)
          case '$lt':
            return Number(itemValue) < Number(value)
          case '$lte':
            return Number(itemValue) <= Number(value)
          case '$in':
            return Array.isArray(value) ? value.includes(itemValue) : false
          case '$nin':
            return Array.isArray(value) ? !value.includes(itemValue) : true
          default:
            return false
        }
      })
  }
  return itemValue === filterValue
}

// matchConditions 通配匹配（语义照抄官方 doesMatch：path 元素 "*" 通配，按位比较）
function matchesPath(path: string[], key: string[]): boolean {
  if (path.length > key.length) return false
  return path.every((p, i) => p === '*' || key[i] === p)
}

interface ListNamespacesParams {
  prefix?: string[]
  suffix?: string[]
  maxDepth?: number
  limit?: number
  offset?: number
}

export class PrismaMemoryStore extends BaseStore {
  constructor(private readonly prisma: PrismaClient) {
    super()
  }

  async get(namespace: string[], key: string): Promise<Item | null> {
    const row = await this.prisma.memoryItem.findUnique({
      where: { namespace_key: { namespace: encodeNamespace(namespace), key } },
    })
    return row ? this.toItem(row) : null
  }

  async put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _index?: false | string[],
  ): Promise<void> {
    assertValidNamespace(namespace)
    const encoded = encodeNamespace(namespace)
    const existing = await this.prisma.memoryItem.findUnique({
      where: { namespace_key: { namespace: encoded, key } },
    })
    if (existing) {
      // 覆盖写：createdAt 恒定（记忆成形时刻），updatedAt 经 @updatedAt 自动刷新
      await this.prisma.memoryItem.update({
        where: { namespace_key: { namespace: encoded, key } },
        data: { valueJson: JSON.stringify(value) },
      })
    } else {
      await this.prisma.memoryItem.create({
        data: { namespace: encoded, key, valueJson: JSON.stringify(value) },
      })
    }
  }

  async delete(namespace: string[], key: string): Promise<void> {
    await this.prisma.memoryItem.deleteMany({
      where: { namespace: encodeNamespace(namespace), key },
    })
  }

  async search(
    namespacePrefix: string[],
    options?: {
      filter?: Record<string, unknown>
      limit?: number
      offset?: number
      query?: string
    },
  ): Promise<SearchItem[]> {
    if (options?.query !== undefined) {
      // V1 无 embedding（#727）：显式拒绝防静默降级——忽略 query 返回未排序结果
      // 会让调用方误以为相关性排序已生效
      throw new Error(
        'PrismaMemoryStore (BaseStore V1) does not support vector query search: memory_items has no embedding column (#727). Remove options.query or use a store with an index config.',
      )
    }
    const joined = encodeNamespace(namespacePrefix)
    const rows = await this.prisma.memoryItem.findMany({
      where: {
        OR: [{ namespace: joined }, { namespace: { startsWith: `${joined}${NS_SEPARATOR}` } }],
      },
      orderBy: [{ namespace: 'asc' }, { key: 'asc' }],
    })
    let items = rows.map((r) => this.toItem(r))
    if (options?.filter) {
      items = items.filter((item) =>
        Object.entries(options.filter!).every(([k, v]) => compareValues(item.value[k], v)),
      )
    }
    // 官方语义：默认 limit=10、offset=0；score 恒 undefined（无相关性排序）
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 10
    return items.slice(offset, offset + limit).map((item) => ({ ...item, score: undefined }))
  }

  async listNamespaces(options?: ListNamespacesParams): Promise<string[][]> {
    const rows = await this.prisma.memoryItem.findMany({
      select: { namespace: true },
      distinct: ['namespace'],
    })
    let namespaces = rows.map((r) => decodeNamespace(r.namespace))
    if (options?.prefix) {
      namespaces = namespaces.filter((ns) => matchesPath(options.prefix!, ns))
    }
    if (options?.suffix) {
      namespaces = namespaces.filter((ns) => {
        const suffix = options.suffix!
        if (suffix.length > ns.length) return false
        return matchesPath(suffix, ns.slice(ns.length - suffix.length))
      })
    }
    if (options?.maxDepth !== undefined) {
      const seen = new Set<string>()
      namespaces = namespaces
        .map((ns) => ns.slice(0, options.maxDepth))
        .filter((ns) => {
          const k = encodeNamespace(ns)
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
    }
    // 官方语义：字典序（join 后 localeCompare）
    namespaces.sort((a, b) =>
      encodeNamespace(a).localeCompare(encodeNamespace(b)),
    )
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 100
    return namespaces.slice(offset, offset + limit)
  }

  async batch<Op extends readonly Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    // 语义镜像官方 InMemoryStore.batch：读操作（get/search/listNamespaces）先按序执行——
    // 批内读一律基于批前快照（官方 search 候选亦在收集阶段锁定）；put/delete（value 分支，
    // value:null 即官方 delete 语义）延后到末尾按序执行，同 key 后者覆盖前者（官方
    // putOps Map 后者胜——直落五方法顺序执行天然后者胜，无需去重表）。结果按原 index 对应。
    const results: unknown[] = new Array(operations.length)
    const writes: {
      namespace: string[]
      key: string
      value: Record<string, unknown> | null
      index?: false | string[]
    }[] = []
    for (const [i, op] of operations.entries()) {
      if ('key' in op && 'namespace' in op && !('value' in op)) {
        results[i] = await this.get(op.namespace, op.key)
      } else if ('namespacePrefix' in op) {
        results[i] = await this.search(op.namespacePrefix, {
          filter: op.filter,
          limit: op.limit,
          offset: op.offset,
          query: op.query,
        })
      } else if ('value' in op) {
        const write: (typeof writes)[number] = {
          namespace: op.namespace,
          key: op.key,
          value: op.value,
        }
        if ('index' in op && op.index !== undefined) write.index = op.index
        writes.push(write)
      } else if ('matchConditions' in op || 'limit' in op || 'offset' in op || 'maxDepth' in op) {
        results[i] = await this.listNamespacesOperation(op as ListNamespacesOperation)
      } else {
        results[i] = undefined
      }
    }
    for (const w of writes) {
      if (w.value === null) await this.delete(w.namespace, w.key)
      else await this.put(w.namespace, w.key, w.value, w.index)
    }
    return results as OperationResults<Op>
  }

  private async listNamespacesOperation(op: ListNamespacesOperation): Promise<string[][]> {
    const prefix = op.matchConditions?.find((c) => c.matchType === 'prefix')?.path as
      | string[]
      | undefined
    const suffix = op.matchConditions?.find((c) => c.matchType === 'suffix')?.path as
      | string[]
      | undefined
    return this.listNamespaces({
      prefix,
      suffix,
      maxDepth: op.maxDepth,
      limit: op.limit,
      offset: op.offset,
    })
  }

  private toItem(row: {
    namespace: string
    key: string
    valueJson: string
    createdAt: Date
    updatedAt: Date
  }): Item {
    return {
      namespace: decodeNamespace(row.namespace),
      key: row.key,
      value: JSON.parse(row.valueJson) as Record<string, unknown>,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
