// wiki 域异常族（#335 · 平移 backend/wiki/service.py 的 PageNotFound/PageExists/InvalidPath；
// PageExists 对应物 WikiPageExists 已随 #758 Q3 写面整域退役物理删除，30041 [退役保留] 见 codes.ts）。
// 区别于「异常→HTTP 状态码」旧式：由路由层转译为信封码（30040/90002）。
// Port 实现（DockerWikiFileSystem / 测试 fake）抛此族异常，服务层透传，路由层映射。

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
