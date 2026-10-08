import { describe, it, expect, vi } from 'vitest'
import { isQuotaValid, QUOTA_MAX } from '../src/auth/quota'
import { isFloatingImageRef } from '../src/containers/imageRef'

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

// #858（前身 OPENCLAW_FLEET_ROOT 意见[Codex 第七轮 #4]）：DATA_ROOT 生产强制绝对路径，
// 显式相对 fail-fast；缺省走 cwd/data 绝对兜底；dev/test 保持容忍（本地调试可显式相对）。
describe('production data root (slice config, #858)', () => {
  async function loadDataRoot(opts: {
    env?: string
    root?: string | undefined
  }): Promise<string | 'THREW'> {
    vi.resetModules()
    const { env = 'production', root } = opts
    vi.stubEnv('NODE_ENV', env)
    if (env === 'production') {
      // 隔离 dataRoot 变量：提供其余生产必填，否则放行用例被误判 THREW（同 loadSecret 模式）。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
    }
    if (root === undefined) delete process.env.DATA_ROOT
    else vi.stubEnv('DATA_ROOT', root)
    try {
      const { config } = await import('../src/config')
      return config.dataRoot
    } catch {
      return 'THREW' // fail-fast
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('生产相对路径 → fail-fast（须绝对路径，防 cwd 漂移错配）', async () => {
    expect(await loadDataRoot({ root: 'data/relative' })).toBe('THREW')
  })

  it('生产相对单段 data → fail-fast', async () => {
    expect(await loadDataRoot({ root: 'data' })).toBe('THREW')
  })

  it('生产合法绝对路径 → 放行', async () => {
    expect(await loadDataRoot({ root: '/var/panel-data' })).toBe('/var/panel-data')
  })

  it('生产缺省 → cwd/data 绝对兜底', async () => {
    expect(await loadDataRoot({ root: undefined })).toBe(`${process.cwd()}/data`)
  })

  it('dev 相对路径 → 容忍（本地调试不受影响）', async () => {
    expect(await loadDataRoot({ env: 'development', root: 'data/rel' })).toBe('data/rel')
  })
})

// 纯准据共享单测（#858 起 OPENCLAW_IMAGE 随 fleet 退役；SANDBOX/WIKI_IMAGE 共用同一判定，
// 判定语义钉死在此）：config 与 wikiImage.test.ts 静态断言共享同一准据。
describe('isFloatingImageRef 纯准据（#695 判定内核）', () => {
  it('无 tag / :latest 浮动；版本 tag / digest 不浮动', () => {
    expect(isFloatingImageRef('ghcr.io/a/b/img')).toBe(true)
    expect(isFloatingImageRef('img')).toBe(true)
    expect(isFloatingImageRef('ghcr.io/a/b/img:latest')).toBe(true)
    expect(isFloatingImageRef('img:latest')).toBe(true)
    expect(isFloatingImageRef('img:')).toBe(true) // 空 tag 不构成钉版
    expect(isFloatingImageRef('ghcr.io/a/b/img:2026.9.4')).toBe(false)
    expect(isFloatingImageRef('registry.internal:5000/img:2026.9.4')).toBe(false)
    expect(isFloatingImageRef(`ghcr.io/a/b/img@sha256:${'a'.repeat(64)}`)).toBe(false)
    expect(isFloatingImageRef(`ghcr.io/a/b/img:latest@sha256:${'a'.repeat(64)}`)).toBe(false)
  })
})

// ---- #776 沙箱配置组：SANDBOX_IMAGE 钉版（生产禁浮动，readPinnedImage 共用内核）----

describe('sandbox image pinning env (#776)', () => {
  async function loadSandboxImage(opts: { env?: string; image?: string | undefined }): Promise<string | 'THREW'> {
    vi.resetModules()
    const { env = 'production', image } = opts
    vi.stubEnv('NODE_ENV', env)
    if (env === 'production') {
      // 隔离 sandbox 变量：提供其余生产必填（同 loadDataRoot 模式；#858 起 CREDENTIAL_ENCRYPTION_KEYS 非必填）。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
    }
    if (image === undefined) delete process.env.SANDBOX_IMAGE
    else vi.stubEnv('SANDBOX_IMAGE', image)
    try {
      const { config } = await import('../src/config')
      return config.sandbox.image
    } catch (e) {
      if (env === 'production') expect((e as Error).message).toContain('SANDBOX_IMAGE')
      return 'THREW'
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('生产缺省 → busybox 最小闭环镜像且非浮动（含 timeout applet 前提）', async () => {
    const v = await loadSandboxImage({ image: undefined })
    expect(v).toBe('busybox:1.36')
    expect(isFloatingImageRef(v)).toBe(false)
  })

  it('生产 + 精确版本 tag → 放行', async () => {
    expect(await loadSandboxImage({ image: 'ghcr.io/acautomata/researcher-service/sandbox:2026.10.1' })).toBe(
      'ghcr.io/acautomata/researcher-service/sandbox:2026.10.1',
    )
  })

  it('生产 + :latest / 无 tag → fail-fast（浮动 tag 目标不可复现）', async () => {
    expect(await loadSandboxImage({ image: 'ghcr.io/openclaw/sandbox:latest' })).toBe('THREW')
    expect(await loadSandboxImage({ image: 'ghcr.io/openclaw/sandbox' })).toBe('THREW')
  })

  it('dev + :latest → 放行（本地调试不受影响）', async () => {
    expect(await loadSandboxImage({ env: 'development', image: 'ghcr.io/openclaw/sandbox:latest' })).toBe(
      'ghcr.io/openclaw/sandbox:latest',
    )
  })
})

// ---- #784 wiki 容器配置组：WIKI_IMAGE 钉版（生产禁浮动，对齐 readFleetImage 先例）----

describe('wiki image pinning env (#784)', () => {
  async function loadWikiImage(opts: { env?: string; image?: string | undefined }): Promise<string | 'THREW'> {
    vi.resetModules()
    const { env = 'production', image } = opts
    vi.stubEnv('NODE_ENV', env)
    if (env === 'production') {
      // 隔离 wiki 变量：提供其余生产必填（同 loadDataRoot 模式）。
      vi.stubEnv('JWT_SECRET', 's'.repeat(32))
    }
    if (image === undefined) delete process.env.WIKI_IMAGE
    else vi.stubEnv('WIKI_IMAGE', image)
    try {
      const { config } = await import('../src/config')
      return config.wikiContainers.image
    } catch (e) {
      if (env === 'production') expect((e as Error).message).toContain('WIKI_IMAGE')
      return 'THREW'
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('生产缺省 → 本仓库派生镜像且非浮动（busybox 基线，零初始化）', async () => {
    const v = await loadWikiImage({ image: undefined })
    expect(v).toBe('ghcr.io/acautomata/researcher-service/wiki:1.36')
    expect(isFloatingImageRef(v)).toBe(false)
  })

  it('生产 + 精确版本 tag → 放行', async () => {
    expect(await loadWikiImage({ image: 'ghcr.io/acautomata/researcher-service/wiki:1.37' })).toBe(
      'ghcr.io/acautomata/researcher-service/wiki:1.37',
    )
  })

  it('生产 + :latest / 无 tag → fail-fast（浮动 tag 目标不可复现）', async () => {
    expect(await loadWikiImage({ image: 'ghcr.io/acautomata/researcher-service/wiki:latest' })).toBe('THREW')
    expect(await loadWikiImage({ image: 'ghcr.io/acautomata/researcher-service/wiki' })).toBe('THREW')
  })

  it('dev + :latest → 放行（本地调试可用 busybox 覆盖）', async () => {
    expect(await loadWikiImage({ env: 'development', image: 'busybox:latest' })).toBe('busybox:latest')
  })
})

// ---- #775 runner 配置组：RUNNER_MAX_CONCURRENT_RUNS / ALLOW_PRIVATE_PROVIDER_ENDPOINTS ----

describe('runner max concurrent runs env (#775)', () => {
  async function loadMax(env: string | undefined): Promise<number | 'THREW'> {
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.RUNNER_MAX_CONCURRENT_RUNS
    else vi.stubEnv('RUNNER_MAX_CONCURRENT_RUNS', env)
    try {
      const { config } = await import('../src/config')
      return config.runner.maxConcurrentRuns
    } catch {
      return 'THREW'
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('未设置 → 默认 8', async () => {
    expect(await loadMax(undefined)).toBe(8)
  })

  it('合法 16 → 加载为 16', async () => {
    expect(await loadMax('16')).toBe(16)
  })

  it('非法 0 / 负数 / abc / 小数 → fail-fast（加载即校验）', async () => {
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      expect(await loadMax(bad), bad).toBe('THREW')
    }
  })

  it('上界校验：10000 合法、10001 → fail-fast（#812 打捞——滥值会打穿全局 runaway 防线）', async () => {
    expect(await loadMax('10000')).toBe(10000)
    expect(await loadMax('10001')).toBe('THREW')
  })
})

describe('allow private provider endpoints env (#775)', () => {
  async function loadFlag(opts: { env?: string; flag?: string }): Promise<boolean | 'THREW'> {
    const { env, flag } = opts
    vi.resetModules() // 清 config 模块缓存，让动态 import 重新快照 env
    if (env === undefined) delete process.env.NODE_ENV
    else vi.stubEnv('NODE_ENV', env)
    if (flag === undefined) delete process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS
    else vi.stubEnv('ALLOW_PRIVATE_PROVIDER_ENDPOINTS', flag)
    try {
      const { config } = await import('../src/config')
      return config.runner.allowPrivateProviderEndpoints
    } catch {
      return 'THREW'
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it('未设置 → 默认 false（私网端点一律拒）', async () => {
    expect(await loadFlag({})).toBe(false)
  })

  it('显式 false → false', async () => {
    expect(await loadFlag({ flag: 'false' })).toBe(false)
  })

  it('dev/test 显式 true → true（自建 vLLM 逃生门）', async () => {
    expect(await loadFlag({ env: 'test', flag: 'true' })).toBe(true)
    expect(await loadFlag({ env: 'development', flag: 'true' })).toBe(true)
  })

  it('生产 true → fail-fast（逃生门仅限 dev）', async () => {
    expect(await loadFlag({ env: 'production', flag: 'true' })).toBe('THREW')
  })

  it('非法值 TRUE/1 → fail-fast（白名单开关模式）', async () => {
    for (const bad of ['TRUE', '1', 'yes']) {
      expect(await loadFlag({ flag: bad }), bad).toBe('THREW')
    }
  })
})
