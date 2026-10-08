# API / 路由

> `AGENTS.md` 的披露参考——新增/修改 REST 端点、错误码或信封行为时查阅本清单。

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
- `/api/v1/models/providers[/<pid>]` — model provider CRUD（#857 归属门改挂 ownerId 零容器行查询；
  #775：事务 = mutation + config_meta version bump 热生效；白名单第一层校验未命中 → 90002 字段级 base_url）。
- `/api/v1/provider-endpoints[/<id>]` — 端点白名单 admin CRUD（#775 · 731 §3.1，origin 精确匹配；
  GET/POST/DELETE，非 admin → 10004）。
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
