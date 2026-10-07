// 编排域纯值（平移 backend/containers/fleet/values.py，#334）。
// HEALTH_* 为读侧聚合用状态枚举；FleetConfig 为编排控制面配置（来自 config.ts，测试可注入 tmp 路径）。
// T0 #801 legacy 清退：活性 = docker inspect Running（/health 探针与 19000–19999 端口池随 legacy
// 退役废除，#747 E 节）——running → healthy，无 unhealthy 态。

// health 字段枚举（列表显示 health 变 healthy）
export const HEALTH_HEALTHY = 'healthy'
export const HEALTH_STOPPED = 'stopped'
export const HEALTH_PENDING = 'pending' // creating：容器未起，无 health 可探
export const HEALTH_REMOVING = 'removing' // removing：清理中

// 编排控制面配置（部署相关，来自 config.ts env；测试可注入 tmp 路径）
export interface FleetConfig {
  readonly root: string // OPENCLAW_FLEET_ROOT（instances/ 落盘根）
  readonly templateDir: string // 共享只读模板（cp -a 源）
  readonly image: string // pin 的镜像 tag
  readonly llmApiKey: string // 全面板共享 LLM_API_KEY（容器 env 注入）
  // #590/#592 named volume 拓扑开关（ADR 0011；OPENCLAW_NAMED_VOLUMES）：true（默认）时编排用
  // openclaw-wiki/workspace/home-<id> 三卷替代宿主 bind-mount home；显式 false 回退旧 bind
  readonly namedVolumes: boolean
  // 凭证加密密钥（AES-256-GCM；gateway token 落盘密文）
  readonly encryptionKeys: readonly Buffer[]
}
