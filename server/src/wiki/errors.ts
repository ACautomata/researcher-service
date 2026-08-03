// wiki 域异常族（#335 · 平移 backend/wiki/service.py 的 PageNotFound/PageExists/InvalidPath）。
// 区别于「异常→HTTP 状态码」旧式：由路由层转译为信封码（30040/30041/90002）。
// Port 实现（NodeWikiFileSystem / 测试 fake）抛此族异常，服务层透传，路由层映射。

export class WikiInvalidPath extends Error {
  constructor(relPath: string) {
    super(`非法 path: ${relPath}`)
    this.name = 'WikiInvalidPath'
  }
}

export class WikiPageNotFound extends Error {
  constructor(relPath: string) {
    super(`页面不存在: ${relPath}`)
    this.name = 'WikiPageNotFound'
  }
}

export class WikiPageExists extends Error {
  constructor(relPath: string) {
    super(`页面已存在: ${relPath}`)
    this.name = 'WikiPageExists'
  }
}
