// 五位分层码表（#312 最终准据 + #319 转译码 + #333 执行期新增 10005）。
// 单一来源：所有信封码在此定义，路由/中间件引用常量名而非裸数字。
//
// 段：0 成功 · 1xxxx 通用/鉴权 · 2xxxx 容器（20041 复用为 name 全局冲突）·
//     9xxxx 系统/校验。完整表见 docs/research/319-api-contract.md §1。

export const CODE = {
  OK: 0,
  // 1xxxx 通用 / 鉴权
  UNAUTHENTICATED: 10001, // 无/坏 access token（转译 401）
  LOGIN_FAILED: 10002, // 用户名/密码错（转译 401）
  REFRESH_INVALID: 10003, // refresh 缺失/无效/已撤销/重放
  FORBIDDEN: 10004, // 角色不足（user 调 admin-only / 跨用户，转译 403）
  MUST_CHANGE_PASSWORD: 10005, // #333 新增：mustChangePassword 拦截（规格未定义码，执行期微调）
  // 1xxxx 账号管理（#328）
  USER_NOT_FOUND: 10041, // 用户不存在 / 越权（同码防探测）
  USERNAME_INVALID: 10042, // 用户名格式非法
  QUOTA_INVALID: 10043, // 配额非法
  CANNOT_DISABLE_SELF: 10044, // 不可禁用自己
  // 2xxxx 容器（20041 锁 = name 全局唯一冲突；register/users 用户名冲突复用，契约 §2.2）
  NAME_CONFLICT: 20041,
  // 9xxxx 系统 / 校验
  OAUTH_NOT_CONFIGURED: 90001, // OAuth provider 未配置（原 501）
  VALIDATION_FAILED: 90002, // 参数校验失败（字段明细进 data）
  ROUTE_NOT_FOUND: 90005, // 路由不存在（404 信封兜底）
  INTERNAL: 90000, // 未知错误兜底
} as const

export type EnvelopeCode = (typeof CODE)[keyof typeof CODE]

// 默认人类可读总述；抛 EnvelopeError 时可不传 message 走默认。
export const DEFAULT_MESSAGE: Record<number, string> = {
  [CODE.OK]: 'ok',
  [CODE.UNAUTHENTICATED]: '未登录或登录已过期',
  [CODE.LOGIN_FAILED]: '用户名或密码错误',
  [CODE.REFRESH_INVALID]: '刷新凭证无效',
  [CODE.FORBIDDEN]: '权限不足',
  [CODE.MUST_CHANGE_PASSWORD]: '需要先修改密码',
  [CODE.USER_NOT_FOUND]: '用户不存在',
  [CODE.USERNAME_INVALID]: '用户名不合法',
  [CODE.QUOTA_INVALID]: '配额不合法',
  [CODE.CANNOT_DISABLE_SELF]: '不能禁用自己的账号',
  [CODE.NAME_CONFLICT]: '名称已被占用',
  [CODE.OAUTH_NOT_CONFIGURED]: 'OAuth provider 未配置',
  [CODE.VALIDATION_FAILED]: '参数校验失败',
  [CODE.ROUTE_NOT_FOUND]: '路由不存在',
  [CODE.INTERNAL]: '服务器内部错误',
}

export function defaultMessage(code: number): string {
  return DEFAULT_MESSAGE[code] ?? '错误'
}
