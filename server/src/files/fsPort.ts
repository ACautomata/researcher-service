// FileArchive Port（#589 · ADR 0012 统一文件 CRUD 底层经 Docker 原语）。
// 业务层（routes/paths）只依赖本接口；docker 接触面在 dockerArchive.ts（getArchive/
// putArchive/exec），测试注入内存 fake（接缝 #2）。所有方法抛 files 域异常（errors.ts）：
// 不存在 → FileNotFound、已存在（create）→ FileExists、路径语义非法 → FileInvalidPath。
//
// 域边界：本 Port 拿「已过 paths.ts 校验的相对路径 + root」，自行拼容器内绝对路径；
// 穿越/绝对路径/反斜杠/NUL 防护在 paths.ts（请求层），二进制过滤与 walk 上限在适配层
// （tar 解析处，内存防护必须发生在数据落地前）。

// 三棵树标识（#776 root 契约）：wiki = legacy 容器 ~/.openclaw/wiki/main（读写面暂留，退役归
// T0）；workspace = legacy 容器 workspace 树（legacy 只读消费值——现存前端 fileTabs 硬发此值，
// 迁 lab 归 #793）；lab = 会话沙箱可写树 /lab（**只经 readLab**，docker 名寻址）。
export type FileRoot = 'wiki' | 'workspace' | 'lab'

// read()/写删面的 root 集 = legacy 容器树（lab 刻意不在其中：lab 面按 sessionId 解析后走
// readLab(dockerName)——read(name,'lab') 会错探 openclaw-gw-<name>/lab，类型层面排除误用）
export type LegacyFileRoot = Exclude<FileRoot, 'lab'>

export interface FileEntry {
  // 相对 root 的完整相对路径（无尾斜杠；目录经 type 区分）
  path: string
  type: 'file' | 'directory'
  size: number
  modified: string // ISO 8601（tar mtime 秒精度）
}

// read() 的目录分支：列目录/递归 walk 的结果。
export interface DirListing {
  kind: 'dir'
  path: string
  files: FileEntry[]
  // 条目数超 WALK_LIMIT 截断 → true（递归 walk 与超大直接子项列表都可能触发）
  truncated: boolean
}

// read() 的文件分支：仅文本返回内容；二进制（NUL 嗅探）与超大文件（> MAX_FILE_READ_BYTES）
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
  // 列目录或读文件（legacy 面：wiki 读写暂留 / workspace legacy 只读消费）：根条目是目录 →
  // dir 分支（recursive=true 递归 walk）；文件 → file 分支。路径不存在 → FileNotFound。
  // symlink 根条目 → FileInvalidPath（不支持读链接）。
  // name = 面板实例名（已过路由层 CONTAINER_NAME_REGEX 校验；适配层转 docker 容器名）。
  read(name: string, root: LegacyFileRoot, relPath: string, recursive: boolean): Promise<DirListing | FileReading>
  // #776 root=lab 沙箱只读读面：dockerName = 沙箱容器 docker 名原文（researcher-sandbox-<sessionId>，
  // 由路由层从 Session 解析派生——sandboxContainerName 单一来源），树根固定 /lab（FILE_ROOTS.lab），
  // 语义与 read() 的目录/文件分支完全同构（复用适配层同一读通道）。沙箱未创建/容器不在 →
  // getArchive 404 → FileNotFound（60040）——读面不触发惰性创建（创建归 runner ensure，#766 D5）。
  readLab(dockerName: string, relPath: string, recursive: boolean): Promise<DirListing | FileReading>
  // 原始字节读取（WebChat 媒体通道，files/raw 端点）：不经 NUL 嗅探/UTF-8 转码，返回文件原生
  // Buffer——与 read() 的「二进制 → content:null」语义互补（read 面向文本投影，readBytes 面向
  // 字节透传，如 workspace 图片）。absRoot = 容器内树根绝对路径（legacy 专用通道，
  // FILE_ROOTS.workspace；T0 退役）。超大（> MAX_FILE_READ_BYTES）/ 非文件条目 → FileInvalidPath。
  readBytes(name: string, absRoot: string, relPath: string): Promise<Buffer>
  // 覆写已存在文件（不存在 → FileNotFound）。写前幂等 start 容器（保 exec mkdir 可用）。
  write(name: string, root: LegacyFileRoot, relPath: string, content: string): Promise<void>
  // 新建文件（已存在 → FileExists）。
  create(name: string, root: LegacyFileRoot, relPath: string, content: string): Promise<void>
  // 删除文件（不存在 → FileNotFound；指向目录 → FileInvalidPath，只支持删文件）。
  delete(name: string, root: LegacyFileRoot, relPath: string): Promise<void>
  // config 写读（#591 · 静态 config，对 #366「宿主 rename + ro bind 热加载」的回退）：
  // 容器内 ~/.openclaw/openclaw.json（home 卷 / bind home 内）的 upsert 写与全量读。
  // 内部机制（models 写盘 / create 渲染落盘），REST 不可达——不扩展 FileRoot 枚举。
  // writeConfig 不依赖 exec/start（putArchive 对 created/stopped 容器可用）→ 支持
  // 「create 容器后写 config 再 start」，首启即读到渲染配置。读不存在 → FileNotFound。
  writeConfig(name: string, content: string): Promise<void>
  readConfig(name: string): Promise<string>
  // 模板 workspace 灌卷（#6xx · named volume 拓扑下 researcher workspace 预填充）：把控制面侧
  // hostDir 目录树递归打成 tar、putArchive 解包进容器内 ~/.openclaw/workspace（覆盖同名路径——
  // 镜像骨架被 researcher 模板取代）。内部机制（createComplete 编排，REST 不可达）；hostDir 是
  // 控制面侧源目录（OPENCLAW_TEMPLATE_DIR/workspace），非容器路径。目录不存在 → 抛错（fail-fast，
  // 对齐「不带病出容器」——与 provision 的 cp 失败同语义）。符号链接不灌（保守跳过）。
  seedWorkspace(name: string, hostDir: string): Promise<void>
}
