// wiki 容器域常量（#784 · #747 E 节 wiki 列）。
// 单一来源：容器名前缀、/wiki 树根、进程身份、保活命令、资源 limit 初值。
// 供纯逻辑（lifecycle.ts）、docker 适配层（dockerRuntime.ts）、wiki 域 REST（dockerFs 树根）、
// 测试复用。资源数字为规格初值（#747 开放点 8：待实测校准；生命周期服务构造可整体覆盖——
// smoke 用小内存值验证）。wiki 容器与沙箱的关键差异：**永久**（无闲置回收面）+ **零出网**
//（NetworkMode none，无独立网络对象 → 无网络创建/清理原语）+ **无 /tmp tmpfs 要求**。

// wiki 容器 docker 容器名：researcher-wiki-<userId>（#747 E 节路径命名；runner/assembly
// 原占位实现同命名——#784 起经本函数单一来源派生）。
export const WIKI_CONTAINER_PREFIX = 'researcher-wiki-'

// 每用户 wiki 树根（可写层 /wiki；#747 E 节「只读根 + 可写层 /wiki；无具名卷」）。
export const WIKI_ROOT = '/wiki'

// wiki 容器进程身份：非 root（#747 E 节安全列）。数值 uid:gid——镜像无需 passwd 条目；
// /wiki 由创建流程 putArchive 预置 1000 属主（daemon 应用 tar 头 uid/gid），agent 写工具
//（runner backend）与 wiki REST 写面才能落自己的树。
export const WIKI_USER = '1000:1000'

// 保活命令（PID 1）：tail -f /dev/null——busybox applet，与沙箱同款最小心跳进程
//（「活性 = docker inspect Running」的前提：容器必须有一个存活主进程）。
export const WIKI_KEEPALIVE_CMD: readonly string[] = ['tail', '-f', '/dev/null']

// 资源 limit（#747 E 节 wiki 列：Memory 256MB / PidsLimit 128；无 CPU 配额——规格未列）。
export interface WikiLimits {
  /** cgroup 内存上限（字节） */
  readonly memoryBytes: number
  /** 进程数上限 */
  readonly pidsLimit: number
}

export const WIKI_LIMITS: WikiLimits = {
  memoryBytes: 256 * 1024 * 1024,
  pidsLimit: 128,
}
