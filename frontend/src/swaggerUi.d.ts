// #761：swagger-ui-dist 无官方类型（UMD bundle + 纯 CSS）。ambient 声明覆盖本组件用到的
// 最小面（SwaggerUIBundle 初始化参数/返回值），import 置于 declare module 内部（对齐
// chat/markdownPlugins.d.ts 的 script 全局声明惯例）。
declare module 'swagger-ui-dist/swagger-ui-bundle.js' {
  export interface SwaggerUIRequest {
    headers: Record<string, string>
  }
  export interface SwaggerUIOptions {
    // 直接注入已拉取的 spec（不再经 url 二次请求——openapi.json 走 apiFetch 认证链，见视图注释）。
    spec?: unknown
    dom_id?: string
    domNode?: HTMLElement
    // TryIt 请求与 url 加载统一经此拦截（本组件用以注入 Bearer token）。
    requestInterceptor?: (req: SwaggerUIRequest) => SwaggerUIRequest
    responseInterceptor?: (res: unknown) => unknown
    docExpansion?: 'list' | 'full' | 'none'
    persistAuthorization?: boolean
  }
  export interface SwaggerUIInstance {
    // 命令式销毁（组件 unmount 时调用，防 DOM 泄漏/重复初始化）。
    destroy?: () => void
  }
  export default function SwaggerUI(options: SwaggerUIOptions): SwaggerUIInstance
}
