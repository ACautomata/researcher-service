// runner backend MIME 表（#747·02）：逐字段镜像 deepagents@1.14.1 MIME_TYPES（langsmith chunk
// 原文）——镜像非临时替身：容器内文件由控制面判 mime，基座升级时按上游核对本表。
// 判定规则同官方：未知扩展名 → text/plain（源码类一律 text/plain 系表内显式项）；
// isTextMimeType 白名单 = text/* + application/json + application/javascript + image/svg+xml
// （grep 跳过二进制、read 二进制返回 Uint8Array 共用此判定）。

const MIME_TYPES: Record<string, string> = {
  // 媒体类（二进制——read 返回 Uint8Array，grep 跳过）
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
  '.3gpp': 'video/3gpp',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 文本类
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.xml': 'text/xml',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.rb': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.h': 'text/plain',
  '.hpp': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.sh': 'text/plain',
  '.bash': 'text/plain',
  '.zsh': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.log': 'text/plain',
  '.sql': 'text/plain',
  '.graphql': 'text/plain',
  '.proto': 'text/plain',
  '.r': 'text/plain',
  '.swift': 'text/plain',
  '.kt': 'text/plain',
  '.kts': 'text/plain',
  '.scala': 'text/plain',
  '.dart': 'text/plain',
  '.lua': 'text/plain',
  '.pl': 'text/plain',
  '.pm': 'text/plain',
  '.php': 'text/plain',
  '.ex': 'text/plain',
  '.exs': 'text/plain',
  '.erl': 'text/plain',
  '.hs': 'text/plain',
}

export function getMimeType(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : ''
  return MIME_TYPES[ext] ?? 'text/plain'
}

export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'image/svg+xml'
  )
}
