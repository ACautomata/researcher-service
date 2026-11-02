# 超星本人课程发现：现有 OAuth 可实施性核对

核对日期：2026-10-26。问题：用户绑定超星后，是否能自动取得本人的课程名称、课程 ID、学生班级 ID，并只输入关键词检索？本记录不包含个人课程参数、姓名或凭证，也未调用未知接口。

## 结论

**产品流程可以实现，但当前没有证据支持“仅靠已绑定的 OAuth 凭证，就能自动同步本人课程”。** 已提供并真实成功的资料检索接口要求先知道课程、班级；仓库的 HTTP 课程发现仍明确未实现。公开资料核对也未找到与当前 `api.chaoxing.com`、`mooc:resource mooc:qbank` 授权匹配的课程列表契约。这是“尚未取得可用契约”，不能扩大表述成“超星没有任何课程列表接口”。[本仓 HTTP 适配](../../server/src/chaoxing/httpClient.ts)、[授权实现](../../server/src/chaoxing/service.ts)、[接口能力清单](../specs/chaoxing-required-capabilities.md)

目前最直接的正式方案是请超星提供当前 OAuth 授权下的本人课程/班级只读接口及成功示例；拿到列表后，后台可以按 `(courseId,classId)` 逐课程查询、合并结果，用户只提交关键词。后台需要处理分页、查询上限、取消、限流、部分课程失败和课程更新，不能将截断列表标成全部课程。

## 已核对的来源与边界

| 证据 | 支持的事实 | 不支持的推论 |
|---|---|---|
| [本仓 `httpClient.ts`](../../server/src/chaoxing/httpClient.ts) | 资料查询固定使用 `/openapi/coursedata/searchCourseDataJson`、学生身份及课程/班级参数；`courses()` 直接报告缺少契约 | 绑定成功后已经能发现全部本人课程 |
| [本仓 `service.ts`](../../server/src/chaoxing/service.ts)、[OAuth 客户端](../../server/src/chaoxing/oauth.ts) | 当前授权/换令牌使用 `api.chaoxing.com/auth/oauth2/...`，用户令牌由服务端加密保存 | 该令牌可替代超星网页 Cookie，或可用于任意其他域名的接口 |
| [本仓第一版真实页面验证](../specs/chaoxing-course-search-v1.md) | 已登录的本人超星网页可以查看课程与资料；课程页面可取得课程/班级参数 | 服务器在没有浏览器登录态的情况下也能调用同一网页，或能自动取得浏览器 Cookie |
| [超星官方：应用方获取授权 access_token](https://auth.open.chaoxing.com/open/doc/list/yluywps0/zpsakobd/asptr23d?custom=null) | 文档描述一种专门的网页授权令牌，要求令牌和后续相关操作留在服务器；它展示的换令牌地址为 `auth.chaoxing.com/sns/oauth2/access_token/v1.0` | 它与当前 `api.chaoxing.com` 接入属于同一套令牌/作用域，或它已提供本人课程列表 |
| [超星官方：获取用户信息接口](https://auth.open.chaoxing.com/open/doc/list/yluywps0/zpsakobd/y4l4kl08) | 文档的用户信息接口涉及 `access_token`、`openid` 等参数和身份字段 | 用户信息响应包含本人的课程与班级关系 |

上述两份官方公开文档由搜索引擎索引可读；本次直接抓取其中一份页面超时。因此只引用其实际可读的令牌/用户信息内容，不声称已穷尽登录后的开发者后台文档或应用授权能力。

## 公开搜索的发现与未确认项

同日通过线上管理台，使用现有本人绑定调用只读 `/api/v1/integrations/chaoxing/mcp-capabilities`：返回 `code=90003`、初始化阶段 HTTP 403、`mcpRejectionReason=unclassified`。没有取得工具目录，也就没有取得可用课程发现能力的证据；不能据此断言 403 的具体原因，或断言超星不存在该能力。默认 HTTP 查询模式未改变，未执行任何 MCP 业务工具。

本次用官方域名限定检索“OpenAPI / OAuth / 课程列表 / 获取学生课程 / mooc:resource”等组合，没有取得当前应用可直接使用的本人课程列表文档。搜索中出现的第三方签到脚本和 Cookie 方案不作为正式接口依据，也没有据此拿当前 OAuth token 试探其他端点。

仍需超星确认：

1. 当前 `api.chaoxing.com` OAuth 是否支持本人课程列表，真实 URL、方法、作用域与学生成功示例；
2. 是否返回课程名称及班级 ID，同一课程多班级如何表示；
3. 进行中、已结束、已退课课程的范围、分页与更新时间；
4. 现有 token 是否已经有权限，是否需要重新授权，以及逐课程资料查询的 QPS/配额。

## 不依赖每次手填参数的过渡实现

即使正式课程列表接口暂缺，也可以增加**按平台用户保存的课程档案**：首次由用户在已登录超星网页中同步/导入自己的课程名称、课程/班级 ID，随后关键词搜索从该档案展开查询。浏览器辅助读取需要明确的交互流程；生产服务器不能因此默认获得浏览器会话，也不需要收集学生密码或复制网页 Cookie。

这是“首次同步/导入后可直接关键词搜索”，与“OAuth 绑定后自动同步”应分开说明。档案只保存课程元数据，实际资料查询仍使用本人 OAuth token，由超星校验每门课程的访问权限；课程档案不能作为扩权凭据。账号重新绑定、解绑或身份变更时，需要清理/重新核验旧档案，避免把旧超星账号课程静默绑定到新身份。
