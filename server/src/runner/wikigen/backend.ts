// wiki-update 组合 backend（#790 · #747 G 节 wiki 三通道②「工具同指副本」的装配点）。
//
// CompositeBackend(deepagents 公开导出)：default = DockerArchiveBackend（双根 /wiki/+/lab/ 的
// 容器面），route '/wiki/' = FilesystemBackend（rootDir = 镜像 openwiki 子树，virtualMode）。
// 效果：/lab/ 照旧落沙箱容器；/wiki/** 落控制面落地副本 = 「各工具同指副本」——teammate 的
// 原生 fs 写工具在副本上执行，finish（生命周期工具）才推回容器。
//
// 锁面：组合 backend 经 withWriteLocks **整体**包裹——/lab 写不丢 #785 写锁（互斥域 = 沙箱
// 所属 parent session，与现状同款组合序）；/wiki/ 镜像写也入锁（同 thread 串行无竞争，无害）。
// 路由面（approval 路径白名单 wiki|lab|tmp 前缀）天然覆盖镜像写——漏斗语义不变。
//
// routePath（backend/paths.ts）仍按 (wiki, lab) 双根解析——锁 key 与 journal path 与容器面
// 同约定（'wiki/<rel>' / 'lab/<rel>'），覆盖审计/锁观测面零特判。

import { CompositeBackend, FilesystemBackend, type SandboxBackendProtocolV2 as DeepAgentsBackendV2 } from 'deepagents'
import { join } from 'node:path'
import type { SandboxBackendProtocolV2 } from '../backend/protocol'
import type { BackendTargets } from '../backend/paths'
import { withWriteLocks, type WriteLockContext } from '../writelock/lockedBackend'
import type { WriteLockRegistry } from '../writelock/registry'
import type { OverwriteAuditor } from '../writelock/overwriteAudit'
import { WIKI_OPENWIKI_DIR } from './values'

export interface WikiUpdateBackendParams {
  /** 默认后端（RunService = DockerArchiveBackend{wiki,lab}；测试注 fake 观察锁面） */
  readonly defaultBackend: SandboxBackendProtocolV2
  /** '/wiki/' 路由后端（RunService = FilesystemBackend(rootDir=镜像 openwiki 子树)） */
  readonly wikiRouteBackend: FilesystemBackend
  /** 双根路由目标（锁 key 解析面） */
  readonly targets: BackendTargets
  readonly locks: WriteLockRegistry
  readonly ctx: () => WriteLockContext
  readonly auditor?: OverwriteAuditor
}

// 供 RunService 构造 wiki 路由后端（镜像 openwiki 子树 = /wiki/ 的挂载点）。
export function wikiMirrorRouteRootDir(mirrorRoot: string): string {
  return join(mirrorRoot, WIKI_OPENWIKI_DIR)
}

// 组合 + 整体锁包裹（RunService 与测试共用单一装配点）。
export function buildWikiUpdateBackend(params: WikiUpdateBackendParams): SandboxBackendProtocolV2 {
  const composite = new CompositeBackend(
    params.defaultBackend as DeepAgentsBackendV2,
    // FilesystemBackend 实现 deepagents BackendProtocolV2 但无 execute/id（CompositeBackend
    // routes 收 AnyBackendProtocol）——cast 经 unknown 对齐构造入参，运行时由 CompositeBackend 委派。
    { '/wiki/': params.wikiRouteBackend as unknown as DeepAgentsBackendV2 },
  )
  return withWriteLocks(composite, params.targets, params.locks, params.ctx, params.auditor)
}
