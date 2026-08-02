// 容器/编排域纯常量单一来源（平移 backend/containers/constants.py，#334）。
// 真常量（协议/架构级不变量，跨部署不漂移）进此模块；部署配置（端口池区间/宿主 bind/token）留 config.ts。

// 容器内 gateway 固定端口（Docker 网络命名空间隔离，仅宿主侧分配映射端口）
export const GATEWAY_INTERNAL_PORT = 18789

// 容器名前缀：与原 compose 栈 openclaw-gateway 隔离
export const CONTAINER_PREFIX = 'openclaw-gw-'
// 按 label 过滤管理容器生命周期
export const LABEL_APP_KEY = 'app'
export const LABEL_APP_VALUE = 'openclaw-fleet'
export const LABEL_INSTANCE_KEY = 'openclaw.instance'
export const LABEL_PORT_KEY = 'openclaw.port'
// 容器内固定 bind-mount 路径
export const HOME_BIND = '/home/node/.openclaw'
export const CONFIG_BIND = '/home/node/.openclaw/openclaw.json'
// gateway 网络绑定模式（容器内 gateway 绑 lan，宿主侧靠 Docker 端口映射隔离）
export const GATEWAY_BIND = 'lan'
// env 占位：真 token 绝不落盘 JSON，保留 ${GATEWAY_TOKEN} 由 gateway 进程运行时插值
export const GATEWAY_TOKEN_PLACEHOLDER = '${GATEWAY_TOKEN}'

// --- 编排状态机协议常量 ---
// gateway_token 熵（GATEWAY_TOKEN）：32 字节 = 256 bit
export const TOKEN_URLSAFE_BYTES = 32
