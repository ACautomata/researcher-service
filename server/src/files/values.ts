// files 域常量（#589 · ADR 0012 文件查询经 Docker getArchive；#776 root 契约换轨；T0 #801 只读化）。
// 单一来源：沙箱树根 / walk 上限 / 单文件读取上限。供纯逻辑（paths.ts）、
// docker 适配器（dockerArchive.ts）、测试复用。
//
// T0 #801：files API 只读化——root=wiki（legacy 容器 wiki 树）与 root=workspace（legacy 容器
// workspace 树）整根退役（wiki 读走 wiki 域 REST；workspace 字眼退役，#747 E 节/story 61）。
// 唯一保留读面 = root=lab（会话沙箱 /lab 只读 GET 面——/lab 字节写收敛为 runner 工具 + 上传端点）。

import { SANDBOX_LAB_ROOT } from '../sandboxes/values'

// 沙箱 /lab 树根（容器内绝对路径）——files 域 lab 读面与 attachments 下载通道共用。
export const LAB_ROOT_ABS = SANDBOX_LAB_ROOT

// 递归 walk 条目数上限（#586 US9）：巨型目录不拖垮接口——超限即停并标 truncated。
export const WALK_LIMIT = 10_000

// 单文件内容读取上限（字节）：tar 头带 size，超过则按「不可读」过滤（不收集内容），
// 防超大二进制/文本文件撑爆控制面内存（#586 US8「接口不会被大二进制拖垮」）。
export const MAX_FILE_READ_BYTES = 16 * 1024 * 1024
