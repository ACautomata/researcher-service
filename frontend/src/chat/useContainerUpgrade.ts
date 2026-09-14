// #702 惰性升级编排（宿主侧）：打开容器时若需升级——先触发 upgrade 再轮询至终态，期间不建网关连接；
// 收敛到可连态后回调宿主自动恢复对话。决策本身全在纯函数 upgradeDecision（containers/upgradeGate），
// 本 composable 只负责副作用：定时器、请求代、单飞、busy 回退（对齐 useChatConnection 的闭包 +
// requestGen 风格，不引入新全局 store）。
import { ref, type Ref } from 'vue'
import { ApiError } from '@/api/client'
import type { InstanceDTO } from '@/api/containers'
import {
  UPGRADE_FAILED_DETAIL,
  UPGRADE_FAILED_TITLE,
  UPGRADE_RETRY_HINT,
  upgradeDecision,
} from '@/containers/upgradeGate'

// 轮询间隔对齐 ContainersView 既有节奏（3s）：太短打满 Docker/健康探测，太长状态滞后。
export const UPGRADE_POLL_INTERVAL_MS = 3000
// #312 信封 CONTAINER_BUSY（20043）：在飞升级 / upgrade_failed 终态 / 状态不允许 / bind 拓扑未开启。
export const CODE_CONTAINER_BUSY = 20043

export type UpgradePhase = 'idle' | 'upgrading' | 'failed' | 'error'

export interface ContainerUpgradeDeps {
  readonly fetch: () => Promise<InstanceDTO[]>
  readonly trigger: (name: string) => Promise<InstanceDTO>
  /** 升级态已收敛（可建连）——宿主据此自动恢复 chat 连接。 */
  readonly onConnectable: (name: string) => void
}

export interface ContainerUpgrade {
  readonly phase: Ref<UpgradePhase>
  readonly container: Ref<string>
  readonly detail: Ref<string>
  open(name: string): Promise<void>
  retry(): Promise<void>
  dispose(): void
}

export function useContainerUpgrade(deps: ContainerUpgradeDeps): ContainerUpgrade {
  const phase = ref<UpgradePhase>('idle')
  const container = ref('')
  const detail = ref('')

  let timer: ReturnType<typeof setInterval> | null = null
  // 请求代（对齐 useChatConnection 的 containerGen）：open/重试自增，await 后据此丢弃过期响应——
  // 切容器或卸载途中迟到的 list 响应不得再驱动 UI、更不得触发下一次轮询。
  let gen = 0
  let tickBusy = false
  // 本次访问是否已触发过 upgrade：已触发又回到「可触发」态（服务端 attempts<3 → stopped 且
  // needs_upgrade 仍真）时不再自动重触发——否则等于自动重试风暴；交还用户手动重试。
  let triggered = false
  let disposed = false

  function stopPolling(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function startPolling(name: string, myGen: number): void {
    if (timer !== null) return // 已在轮询：不叠加第二个定时器
    timer = setInterval(() => {
      void tick(name, myGen)
    }, UPGRADE_POLL_INTERVAL_MS)
  }

  // 轮询 tick：单飞（上一次未落地则跳过本 tick），避免慢请求叠加并发。
  async function tick(name: string, myGen: number): Promise<void> {
    if (tickBusy) return
    tickBusy = true
    try {
      await step(name, myGen)
    } catch (e) {
      if (disposed || myGen !== gen) return
      // 轮询期间的瞬态失败不静默空转：停轮询 + 明确文案 + 保留手动重试入口（不卡死、不死循环）。
      stopPolling()
      phase.value = 'error'
      detail.value = (e as Error).message
    } finally {
      tickBusy = false
    }
  }

  // 单次决策执行——首次打开 / 轮询 tick / busy 回退共用同一路径，决策不劈叉。
  async function step(name: string, myGen: number): Promise<void> {
    if (disposed || myGen !== gen) return
    const list = await deps.fetch()
    if (disposed || myGen !== gen) return
    const inst = list.find((i) => i.name === name)
    const decision = upgradeDecision({ status: inst?.status, needsUpgrade: inst?.needs_upgrade })
    switch (decision.kind) {
      case 'connect':
        stopPolling()
        phase.value = 'idle'
        detail.value = ''
        deps.onConnectable(name) // 收敛 → 自动恢复 chat 连接（不要求用户刷新页面）
        return
      case 'poll':
        phase.value = 'upgrading'
        detail.value = ''
        startPolling(name, myGen)
        return
      case 'terminal':
        // #701 终态：只透出，恒不再自动触发、不轮询、不建连（无重连风暴）。
        stopPolling()
        phase.value = 'failed'
        detail.value = `${UPGRADE_FAILED_TITLE}。${UPGRADE_FAILED_DETAIL}`
        return
      case 'trigger':
        if (triggered) {
          stopPolling()
          phase.value = 'error'
          detail.value = UPGRADE_RETRY_HINT
          return
        }
        triggered = true
        phase.value = 'upgrading'
        detail.value = ''
        await fireTrigger(name, myGen)
        return
      case 'blocked':
        stopPolling()
        phase.value = 'error'
        detail.value = `容器当前状态为 ${inst?.status ?? '未知'}，暂时无法升级，请稍后重试`
        return
    }
  }

  async function fireTrigger(name: string, myGen: number): Promise<void> {
    try {
      await deps.trigger(name)
      if (disposed || myGen !== gen) return
      startPolling(name, myGen)
    } catch (e) {
      if (disposed || myGen !== gen) return
      // busy（20043）不是「失败」而是「事实与本地认知不一致」：服务端可能已进入 upgrading
      //（另一路径触发）/ 已落终态 / 状态不允许 / bind 拓扑未开启。如实刷新一次状态后按新事实重新
      // 决策（切入轮询或落终态），不重试同一请求、不卡死。triggered 保持 true——若新事实仍是
      // 「可触发」，走的是「已触发过」分支给手动重试提示，绝不二次自动触发（防风暴）。
      if (e instanceof ApiError && e.code === CODE_CONTAINER_BUSY) {
        await step(name, myGen)
        return
      }
      stopPolling()
      phase.value = 'error'
      detail.value = (e as Error).message
    }
  }

  async function open(name: string): Promise<void> {
    if (!name) return
    const myGen = ++gen // 新请求代：作废在途响应 + 旧容器定时器回调
    stopPolling()
    container.value = name
    phase.value = 'idle'
    detail.value = ''
    triggered = false
    try {
      await step(name, myGen)
    } catch (e) {
      if (disposed || myGen !== gen) return
      stopPolling()
      phase.value = 'error'
      detail.value = (e as Error).message
    }
  }

  // 用户显式重试（错误/未完成态的入口）——重开同一容器 = 新请求代，允许再次触发。
  async function retry(): Promise<void> {
    if (!container.value) return
    await open(container.value)
  }

  function dispose(): void {
    disposed = true
    gen++ // 作废在途响应与定时器回调（卸载后不再 setState / 不再发请求）
    stopPolling()
  }

  return { phase, container, detail, open, retry, dispose }
}
