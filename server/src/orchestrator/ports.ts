import { randomBytes } from 'node:crypto'

// 编排域纯逻辑（#334 M2 · #313 并发模型 · #312 隔离）。
// 零 IO：端口池 / 互斥租约 / bind 冲突识别 / token 生成 —— 独立于 Prisma、docker、Redis，
// 便于接缝 5（编排器 Port）注入假 docker + 内存假 BullMQ 直测。

// 容器名 DNS-label（spec §4 零信任 / #310）：小写字母开头，3–30 位，仅 [a-z0-9-]。
// 禁 / .. 空格 大写（防 instances/<name>/ 目录穿越与注入）。
export const NAME_REGEX = /^[a-z][a-z0-9-]{2,29}$/

// 容器内 gateway 固定端口（Docker 网络命名空间隔离；仅宿主侧分配映射端口）
export const GATEWAY_INTERNAL_PORT = 18789

// 容器名前缀（与原 compose 栈 openclaw-gateway 隔离，spec §5.3）
export const CONTAINER_PREFIX = 'openclaw-gw-'
// 容器内固定 bind-mount 路径（spec §5.2/§5.3）
export const HOME_BIND = '/home/node/.openclaw'
export const CONFIG_BIND = '/home/node/.openclaw/openclaw.json'
// gateway 网络绑定模式
export const GATEWAY_BIND = 'lan'
// env 占位：真 token 绝不落盘 JSON，保留 ${GATEWAY_TOKEN} 由 gateway 进程运行时插值
export const GATEWAY_TOKEN_PLACEHOLDER = '${GATEWAY_TOKEN}'
// Docker label 键（对账 / 端口还原）
export const LABEL_APP_KEY = 'app'
export const LABEL_APP_VALUE = 'openclaw-fleet'
export const LABEL_INSTANCE_KEY = 'openclaw.instance'
export const LABEL_PORT_KEY = 'openclaw.port'

export function containerName(name: string): string {
  return `${CONTAINER_PREFIX}${name}`
}

// 端口池耗尽（预期容量条件 → 90004）
export class PortPoolExhausted extends Error {
  constructor(start: number, end: number) {
    super(`端口池 ${start}-${end} 已耗尽`)
    this.name = 'PortPoolExhausted'
  }
}

// 端口分配（#313 端口入队前分配）：池 [start,end] 闭区间取最小空闲，跳过 reserved（18789）
// 与已用集。纯函数无 IO —— 调用方传入「已用端口集合」。
export class PoolAllocator {
  constructor(
    private readonly start: number,
    private readonly end: number,
    private readonly reserved: ReadonlySet<number> = new Set([GATEWAY_INTERNAL_PORT]),
  ) {
    if (end < start) throw new Error('端口池 end 不得小于 start')
  }

  /** 池候选数 = bind 冲突重试预算（#295 codex P2：重试直至池内空闲，非 MAX_PORT_RETRIES） */
  get poolSize(): number {
    return this.end - this.start + 1
  }

  nextFree(used: ReadonlySet<number>): number {
    for (let p = this.start; p <= this.end; p++) {
      if (this.reserved.has(p) || used.has(p)) continue
      return p
    }
    throw new PortPoolExhausted(this.start, this.end)
  }
}

// 识别 docker 发布端口时的宿主 bind 冲突（平移旧 _is_bind_conflict，codex R2 P2）。
// 归一化匹配两种真实措辞：OS 层 docker-proxy "bind: address already in use" 与
// libnetwork portallocator "Bind for 0.0.0.0:19000 failed: port is already allocated"。
export function isBindConflict(exc: unknown): boolean {
  const message = exc instanceof Error ? exc.message : String(exc)
  return message.includes('address already in use') || message.includes('already allocated')
}

// 进程内 Map<name, 租约> 互斥（#313 / #334：双创建/双删除护栏，锁不依赖 Redis）。
// 非阻塞 tryAcquire —— 已被持有（并发/在飞 create）→ 快速失败（撞名 20041）；
// release 幂等。崩溃时租约随进程消失（进程内锁天然无跨进程约束；跨进程护栏由
// DB 唯一约束 + BullMQ jobId 串行兜底）。
export class ContainerNameLeases {
  private readonly held = new Set<string>()

  tryAcquire(name: string): boolean {
    if (this.held.has(name)) return false
    this.held.add(name)
    return true
  }

  release(name: string): void {
    this.held.delete(name)
  }

  isHeld(name: string): boolean {
    return this.held.has(name)
  }
}

// GATEWAY_TOKEN（spec §5.2）：secrets 32 字节 = 256 bit，token_urlsafe
export function generateGatewayToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
