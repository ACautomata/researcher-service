# 超星 MCP 真实核验记录（#1009）

## 当前状态

2026-10-23：#1009 尚未完成。超星最新回复改为两个普通 HTTP API，不再以 MCP 初始化作为这两个接口的接入前提；见本文末尾更新。平台侧核验报告、静态阶段诊断和只读守卫已补齐；真实初始化、工具目录及最小只读调用未通过，不生成猜测的生产映射。

基线是 master `467610c`（含 #1005）。用户此前确认真实账号可绑定，截图为教师身份；学生账号权限另由 #1008 验收。

## 实际观测

使用现有管理台 `/admin/docs` 的已登录本人会话调用 `GET /api/v1/integrations/chaoxing/capabilities`，没有导出平台或超星令牌。

- 首次观测到 nginx 502，后续请求返回 `90003 / 超星调用不可用，请检查绑定状态、课程权限和工具映射后重试`。
- 同期 `/api/health` 返回 HTTP 200、`code=0`；基线 [CI](https://github.com/ACautomata/researcher-service/actions/runs/39894729966) 和 [CD](https://github.com/ACautomata/researcher-service/actions/runs/39894953061) 均成功。
- 旧错误提示没有阶段信息，因此无法判定错误发生在初始化还是目录读取，也不能据此归因于回调登记、token 权限或 transport 不兼容。不能把“绑定成功”当作 MCP 已初始化成功。
- 未取得工具目录，不曾调用未知工具；未新增或修改生产工具映射，未创建知识点。

## 能力矩阵

| 能力 | 真实工具名及参数 | 返回字段、分页与空结果 | 业务只读语义 | 状态 |
|---|---|---|---|---|
| transport / 协议协商 / 会话 / Bearer 授权 | 尚未成功取得初始化证据 | 待核验报告 | 不适用 | 阻塞 |
| 本人课程及班级发现 | 未取得目录，不填工具名 | 课程/班级身份、分页完整性均待核验 | 待核验 | 阻塞 |
| 课程资料检索 | 同上 | 名称、ID、目录过滤、分页/空值参数待核验 | 待核验 | 阻塞 |
| 已有知识点树 | 同上 | 层级、说明、subList、空结果待核验 | 仅查询；不使用创建工具 | 阻塞 |
| 资料正文读取 | 同上 | 正文、格式、截断限制待核验 | 待核验 | 阻塞 |
| 真实学习链接 | 同上 | 工具实际返回 HTTPS 链接及本人访问性待核验 | 只使用返回值，不拼接地址 | 阻塞 |

## 下一次核验步骤

1. 审查、部署本次诊断改动后，仍用管理台现有 GET `/capabilities` 重试，记录 `mcpStage` 和 HTTP 状态；不复制含认证头的 curl。若失败，按实际阶段向超星确认 transport、协议与本应用授权范围，不能用盲目重新绑定掩盖原因。
2. 初始化和目录成功后，核对真实 `connection`、完整工具目录、输入/输出 schema、required 参数及只读业务语义。目录只读提示是辅助证据；没有明确人工核验不得配置 `readOnlyConfirmed=true`。
3. 对每项已核验能力填写 `CHAOXING_MCP_MAPPING`，经现有 schema 校验。配置前确认目标工具没有创建或写副作用；输入模型与现有映射不兼容时再做最小适配，不预填占位工具名。
4. 以本人授权课程调用 GET `/courses`；按真实 schema 确认课程及班级身份、正常/末页/空列表。默认映射仅支持页号+总页数，不将其他分页模型当成已经支持。
5. 分别以 `target=resources`、`target=topics` 调用 POST `/learn`（只读），验证一条已知命中、一个无命中词、分页、正文和返回链接。只使用获授权数据；资料目标不访问知识点工具，反之亦然。read 映射如需班级等额外参数，先记录并补适配再调用。
6. 本地私下保存必要的原始 schema/响应；入库和票面只记录去除秘密及个人数据后的字段结构与验证结论。更新本矩阵后再判断 #1009 可否关闭，学生权限不能由教师账号的结果代替。

## API Key 与 OAuth token

两个外部技能包走 mooc2 HTTP 网关，其中知识点文档将 Bearer Token 明确称为 API Key，并描述教师权限错误；平台 MCP 客户端走 OAuth 授权后的个人 access token。两者来源、接收端点和权限模型不同，目前没有互换成功的证据。只复用分页、零命中处理和树查询流程，不复制原包凭证，不试探创建接口，不把 HTTP 接口名称当成 MCP 工具名。

来源：[资料检索原文](../references/chaoxing/search-course-data.md)、[知识点原文](../references/chaoxing/get-or-create-topic.md)。MCP 协议行为测试使用已安装 SDK 和外部 HTTP 替身；测试通过不是超星真实验收证据。

## 本轮实现验证

- 后端类型检查通过。MCP 专项12项通过，覆盖协商版本、有状态/无状态会话、完整工具分页、游标停滞、输入/输出 schema、静态错误脱敏和只读声明冲突；授权 REST 专项6项同时通过。
- 后端全量167个测试文件执行：163文件通过、1789项通过、19项跳过；4个真实 Docker smoke 套件均因本机缺少 `/var/run/docker.sock` 在初始化时失败，未将其报告为全绿。
- 规范/需求双轴审查未发现本次增量的代码阻断项；需求轴明确真实 MCP 验收仍未完成，因此保留 #1009 打开。
- 以上均为本地代码及外部 HTTP 替身验证，不是超星真实课程/班级/正文/链接的通过证据。

## 进一步排查：不能仅凭403归责

用户要求再次对照桌面原始技能包。确认本平台硬编码 MCP 地址与对方截图一致；SDK 初始化实际为 POST、JSON-RPC initialize、Bearer 个人 access token、Accept: application/json, text/event-stream，无 Origin 头，SDK 初始提出协议2025-11-25。原包使用 mooc2 HTTP 网关及 CHAOXING_API_KEY，不是 MCP 客户端；没有将其凭证混入平台 OAuth 调用。

本机不带凭证或带明确无效测试令牌的同地址请求返回 APISIX 401，线上真实授权请求返回403。两组请求来源 IP 不同，此对照不能单独证明令牌有效或排除 IP 限制。仍缺少对方支持的认证/协议调用示例，不能宣称客户端兼容性已经实测排除。

发现本平台诊断主动丢弃上游正文，原包却明确列出“URL不在白名单中”的403。补充 mcpRejectionReason 固定类别：url_not_allowlisted、insufficient_scope、origin_rejected、unclassified；仅根据前4096字符匹配固定特征，不回显或保存上游正文。未匹配必须保持未知，不能推断为对端问题。只有真实返回命中固定类别后才记录结论。

## 超星 scope 回复后的修复（2026-10-23，#1009）

超星回复：“这个接口 scope 您配置 statistic:studyai:read，这个试试”。据此将新发起的 OAuth 授权请求 scope 从 `mooc:resource mooc:qbank` 替换为 `statistic:studyai:read`，不叠加未经确认的权限。沿用现有 state、PKCE、令牌认证及只读守卫。

部署后需由本人在账号设置重新绑定、完成新 scope 授权，再通过现有管理台检查 `/capabilities`。旧 token 不会随代码部署获得新权限；刷新成功也不是新 scope 已授权的证据。

本次改动只修正授权请求与操作说明，尚无新 scope 下真实初始化、目录或调用证据，不能断言原 403 的原因已经确定或问题已消失。能力矩阵继续保持阻塞，#1009 保持打开；成功取得真实目录后，按上文步骤核验只读语义及最小调用，再填写映射。

## 最新接口方向：HTTP 只读适配

超星最新回复提供以下地址并说明“不涉及 mcp 不用配置，其他信息不变”：

| 能力 | 固定 GET 端点 | 已知结构 | 实测状态 |
|---|---|---|---|
| 资料检索 | `https://api.chaoxing.com/openapi/coursedata/searchCourseDataJson` | 参数 courseId/classId/ut=s/dataName/pageNumber/pageSize；status/datalist/totalPages | 仅未认证入口401；OAuth学生查询未核验 |
| 已有知识点 | `https://api.chaoxing.com/openapi/qbank-educlaw/topic-list` | 参数 courseId/query；status/data.list/subList | 仅未认证入口401；OAuth学生查询未核验 |
| 课程/班级发现 | 未提供 | 无 | 阻塞；不猜测接口或ID |
| 正文读取、真实学习链接 | 未提供独立契约 | 仅保留查询实际返回的安全url | 阻塞；不拼接地址 |

上述字段来自桌面两个技能包，不是新网关实际成功响应。平台增加固定HTTP适配，沿用本人OAuth token尝试调用，不复制技能包API Key、不运行知识点创建链；请求、错误与输出限制见[配置说明](chaoxing-integration-setup.md)。HTTP能力检查只报告本地契约和callVerified=false，不声称取得真实目录。

用户确认没有提供课程ID、学生班级ID或课程列表接口。尝试连接现有浏览器会话时，两次浏览器tab连接超时；原生Chrome可见本人已绑定，但绑定成功不等于接口授权已验证。未导出令牌，未使用猜测ID调用。缺少真实参数和发现接口，尚无法完成正常/空结果/分页及学生权限验收，#1009不能关闭。旧MCP403记录保留为历史，不能拿它判断新HTTP端点是否成功。
