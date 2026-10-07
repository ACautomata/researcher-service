// 容器/编排域纯常量单一来源（平移 backend/containers/constants.py，#334）。
// 真常量（协议/架构级不变量，跨部署不漂移）进此模块；部署配置留 config.ts。
// T0 #801 legacy 清退：端口池/oneshot 升级编排/pairing 相关常量随组件删除。

// 容器内 gateway 固定端口（Docker 网络命名空间隔离；T0 起不再向宿主发布映射——隧道/配对/
// 健康探针全退役，无外部消费者，端口仅容器内语义）
export const GATEWAY_INTERNAL_PORT = 18789

// 容器名前缀：与原 compose 栈 openclaw-gateway 隔离
export const CONTAINER_PREFIX = 'openclaw-gw-'
// #590 named volume 名前缀（ADR 0011）：openclaw-<kind>-<id>，按代系 id（#360）派生
// （runtime.namedVolumesFor）。容器删除时连带 docker volume rm 清理。
export const VOLUME_WIKI_PREFIX = 'openclaw-wiki-'
export const VOLUME_WORKSPACE_PREFIX = 'openclaw-workspace-'
export const VOLUME_HOME_PREFIX = 'openclaw-home-'
// 按 label 过滤管理容器生命周期
export const LABEL_APP_KEY = 'app'
export const LABEL_APP_VALUE = 'openclaw-fleet'
export const LABEL_INSTANCE_KEY = 'openclaw.instance'
// #747 E 节 / #776：容器 kind 标签三值 legacy|wiki|sandbox 分派 create/health/delete
// 路径（legacy 值仅为 T0 删除路径的识别标记）。#776 先立沙箱支路（kind=sandbox + session 绑定标签）；
// legacy fleet（app=openclaw-fleet）不带 kind 标签、与新标签互不影响——listFleet 按 app label 过滤，
// 沙箱不打 app 标签即天然隐身（#747「沙箱对容器列表隐身」）。
export const LABEL_KIND_KEY = 'researcher.kind'
export const KIND_LEGACY = 'legacy'
export const KIND_WIKI = 'wiki'
export const KIND_SANDBOX = 'sandbox'
// 沙箱 → 会话绑定标签（researcher.session = sessionId）：daemon 侧认领/清理沙箱的归属凭据。
export const LABEL_SESSION_KEY = 'researcher.session'
// wiki 容器 → 用户绑定标签（researcher.owner = userId，#784）：daemon 侧认领 wiki 容器的
// 归属凭据（listWikis 映射容器 → owner；无此标签的 kind=wiki 容器不属编排，防御性跳过）。
export const LABEL_OWNER_KEY = 'researcher.owner'
// 容器内 home 路径。HOME_BIND 指容器内 ~/.openclaw 根（named volume 拓扑下 home 卷挂载点；
// 镜像骨架首挂初始化 + seedWorkspace 灌 researcher 模板 workspace 的目标根）。
export const HOME_BIND = '/home/node/.openclaw'
// 三卷在容器内的挂载点（#590 拓扑）：挂载布局是共享内核纯知识——真容器 buildRunOptions 与
// wiki/files 消费方从这里取，防路径字面量多处手写漂移；home 卷直接挂 HOME_BIND。
export const MOUNT_WIKI = `${HOME_BIND}/wiki/main`
export const MOUNT_WORKSPACE = `${HOME_BIND}/workspace`
// gateway 网络绑定模式（容器内 gateway 绑 lan；T0 起无宿主端口发布，绑lan仅容器内语义）
export const GATEWAY_BIND = 'lan'

// --- 编排状态机协议常量 ---
// gateway_token 熵（GATEWAY_TOKEN）：32 字节 = 256 bit
export const TOKEN_URLSAFE_BYTES = 32
