// 面板自管容器共享常量单一来源（平移 backend/containers/constants.py，#334）。
// #858 OpenClaw 退役③：openclaw-gw fleet（app=openclaw-fleet 标签、openclaw-gw- 名前缀、
// named volume 拓扑、gateway 端口/绑定、token 熵）随容器消费面退役整组删除——本模块收敛为
// wiki|sandbox 两 kind 的 docker 标签 schema（researcher.kind / researcher.session / researcher.owner），
// 消费方 = sandboxes/ 与 wikiContainers/ 的 dockerRuntime（打标）与防御性识别（containerKind）。

// #747 E 节 / #776 / #784：容器 kind 标签二值 wiki|sandbox（#858 起三值收敛——legacy 值仅为
// T0 删除路径的识别标记，fleet 随 #858 消失后不再出现；无标签/外来容器 containerKind 返 null，
// 防御性消费方一律不触碰）。
export const LABEL_KIND_KEY = 'researcher.kind'
export const KIND_WIKI = 'wiki'
export const KIND_SANDBOX = 'sandbox'
// 沙箱 → 会话绑定标签（researcher.session = sessionId）：daemon 侧认领/清理沙箱的归属凭据。
export const LABEL_SESSION_KEY = 'researcher.session'
// wiki 容器 → 用户绑定标签（researcher.owner = userId，#784）：daemon 侧认领 wiki 容器的
// 归属凭据（listWikis 映射容器 → owner；无此标签的 kind=wiki 容器不属编排，防御性跳过）。
export const LABEL_OWNER_KEY = 'researcher.owner'
