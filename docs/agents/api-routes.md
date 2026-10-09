# API / 路由

> `AGENTS.md` 的披露参考——新增/修改 REST 端点、错误码或信封行为时查阅本清单。

- 交互式接口文档（Swagger UI，TryIt 可直连）与 OpenAPI 3.1 JSON：`/api/docs`（admin-only，
  网页入口走 admin 子应用「API 文档」页）——使用说明见 `server/README.md`「接口文档」章节；
  新增端点必须同步登记 `server/src/openapi/paths.ts`（覆盖守卫 `apiDocsCoverage.test.ts` 双向断言）。

- `GET /api/health`（公开）。
- `/api/v1/auth/*` — 登录/refresh(R1 旋转)/logout/me/password/change + OIDC `oauth/<p>/login|callback`（未配 provider 时 90001）。
- `/api/v1/users` — admin 账号管理（GET / POST / PATCH / reset-password；码段 1xxxx；
  #858 起 GET 载荷不含 containerCount/quota——容器行表退役）。
- `/api/v1/containers` CRUD（列表/新建/删除）已随 #858 整体退役（90005）；该前缀唯一残余 =
  下方 `/:name/files` 只读面。
- `/api/v1/wiki/{tree,page,graph}` — wiki 文件树/读写/图谱，owner 级（#856：归属门
  从容器行解析改为 req.user.id 直派生，零容器行查询，路径 <name> 与容器级 20040 随耦合退役；
  数据源 = 请求者本人的 wiki 容器，每操作前置 ensure——requireAuth 与 path/body 校验之后，
  未授权/非法探测不建容器）。
- `/api/v1/wiki/claims?path=` — 页 claims 旁车只读面（#789 story 42 数据面：
  论断 evidence + 页级漂移 fresh|drifted|null；页缺失 30040、旁车缺失 200+空 claims）。
- `/api/v1/models/{presets,platform,providers[/<pid>[/impact]]}` — LLM 端点域（#857 归属门改挂 ownerId；
  #881 预设制换形：presets = 六预设目录只读、platform = 平台默认端点只读视图（env 派生虚拟实体，
  永无 key 材料）、GET providers/<pid>/impact = 删除前四类引用计数（sessions/plugins/judge/teammates + total，本人归属门）；删除不拒悬挂引用，下一 run 回落平台默认 + warn，在飞快照不变。providers = BYOK 端点 CRUD（preset_id 锁定协议与地址无自由 baseURL；api_key
  单向流——写请求可带明文落库即密文、读只出掩码；事务 = mutation + config_meta version bump
  热生效；保留 id 'platform' 写侧拒绝 90002；40040 不存在/越权同码防探测、40041 pid 冲突）。
- `/api/v1/models/test` — 端点试连（#882：按表单态[预设+key+模型]发起最小代价真实试连——不入库、
  不产生 provider 行、不写日志；1-token 级探测、10s 超时；失败 90003 + 净化错误文本防 key 回显；
  V1 不限流[ADR 记录接受面]）。
- `/api/v1/provider-endpoints[/<id>]` — 端点白名单 admin CRUD **已随 #881 预设制整链退役**
  （表/REST/校验/DNS/逃生 env 全删；40042 常量保留语义退役）。
- `/api/v1/plugins` — 插件目录 + per-user 启用位（#788 · 8xxxx 段：GET 目录清单（manifest 渲染 +
  启用位）、PUT `/{id}/enablement` 幂等 upsert、GET `/{id}/commands/{name}/completions` 参数补全）。
- `/api/v1/plugins/llm-assignments` + `/api/v1/plugins/{id}/llm-assignment` — 插件 LLM 指派
  （#883 T3 · ADR 0016：GET = targets（声明 llm 的插件 ∪ 保留键 'judge'）+ 本人指派行；
  PUT = 幂等 upsert {provider_id, model_id} 双可空（provider_id ∈ 本人端点集 ∪ 'platform'，
  model 须属该端点模型集，90002 字段级；未声明 llm/目录外/非 judge → 80040 同码防探测）；
  DELETE = 撤指派回默认链（无行幂等不 bump）；事务内 bump 配置版本——下一 run 生效，
  在飞 run 不受影响）。
- `/api/v1/approval-logs` — 审批全量审计检索 admin REST（#783 · ADR 0015；过滤
  userId/runId/layer/decision/from/to + 分页；judge 输入只露 hash）。
- `/api/v1/file-overwrite-logs` — 覆盖审计检索 admin REST（#785；过滤 sessionId/path/from/to
  + 分页；行 = 一次 write-after-write 覆盖 path/覆盖者/被覆盖者）。
- `/api/v1/usage/aggregate` — LLM usage 核算聚合 admin REST（#800 · #775 采数数据源；过滤
  userId/from/to，时间窗半开区间 [from, to)；按 user × provider × model 聚合，wire snake_case）。
- `/api/v1/containers/<name>/files?root=<wiki|workspace|lab>&path=&recursive=` — 统一文件 GET（#776
  root=lab 唯一现役读面；#858 容器 CRUD 退役后本端点是 /api/v1/containers 前缀唯一残余——URL 契约
  保留：<name> 为 sessionId，50002 同码防探测，无容器行查询）；root=wiki/workspace（含缺省）→ 60042
  退役码（#858 起无容器行归属前置，name 形状校验后即拒）；写面 PUT/POST/DELETE → 90005；
  binary/oversized 不返回内容）。
- `/api/v1/sessions[/<id>]` — 会话 REST 域（#778：POST 创建/GET 列表/PATCH 改标题/DELETE（级联删
  沙箱）；`/<id>/messages` POST 发消息（`Idempotency-Key` 32-hex header 幂等，重发 replay）+
  GET 历史投影（回放零差异面；#781 起 archivedAt 过滤——被放弃路线行不可读）；`/<id>/abort`、
  `/<id>/resume`；#781 增 `/<id>/rewind`（换 activeCheckpointId 指针重开 + 被放弃路线软删 +
  `session.invalidated{reason:rewind}` 事件）、`/<id>/fork`（新会话复制全件 + 沙箱字面复制 +
  `session.created{source:fork}` 事件）；#782 增 rewind body `scope` 三态（`all` 缺省=对话+文件
  同回[逆放 /lab 至锚点时刻]·`chat`=只回对话[水位推进保持文件现状]·`files`=只回文件[对话投影与
  指针不动]；files 面结果挂 `files` 字段{reverted,skippedMissing,degraded}）+ `/<id>/rewind/preview`
  （逆放摘要 + 锚后 exec 跨越清单——POST 同 body，只读）；
  50002 同码防探测）。
- `GET /api/v1/events` — SSE 事件流（#773，panel_stream cookie 认证，替代 WS 的传输面先行）。

全局 #312 信封：所有 REST 一律 HTTP 200，错误信号在 body `{code,message,data}`；「不存在 vs 越权」
同码防探测（20040/30040/40040/60040）。例外：产物成功路径直发原生字节（`GET /figures/:id/png` 成功
返 `image/png` 字节、`GET /figures/:id/svg` 返 `image/svg+xml` 文本，不包信封、不 base64-in-JSON；
错误面仍走信封）；SSE 流端点（`/api/v1/events`）
连接级认证失败走 **HTTP 401** + 信封体（#726 钉死「不入事件」，EventSource 看不见状态码——REST 刷新链
死信号让路；其余响应仍 HTTP 200+信封）。码段：`0` 成功 · `1xxxx` 通用/鉴权 ·
`2xxxx` 容器（20040–20046 全组 [退役保留] 随 #858 码段防复用）· `3xxxx` wiki ·
`4xxxx` models（40042 端点不在白名单[运行时第二层，仅 runner 侧] · 40043 并发配额已满[per-user
maxConcurrentRuns 或全局 RUNNER_MAX_CONCURRENT_RUNS]）· `5xxxx` 会话/run 域（#747 C 节，
  #776 起 50002 session_not_found；#777 起 50003 审批挂起（#778 补 REST 前置面与码表）；#783 起
  50004 approval_not_found 同码防探测；#778 增（50004 让位 #783，顺移起）50005 run 进行中禁输入·
  非终态拒删 / 50006 无在飞可中断 / 50007 幂等 key 同 key 异 content；#782 起 50008 文件状态
  重放中[写围栏等待超时，报当前持有者]）· `6xxxx` files ·
`7xxxx` figures（AutoFigure，70040 不存在/越权同码防探测（detail/png/svg 三读路径共用归属门）·
70041/70042 [退役保留]（幂等冲突/PNG 未就绪随 #791 创建端点与 GenerationJob 退役，码段防复用）·
70043 产物不可用（渲染失败缺省/产物缺失，PNG/SVG 共用））·
`9xxxx` 系统/校验。
