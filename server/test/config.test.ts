import { describe, it, expect, vi } from 'vitest'
import { isQuotaValid, QUOTA_MAX } from '../src/auth/quota'

// 意见⑬[P2]（Codex 六轮）：DEFAULT_MAX_CONTAINERS 默认配额写入前未校验 —— config 加载时
// Number(env ?? 3) 快照，非法 env（负/非数/超 Int 上界）会变 NaN/负数/超界，createUser/bootstrap
// fallback 写库时 Prisma 拒写 90000 或存非法配额。修复：config 加载即校验（isQuotaValid），非法
// fail-fast 抛错。isQuotaValid 与 userService.assertQuotaValid 共享 quota.ts 单一准据。
describe('default quota env (slice config)', () => {
  async function loadDefaultQuota(env: string | undefined): Promise<number | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.DEFAULT_MAX_CONTAINERS
    else vi.stubEnv('DEFAULT_MAX_CONTAINERS', env)
    try {
      const { config } = await import('../src/config')
      return config.defaultMaxContainers
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 3（dev 友好）', async () => {
    expect(await loadDefaultQuota(undefined)).toBe(3)
  })

  it('合法 7 → 加载为 7', async () => {
    expect(await loadDefaultQuota('7')).toBe(7)
  })

  it('非数字 abc → fail-fast（不再写 NaN）', async () => {
    expect(await loadDefaultQuota('abc')).toBe('THREW')
  })

  it('负数 -5 → fail-fast（不再写负配额）', async () => {
    expect(await loadDefaultQuota('-5')).toBe('THREW')
  })

  it('超 Int 上界 2147483648 → fail-fast（不再写超界）', async () => {
    expect(await loadDefaultQuota('2147483648')).toBe('THREW')
  })

  // quota.ts 纯校验准据（config 与 userService 共用）
  it('isQuotaValid：0 / 上界 / 中间值合法；负数 / 超界 / NaN / 非整数非法', () => {
    expect(isQuotaValid(0)).toBe(true)
    expect(isQuotaValid(QUOTA_MAX)).toBe(true)
    expect(isQuotaValid(3)).toBe(true)
    expect(isQuotaValid(-1)).toBe(false)
    expect(isQuotaValid(QUOTA_MAX + 1)).toBe(false)
    expect(isQuotaValid(Number.NaN)).toBe(false)
    expect(isQuotaValid(3.5)).toBe(false) // 非整数（Prisma Int 不接受小数）
  })
})
