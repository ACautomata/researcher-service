// 附件域常量（#780 · #747 G 节「附件与文件 rewind」D1–D6 定案）。
// 单一来源：尺寸/件数上限、控制面临时区目录名、沙箱内物化根。

// D6：单文件 ≤100MB（性能门不达标则砍——C7 基准入 S4）。
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024

// D6：单消息 ≤4 附件（无 per-user 配额，usage 采数后加）。
export const ATTACHMENTS_PER_MESSAGE_MAX = 4

// 控制面临时区目录名（<fleetRoot>/attachments/<attachmentId>）：REST 上传收字节落此（#780 D5
// 修订「REST 不直写沙箱」），ingestion 节点（片 2）读此校验 sha256 后物化进沙箱 /lab/uploads/。
export const ATTACHMENT_TMP_DIR = 'attachments'

// 沙箱内物化根（/lab/uploads/<attachmentId>/<原始文件名>，ID 子目录结构性防同名碰撞——D1）。
export const ATTACHMENT_LAB_UPLOADS = '/lab/uploads'

// 沙箱路径 → readLab 相对路径（readLab 树根固定 /lab）。
export function labUploadRelPath(sandboxPath: string): string {
  return sandboxPath.replace(/^\/lab\//, '')
}

// 原始文件名净化（上传/媒体建行共用）：沙箱物化路径 `/lab/uploads/<id>/<fileName>` 由 fileName
// 拼入——路径分隔符 / NUL / 前导点（`..` 穿越）一律替换/剥除，防逃出 uploads 目录；空结果回退
// 'file'（结构性防同名碰撞由 ID 子目录保证，文件名本身只作展示与落点）。
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\\u0000]/g, '_').replace(/^\.+/, '')
  return cleaned === '' ? 'file' : cleaned.slice(0, 255)
}
