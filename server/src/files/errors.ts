// files 域异常族（#589 · 对齐 wiki/errors.ts 模式）。
// 区别于「异常→HTTP 状态码」旧式：由路由层转译为信封码（60040/90002；
// 60041 FILE_EXISTS 随写面退役，码段保留防复用见 codes.ts）。
// Port 实现（DockerFileArchive / 测试 fake）抛此族异常，路由层映射。

export class FileInvalidPath extends Error {
  constructor(relPath: string) {
    super(`非法 path: ${relPath}`)
    this.name = 'FileInvalidPath'
  }
}

export class FileNotFound extends Error {
  constructor(relPath: string) {
    super(`文件不存在: ${relPath}`)
    this.name = 'FileNotFound'
  }
}
