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

// 意见②⑧[P2]（Codex ⑯ 轮）：DUMMY_BCRYPT_HASH 固定 cost=12，而 config.bcryptCost 原可被
// BCRYPT_COST env 覆盖 → cost≠12 时 dummy(12) 与真实 hash 耗时差恢复账号存在性探测。修复：
// 规格锁 12（.env.example/README 明文），config 加载即校验，非 12 fail-fast（与 JWT_SECRET 生产
// 校验同模式）。真实 hash 与 dummy 恒同 cost，时序侧信道不再依赖「配置恰好为 12」。
describe('bcrypt cost env (slice config)', () => {
  async function loadBcryptCost(env: string | undefined): Promise<number | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.BCRYPT_COST
    else vi.stubEnv('BCRYPT_COST', env)
    try {
      const { config } = await import('../src/config')
      return config.bcryptCost
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('未设置 → 默认 12（规格锁）', async () => {
    expect(await loadBcryptCost(undefined)).toBe(12)
  })

  it('显式 12 → 加载为 12（合法）', async () => {
    expect(await loadBcryptCost('12')).toBe(12)
  })

  it('非 12（如 14）→ fail-fast（不再允许 cost 漂移）', async () => {
    expect(await loadBcryptCost('14')).toBe('THREW')
  })

  it('非数字 abc → fail-fast', async () => {
    expect(await loadBcryptCost('abc')).toBe('THREW')
  })
})

// 意见②⑧[P1]（Codex ⑰ 轮）：生产 JWT_SECRET 仅挡占位符不够 —— `JWT_SECRET=a` 弱值也能签发
// HS256 access token，攻击者离线爆破伪造 admin token。修复：production 下强制 ≥32 字符
// （256bit HS256 安全下限），不足 fail-fast。dev/test 保持任意非空可用（本地调试）。
describe('JWT secret strength env (slice config)', () => {
  async function loadSecret(
    opts: { secret?: string; env?: string },
  ): Promise<string | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    const { secret, env = 'production' } = opts
    if (secret === undefined) delete process.env.JWT_SECRET
    else vi.stubEnv('JWT_SECRET', secret)
    vi.stubEnv('NODE_ENV', env)
    // C1：production 下 config 加载还校验 CREDENTIAL_ENCRYPTION_KEYS（gateway token 加密密钥）。
    // 提供合法 32B base64 隔离 JWT_SECRET 变量——否则放行用例会因缺加密密钥被误判 THREW。
    if (env === 'production') {
      vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', Buffer.alloc(32, 0x01).toString('base64'))
    }
    try {
      const { config } = await import('../src/config')
      return config.jwtSecret
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs() // 恢复 env（避免污染后续测试文件）
    }
  }

  it('生产缺 JWT_SECRET → fail-fast（既有行为）', async () => {
    expect(await loadSecret({ secret: undefined })).toBe('THREW')
  })

  it('生产 JWT_SECRET 为占位符 → fail-fast（既有行为）', async () => {
    expect(await loadSecret({ secret: 'change-me-in-production' })).toBe('THREW')
  })

  it('生产 JWT_SECRET 过短（<32，如 a）→ fail-fast（新校验）', async () => {
    expect(await loadSecret({ secret: 'a' })).toBe('THREW')
  })

  it('生产 JWT_SECRET 恰好 31 字符 → fail-fast（新校验边界）', async () => {
    expect(await loadSecret({ secret: 'x'.repeat(31) })).toBe('THREW')
  })

  it('生产 JWT_SECRET ≥32 字符 → 放行并返回', async () => {
    const strong = 's'.repeat(32)
    expect(await loadSecret({ secret: strong })).toBe(strong)
  })

  it('dev/test 短密钥仍可用（本地调试不受影响）', async () => {
    expect(await loadSecret({ secret: 'a', env: 'development' })).toBe('a')
  })
})

// 意见③⓪[P2]（Codex ㉑ 轮）：BOOTSTRAP_ADMIN_USERNAME 空串视为缺失 —— Compose 未设置变量替换成
// 空串时 `?? 'admin'` 不触发（空串非 nullish），bootstrap 建 username="" 的唯一 admin，而
// loginSchema min(1) 拒绝空串 → 永久不可登录、重启又因 users 非空跳过 bootstrap。修复：空串回退默认。
describe('bootstrap admin username env (slice config)', () => {
  async function loadUsername(env: string | undefined): Promise<string> {
    vi.resetModules()
    if (env === undefined) delete process.env.BOOTSTRAP_ADMIN_USERNAME
    else vi.stubEnv('BOOTSTRAP_ADMIN_USERNAME', env)
    try {
      const { config } = await import('../src/config')
      return config.bootstrapAdminUsername
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('未设置 → 默认 admin', async () => {
    expect(await loadUsername(undefined)).toBe('admin')
  })

  it('自定义 my-admin → 保留', async () => {
    expect(await loadUsername('my-admin')).toBe('my-admin')
  })

  it('空串 → 视为缺失回退 admin（新校验）', async () => {
    expect(await loadUsername('')).toBe('admin')
  })

  it('纯空白 → 视为缺失回退 admin', async () => {
    expect(await loadUsername('   ')).toBe('admin')
  })
})

// 意见③①[P2]（Codex ㉓ 轮）：REFRESH_TOKEN_TTL 启动期校验 —— `7days` 这类错值 config 接受、
// server 正常起（health 绿），首个 login 才在 refreshExpiresAt() 抛 90000。修复：config 加载即
// 校验 TTL 格式（与 tokens.parseTtlToMs 同正则 `<数字><单位>`），非法 fail-fast。
describe('refresh ttl env (slice config)', () => {
  async function loadRefreshTtl(env: string | undefined): Promise<string | 'THREW'> {
    vi.resetModules()
    if (env === undefined) delete process.env.REFRESH_TOKEN_TTL
    else vi.stubEnv('REFRESH_TOKEN_TTL', env)
    try {
      const { config } = await import('../src/config')
      return config.refreshTtl
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('未设置 → 默认 7d', async () => {
    expect(await loadRefreshTtl(undefined)).toBe('7d')
  })

  it('合法 30m → 保留', async () => {
    expect(await loadRefreshTtl('30m')).toBe('30m')
  })

  it('非法 7days → fail-fast（新校验）', async () => {
    expect(await loadRefreshTtl('7days')).toBe('THREW')
  })

  it('非法 abc → fail-fast', async () => {
    expect(await loadRefreshTtl('abc')).toBe('THREW')
  })
})
