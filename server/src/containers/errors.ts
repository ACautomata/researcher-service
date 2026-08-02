// 容器/编排域异常族（平移 backend/containers/fleet/values.py + ports.py，#334）。
// 区别于旧 Django「异常→HTTP 状态码」：本服务全部经信封码（#312 所有 REST HTTP 200）。
// 每个异常携带 code 字段，路由层不再逐类 catch —— 抛出的领域异常统一由
// toEnvelopeError 转译为 EnvelopeError（code 即信封码）。

import { CODE } from '../codes'

// 容器领域异常基类：携带信封码，message 默认取码表总述（可在抛出处覆盖更具体的文案）。
export class ContainerDomainError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

// 并发同名插入被 DB 唯一约束拒绝 / 进程内租约已持有（name 全局唯一，#312 锁）→ 20041
export class InstanceExists extends ContainerDomainError {
  constructor(public readonly containerName: string) {
    super(CODE.NAME_CONFLICT, `实例名已存在: ${containerName}`)
  }
}

// 容器已停删但 home 目录清理失败（权限/属主）；保留 DB 行标 REMOVING 可重试 → 20045
export class InstanceCleanupError extends ContainerDomainError {
  constructor(
    public readonly containerName: string,
    public readonly path: string,
  ) {
    super(CODE.CLEANUP_FAILED, `容器已停删，但数据目录清理失败: ${path}`)
  }
}

// create 时目标 instance 目录已存在但 DB 无行（崩溃中断/外部残留/手动删 DB）→ 20044
export class InstanceDirExists extends ContainerDomainError {
  constructor(
    public readonly containerName: string,
    public readonly path: string,
  ) {
    super(CODE.ORPHAN_DIR, `该名称存在残留数据目录: ${path}`)
  }
}

// 端口分配重试用尽（池理论充足但持续冲突）；不可重试 → 90004
export class PortAllocationError extends ContainerDomainError {
  constructor(public readonly containerName: string) {
    super(CODE.PORT_POOL_EXHAUSTED, `端口分配重试用尽: ${containerName}`)
  }
}

// 端口池内无可用端口（平移 ports.PortPoolExhausted）→ 90004
export class PortPoolExhausted extends ContainerDomainError {
  constructor(message: string) {
    super(CODE.PORT_POOL_EXHAUSTED, message)
  }
}

// 面板级配置缺失——LLM_API_KEY 等必填字段未设置 → 90003
export class ConfigurationError extends ContainerDomainError {
  constructor(public readonly field: string) {
    super(CODE.LLM_NOT_CONFIGURED, `${field} 未配置`)
  }
}

// 删除目标仍在 provisioning（在飞 create）。#313 起 delete 改置取消标志、正常路径不再抛；
// 保留此错误仅作「在飞冲突」备用码 20043（如状态异常的行）。
export class InstanceBusy extends ContainerDomainError {
  constructor(public readonly containerName: string) {
    super(CODE.CONTAINER_BUSY, `容器正在创建中: ${containerName}`)
  }
}
