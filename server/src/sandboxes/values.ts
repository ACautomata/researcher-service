// 沙箱域常量（#776 · #747 E 节沙箱列 + story 58/59/61 后端面）。
// 单一来源：容器/网络命名前缀、资源 limit 初值、闲置 stop 阈值、/lab 树根、保活命令。
// 供纯逻辑（lifecycle.ts）、docker 适配层（dockerRuntime.ts）、files 域 lab 读面、
// 测试复用。资源数字为规格初值（#747 开放点 8：待实测校准；生命周期服务构造可整体覆盖——
// smoke 用小内存值验证 OOM 路径）。

// 沙箱 docker 容器名：researcher-sandbox-<sessionId>（#747 E 节路径命名）。
export const SANDBOX_CONTAINER_PREFIX = 'researcher-sandbox-'

// 每沙箱独立 bridge 网络：researcher-sandbox-net-<sessionId>——容器间零互通（默认 bridge 的
// ICC 会放行同网段容器互访，独立网络使每沙箱网内只有自己；出网经 NAT 放行，V1 + 审计）。
export const SANDBOX_NETWORK_PREFIX = 'researcher-sandbox-net-'

// 沙箱内 agent 可写树根（可写层 /lab；#747 E 节「只读根 + /tmp tmpfs + 可写层 /lab；无具名卷」）。
export const SANDBOX_LAB_ROOT = '/lab'

// 闲置自动 stop 阈值（story 58：闲置 30 分钟自动 stop，文件保留——stop 不动可写层，remove 才销毁）。
export const SANDBOX_IDLE_STOP_MS = 30 * 60 * 1000

// 闲置 sweeper 轮询间隔（生产装配缺省；远小于阈值即可，间隔只影响 stop 时延精度）。
export const SANDBOX_SWEEP_INTERVAL_MS = 60 * 1000

// 沙箱进程身份：非 root（#747 E 节安全列）。数值 uid:gid——镜像无需 passwd 条目；/lab 由创建
// 流程 putArchive 预置 1000 属主（daemon 应用 tar 头 uid/gid），agent 进程可写自己的树。
export const SANDBOX_USER = '1000:1000'

// 保活命令（PID 1）：tail -f /dev/null——busybox 与 GNU coreutils 通吃的最小心跳进程。
// 刻意最小化 PID 1 内存占用：cgroup OOM 时内核按 badness 选杀对象，贪内存的 exec 进程先死、
// PID 1 存活 →「OOM 杀进程不杀容器、错误回流 agent 自纠」（story 59）。
export const SANDBOX_KEEPALIVE_CMD: readonly string[] = ['tail', '-f', '/dev/null']

// 资源 limit 初值（#747 E 节：Memory 4GB / 4 核 / PidsLimit 512；待实测校准）。
export interface SandboxLimits {
  /** cgroup 内存上限（字节） */
  readonly memoryBytes: number
  /** CPU 配额（nano CPUs：4 核 = 4e9） */
  readonly nanoCpus: number
  /** 进程数上限 */
  readonly pidsLimit: number
}

export const SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 4 * 1024 * 1024 * 1024,
  nanoCpus: 4_000_000_000,
  pidsLimit: 512,
}

// host 核数钳制：daemon 拒收 NanoCpus > NCPU×1e9 的 create（400 "Range of CPUs is from 0.01
// to X.00..."，沙箱直接建不起来）。limit 是上限而非预留——低核部署机（2 核办公机/CI）上
// 规格初值必须让位。纯函数：dockerRuntime 创建路径套用，hostNanoCpus 由调用方查 info() 供给。
export function clampSandboxLimits(limits: SandboxLimits, hostNanoCpus: number): SandboxLimits {
  return limits.nanoCpus <= hostNanoCpus ? limits : { ...limits, nanoCpus: hostNanoCpus }
}
