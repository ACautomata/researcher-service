// files 域常量（#589 · ADR 0012 文件查询经 Docker getArchive/putArchive；#776 root 契约换轨）。
// 单一来源：root 容器内路径 / walk 上限 / 单文件读取上限。供纯逻辑（paths.ts）、
// docker 适配器（dockerArchive.ts）、测试复用。

import { MOUNT_WIKI, MOUNT_WORKSPACE } from '../containers/constants'
import { SANDBOX_LAB_ROOT } from '../sandboxes/values'

// root 契约（#776 · #747 E 节 + story 61）：lab = 会话沙箱可写树（树根 /lab，只读 GET 面经
// readLab——/lab 字节写收敛为 runner 工具 + 上传端点，#769）；wiki = legacy 容器 wiki 树（读写
// 面暂留，退役归 T0）；workspace = legacy 容器 workspace 树——**legacy 只读消费值**：现存前端
// api/files.ts 硬发 root=workspace（fileTabs 消费链），本票硬杀会破坏面板（前端 lab 迁移归 #793
// 重写）；写面对 workspace 一律 90002（改前前端从不写，v1 tabs 只读）。字眼退役终态 = 前端切换
// 落地时（#793 + T0 #801）。
export const FILE_ROOTS: Record<'wiki' | 'workspace' | 'lab', string> = {
  wiki: MOUNT_WIKI,
  workspace: MOUNT_WORKSPACE,
  lab: SANDBOX_LAB_ROOT,
}

// 递归 walk 条目数上限（#586 US9）：巨型目录不拖垮接口——超限即停并标 truncated。
export const WALK_LIMIT = 10_000

// 单文件内容读取上限（字节）：tar 头带 size，超过则按「不可读」过滤（不收集内容），
// 防超大二进制/文本文件撑爆控制面内存（#586 US8「接口不会被大二进制拖垮」）。
export const MAX_FILE_READ_BYTES = 16 * 1024 * 1024
