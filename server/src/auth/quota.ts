// 配额纯校验（零依赖模块：config 与 userService 共用，避免循环依赖）。
// 唯一准据：maxContainers 须在 [0, 2^31-1]（Prisma Int 列上界）。
// - createUser / users PATCH 的显式 quota → assertQuotaValid（envelope 10043）
// - config 加载 DEFAULT_MAX_CONTAINERS → isQuotaValid（非法 fail-fast，杜绝写库 NaN/超界）
export const QUOTA_MAX = 2_147_483_647

export function isQuotaValid(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= QUOTA_MAX
}
