// runner backend 协议类型（#747·02）：BackendProtocolV2 / SandboxBackendProtocolV2 的本地同形镜像。
//
// 来源：deepagents@1.14.1 dist/agent-CxEdojMv.d.ts 逐字段复制（v1/v2 protocol 区原文）。
// 本票刻意不引 deepagents 依赖：S2 fake 单测零 langchain 面；「@langchain/langgraph ~1.4.18 /
// langchain ~1.5.14 / deepagents ~1.14.1 三包」由 #777 runner 票联动引入，checkpointer 包已由
// #774（persistence/ 持久化双件）先行落地。TS 结构类型天然兼容——runner 票接入时
// 以 `satisfies import('deepagents').SandboxBackendProtocolV2` 一次性对齐断言。
// 基座升级时按上游 d.ts 核对本文件（语义锁定先例同 semantics.ts）。

export type MaybePromise<T> = T | Promise<T>

/** Structured file listing info（deepagents FileInfo 原文镜像） */
export interface FileInfo {
  /** File path */
  path: string
  /** Whether this is a directory */
  is_dir?: boolean
  /** File size in bytes (approximate) */
  size?: number
  /** ISO 8601 timestamp of last modification */
  modified_at?: string
}

/** Structured grep match entry */
export interface GrepMatch {
  /** File path where match was found */
  path: string
  /** Line number (1-indexed) */
  line: number
  /** The matching line text */
  text: string
}

/** Structured result from grep/search operations */
export interface GrepResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** Populated on success and, when the search was cut short, with whatever was found before stopping */
  matches?: GrepMatch[]
  /** True when the search stopped early (hit a match-count cap) and matches is incomplete but valid */
  truncated?: boolean
}

/** Legacy file data format (v1)——读侧兼容形态，本 backend 只产出 v2 */
export interface FileDataV1 {
  /** File content as an array of lines */
  content: string[]
  /** ISO format timestamp of creation */
  created_at: string
  /** ISO format timestamp of last modification */
  modified_at: string
}

/** Current file data format (v2) */
export interface FileDataV2 {
  /** File content: string for text, Uint8Array for binary */
  content: string | Uint8Array
  /** MIME type of the file */
  mimeType: string
  /** ISO format timestamp of creation */
  created_at: string
  /** ISO format timestamp of last modification */
  modified_at: string
}

export type FileData = FileDataV1 | FileDataV2

/** Structured result from backend read operations */
export interface ReadResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** File content: string for text, Uint8Array for binary. Undefined on failure. */
  content?: string | Uint8Array
  /** MIME type of the file, when available */
  mimeType?: string
  /** Total number of logical source lines for a text read, when known */
  totalLines?: number
  /** 1-indexed first source line represented by content */
  startLine?: number
  /** 1-indexed last source line represented by content */
  endLine?: number
  /** 0-indexed offset of the next unread source line. Omitted when content reaches EOF. */
  nextOffset?: number
}

/** Structured result from backend readRaw operations */
export interface ReadRawResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** Raw file data, undefined on failure */
  data?: FileData
}

/** Structured result from backend ls operations */
export interface LsResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** List of FileInfo objects, undefined on failure */
  files?: FileInfo[]
}

/** Structured result from backend glob operations */
export interface GlobResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** Populated on success and, when the walk was cut short, with whatever was found before stopping */
  files?: FileInfo[]
  /** True when the walk stopped early and files is incomplete but valid */
  truncated?: boolean
}

/** Result from backend write operations（filesUpdate 已 deprecated 上游：外部存储恒 null） */
export interface WriteResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** File path of written file, undefined on failure */
  path?: string
  /** 外部存储恒 null（对齐 PoC 与官方 FilesystemBackend） */
  filesUpdate?: Record<string, FileData> | null
  /** Metadata for the write operation, attached to the ToolMessage */
  metadata?: Record<string, unknown>
}

/** Result from backend edit operations */
export interface EditResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** File path of edited file, undefined on failure */
  path?: string
  /** 外部存储恒 null */
  filesUpdate?: Record<string, FileData> | null
  /** Number of replacements made, undefined on failure */
  occurrences?: number
  /** Metadata for the edit operation, attached to the ToolMessage */
  metadata?: Record<string, unknown>
}

/** Result from backend delete operations */
export interface DeleteResult {
  /** Error message on failure, undefined on success */
  error?: string
  /** File path of deleted file or directory, undefined on failure */
  path?: string
  /** 外部存储恒 null（delete() 显式返回；上游型为 Record<string, null>——删除标记以
   * removed path 键 null 值表示，与 Write/Edit 的 FileData 不同型，逐条镜像勿混） */
  filesUpdate?: Record<string, null> | null
  /** Metadata for the delete operation, attached to the ToolMessage（上游同名可选字段补镜像） */
  metadata?: Record<string, unknown>
}

/** Result of code execution（exitCode null = 未能取得退出码） */
export interface ExecuteResponse {
  /** Combined stdout and stderr output of the executed command */
  output: string
  /** The process exit code. 0 indicates success, non-zero indicates failure */
  exitCode: number | null
  /** Whether the output was truncated due to backend limitations */
  truncated: boolean
}

/**
 * deepagents BackendProtocolV2 镜像（deepagents@1.14.1 d.ts 逐方法签名复制）。
 * 本实现覆盖全方法；uploadFiles/downloadFiles 为 V1 继承的可选方法，容器场景
 * 不经 backend 传输字节（附件走 uploads 节点，#747·10），恒省略。
 */
export interface BackendProtocolV2 {
  /** Structured listing with file metadata（目录 path 带尾 '/'，is_dir=true） */
  ls(path: string): MaybePromise<LsResult>
  /**
   * Read file content：文本按行 offset/limit 分页；二进制返回全文 Uint8Array
   * （offset 0-indexed 默认 0，limit 默认 500）
   */
  read(filePath: string, offset?: number, limit?: number): MaybePromise<ReadResult>
  /** Read file content as raw FileData */
  readRaw(filePath: string): MaybePromise<ReadRawResult>
  /** Write content to a file, creating it or overwriting it if it already exists */
  write(filePath: string, content: string): MaybePromise<WriteResult>
  /** Edit a file by replacing string occurrences（replaceAll 默认 false） */
  edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): MaybePromise<EditResult>
  /** Search file contents for a literal text pattern（二进制按 mime 跳过） */
  grep(pattern: string, path?: string | null, glob?: string | null, maxCount?: number | null): MaybePromise<GrepResult>
  /** Structured glob matching returning FileInfo objects */
  glob(pattern: string, path?: string): MaybePromise<GlobResult>
  /** Delete a file or directory recursively（可选方法，本实现支持） */
  delete?(filePath: string): MaybePromise<DeleteResult>
}

/** deepagents SandboxBackendProtocolV2 镜像：BackendProtocolV2 + execute + id */
export interface SandboxBackendProtocolV2 extends BackendProtocolV2 {
  /** Execute a command in the sandbox（本实现固定落 /lab 沙箱容器） */
  execute(command: string): MaybePromise<ExecuteResponse>
  /** Unique identifier for the sandbox backend instance */
  readonly id: string
}
