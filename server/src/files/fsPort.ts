// FileArchive Port（#589 · ADR 0012 文件操作经 Docker 原语；T0 #801 只读化收缩）。
// 业务层只依赖本接口；docker 接触面在 dockerArchive.ts（getArchive/putArchive/exec），
// 测试注入内存 fake（接缝 #2）。所有方法抛 files 域异常（errors.ts）：
// 不存在 → FileNotFound、已存在（create）→ FileExists、路径语义非法 → FileInvalidPath。
//
// 现役消费面（T0 #801 + #858 后）：
//   - files 域 = root=lab 沙箱只读 GET 面（readLab/readLabBytes，经 files/routes.ts）；
//   - 附件下载字节通道（readLabBytes，#780 AttachmentsService 复用同一 archive 实例）；
//   - wiki 域 REST 写面（#784 显式容器名三方法，经 wiki/dockerFs.ts）。
// legacy fleet 文件树 read/write/create/delete、files/raw 媒体字节通道与 seedWorkspace 灌卷
//（#858 fleet create 流程退役）先后随清退删除。

export interface FileEntry {
  // 相对 root 的完整相对路径（无尾斜杠；目录经 type 区分）
  path: string
  type: 'file' | 'directory'
  size: number
  modified: string // ISO 8601（tar mtime 秒精度）
}

// readLab 的目录分支：列目录/递归 walk 的结果。
export interface DirListing {
  kind: 'dir'
  path: string
  files: FileEntry[]
  // 条目数超 WALK_LIMIT 截断 → true（递归 walk 与超大直接子项列表都可能触发）
  truncated: boolean
}

// readLab 的文件分支：仅文本返回内容；二进制（NUL 嗅探）与超大文件（> MAX_FILE_READ_BYTES）
// 不返回内容（content: null + 对应标志），接口不被大二进制拖垮。
export interface FileReading {
  kind: 'file'
  path: string
  content: string | null
  size: number
  modified: string
  binary: boolean
  oversized: boolean
}

export interface FileArchive {
  // root=lab 沙箱只读读面：dockerName = 沙箱容器 docker 名原文（researcher-sandbox-<sessionId>，
  // 由路由层从 Session 解析派生——sandboxContainerName 单一来源），树根固定 /lab（SANDBOX_LAB_ROOT），
  // 根条目是目录 → dir 分支（recursive=true 递归 walk）；文件 → file 分支。路径不存在 →
  // FileNotFound；symlink 根条目 → FileInvalidPath。沙箱未创建/容器不在 → getArchive 404 →
  // FileNotFound（60040）——读面不触发惰性创建（创建归 runner ensure，#766 D5）。
  readLab(dockerName: string, relPath: string, recursive: boolean): Promise<DirListing | FileReading>
  // #780 沙箱字节读通道（附件下载端点）：与 readLab 的 file 分支同探针/收集路径，但**不做 NUL
  // 嗅探与 UTF-8 转码**——直接返回 entry.data Buffer（/lab/uploads/<attachmentId>/<原文件名> 的
  // 图片/音视频字节透传）。dockerName = 沙箱容器 docker 名原文；树根固定 /lab。超大（>
  // MAX_FILE_READ_BYTES）/ 非文件条目 → FileInvalidPath。
  readLabBytes(dockerName: string, relPath: string): Promise<Buffer>
  // ---- 显式容器名写面（#784）：wiki 域 REST 挂 wiki 容器（researcher-wiki-<ownerId>，树根 /wiki）
  // ——不套前缀、树根直给。语义：probe 守卫 / mkdir -p / rm -f 只删文件 ----
  writeInContainer(dockerName: string, absRoot: string, relPath: string, content: string): Promise<void>
  createInContainer(dockerName: string, absRoot: string, relPath: string, content: string): Promise<void>
  deleteInContainer(dockerName: string, absRoot: string, relPath: string): Promise<void>
}
