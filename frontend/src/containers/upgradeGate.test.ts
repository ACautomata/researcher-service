// seam: #702 惰性升级纯决策层 —— 三问（能否连 chat / 是否触发 upgrade / 是否继续 poll）+ 列表徽标。
// 纯函数无副作用、不摸 window/timer，故此处只钉语义边界；副作用编排（触发/轮询/卸载）在
// ChatView #702 接线用例与 useContainerUpgrade 的宿主接线中覆盖。
import { describe, expect, it } from 'vitest'
import {
  canConnectChat,
  shouldContinuePolling,
  shouldTriggerUpgrade,
  UPGRADE_FAILED_DETAIL,
  UPGRADE_FAILED_TITLE,
  upgradeBadge,
  upgradeDecision,
} from '@/containers/upgradeGate'

describe('#702 upgradeDecision（打开容器后的唯一去向）', () => {
  it('needs_upgrade + running/stopped → trigger（服务端受理的两个前提态）', () => {
    expect(upgradeDecision({ status: 'running', needsUpgrade: true }).kind).toBe('trigger')
    expect(upgradeDecision({ status: 'stopped', needsUpgrade: true }).kind).toBe('trigger')
    expect(shouldTriggerUpgrade({ status: 'running', needsUpgrade: true })).toBe(true)
  })

  it('needs_upgrade + 其余状态（creating/removing/error）→ blocked（前置拦下 20043 busy）', () => {
    for (const status of ['creating', 'removing', 'error']) {
      expect(upgradeDecision({ status, needsUpgrade: true }).kind).toBe('blocked')
    }
  })

  it('upgrading → poll（在飞：不重复触发、轮询等终态；needs_upgrade 仍真也不触发）', () => {
    expect(upgradeDecision({ status: 'upgrading', needsUpgrade: true }).kind).toBe('poll')
    expect(upgradeDecision({ status: 'upgrading' }).kind).toBe('poll')
    expect(shouldContinuePolling({ status: 'upgrading', needsUpgrade: true })).toBe(true)
    expect(shouldTriggerUpgrade({ status: 'upgrading', needsUpgrade: true })).toBe(false)
  })

  it('#701 终态 upgrade_failed → terminal（优先于 needs_upgrade：恒不再触发）', () => {
    expect(upgradeDecision({ status: 'upgrade_failed', needsUpgrade: true }).kind).toBe('terminal')
    expect(upgradeDecision({ status: 'upgrade_failed', needsUpgrade: false }).kind).toBe('terminal')
    expect(shouldTriggerUpgrade({ status: 'upgrade_failed', needsUpgrade: true })).toBe(false)
    expect(shouldContinuePolling({ status: 'upgrade_failed', needsUpgrade: true })).toBe(false)
  })

  it('无需升级且 running → connect；未知/缺省 → connect（保留既有建连路径）', () => {
    expect(upgradeDecision({ status: 'running', needsUpgrade: false }).kind).toBe('connect')
    expect(canConnectChat({ status: 'running', needsUpgrade: false })).toBe(true)
    // 列表里找不到该容器（undefined）→ 不拦，交给既有 bootstrap-token 门报错
    expect(upgradeDecision(undefined).kind).toBe('connect')
    expect(upgradeDecision(null).kind).toBe('connect')
    expect(canConnectChat(undefined)).toBe(true)
  })

  it('needs_upgrade 缺省（旧后端/未携带）→ 视作无需升级', () => {
    expect(upgradeDecision({ status: 'running' }).kind).toBe('connect')
  })
})

describe('#702 upgradeBadge（列表三态标记）', () => {
  it('三态文案与视觉状态两两互异', () => {
    const need = upgradeBadge({ status: 'running', needsUpgrade: true })
    const doing = upgradeBadge({ status: 'upgrading', needsUpgrade: true })
    const failed = upgradeBadge({ status: 'upgrade_failed', needsUpgrade: true })
    expect(need).toEqual({ label: '需升级', tone: 'warning' })
    expect(doing).toEqual({ label: '升级中', tone: 'primary' })
    expect(failed).toEqual({ label: '升级失败', tone: 'danger' })
    const labels = [need!.label, doing!.label, failed!.label]
    const tones = [need!.tone, doing!.tone, failed!.tone]
    expect(new Set(labels).size).toBe(3)
    expect(new Set(tones).size).toBe(3)
  })

  it('status 优先于 needs_upgrade（升级中/终态期间读侧 needs_upgrade 仍可能为真）', () => {
    expect(upgradeBadge({ status: 'upgrading', needsUpgrade: true })!.label).toBe('升级中')
    expect(upgradeBadge({ status: 'upgrade_failed', needsUpgrade: true })!.label).toBe('升级失败')
  })

  it('无需升级 → null（不渲染徽标）', () => {
    expect(upgradeBadge({ status: 'running', needsUpgrade: false })).toBeNull()
    expect(upgradeBadge({ status: 'running' })).toBeNull()
    expect(upgradeBadge(undefined)).toBeNull()
  })
})

describe('#702 终态文案（#701 三条语义齐备）', () => {
  it('含「仅可删除重建」+「重建丢数据」+「备份可手工救回」', () => {
    expect(UPGRADE_FAILED_TITLE).toContain('仅可删除重建')
    expect(UPGRADE_FAILED_DETAIL).toContain('丢失')
    expect(UPGRADE_FAILED_DETAIL).toContain('备份')
    expect(UPGRADE_FAILED_DETAIL).toContain('救回')
  })
})
