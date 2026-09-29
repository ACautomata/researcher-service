// 产品显示名单一来源（#758 Q13 / 执行票 #760）：用户可见面一律取 PRODUCT_NAME。
// 与内部标识解耦：仓库名 researcher-service / npm 包名 / GHCR 镜像名 / 容器名前缀 /
// 模块路径一律不动——用户可见文案不得出现 researcher-service 自称。
// frontend/index.html 的 <title> 是静态 HTML 引不到本常量，直写同一字面量（两处互指，改动同步）。
export const PRODUCT_NAME = '天津大学科研智能体平台'
