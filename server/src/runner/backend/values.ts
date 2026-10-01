// runner backend 常量（#747·02）。护栏对齐 PoC #724 实测口径（dockerBackend.ts）；
// EMPTY_CONTENT_WARNING 文案镜像 deepagents（checkEmptyContent 原文）。

// 单次 getArchive 收集上限（PoC 32MiB 护栏）：glob/grep 整树收集与 read 单文件共用——
// 超出即 error，不驻留更大内存（防巨型树/文件撑爆控制面）。
export const MAX_COLLECT_BYTES = 32 * 1024 * 1024

// execute 输出截断上限（PoC 50k chars）：超出截断 + truncated 标记回 agent。
export const MAX_OUTPUT_CHARS = 50_000

// execute 默认超时（对齐上游 LocalShellBackend 默认 120s）：超时由容器内 timeout coreutil
// SIGKILL 子进程（adapter 包 argv，机制与退出码归一见 dockerPrimitives.ts），exitCode 124
// 语义 + stderr 附说明——防 agent 一条挂起命令永久楔死 runner 回合（评审 M2）。
// 前置：沙箱镜像须含 timeout applet（busybox/GNU coreutils 皆有；#776/#784 钉镜像时列为验收项）。
export const EXEC_DEFAULT_TIMEOUT_MS = 120_000

// read 默认分页（deepagents BackendProtocolV2 签名默认）。
export const DEFAULT_READ_OFFSET = 0
export const DEFAULT_READ_LIMIT = 500

// grep 默认匹配条数上限（PoC 口径）：超出截断 + truncated:true（对齐 applyGrepMaxCount 语义）。
export const GREP_DEFAULT_MAX_COUNT = 1000

// 空文件读返回的提示文本（对齐 deepagents EMPTY_CONTENT_WARNING——空文件非错误，agent 继续）。
export const EMPTY_CONTENT_WARNING = 'System reminder: File exists but has empty contents'
