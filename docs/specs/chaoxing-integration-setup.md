# 超星接入配置与联调

## 当前交付与限制

平台已提供账号设置绑定/解绑、OAuth 授权码回调、令牌加密、刷新、MCP Streamable HTTP 客户端、只读学习工具、可选会话课程范围及自动推荐提示。

真实账号绑定已有用户确认；2026-10-23 通过现有管理台进行了本人授权的真实目录检查，但返回 90003，尚未取得 MCP 工具清单。下面的工具映射是一种部署适配契约，不是对超星实际工具名称或字段的断言。当前不能宣称真实课程、正文与链接已可用；映射为空时允许检查目录，学习工具明确报告缺少课程发现能力。

## 2026-10-23 HTTP 接口接入更新（#1009）

超星随后明确“不涉及 MCP”，提供 `/openapi/coursedata/searchCourseDataJson` 和 `/openapi/qbank-educlaw/topic-list`。默认 `CHAOXING_TRANSPORT=openapi` 改为直接 GET 这两个固定 HTTPS 地址，沿用平台现有 OAuth 绑定及刷新，不执行桌面 skill，不调用创建知识点接口。`CHAOXING_TRANSPORT=mcp` 仅保留给另行核验的 MCP 部署，只有该模式消费 `CHAOXING_MCP_MAPPING`；默认模式不再尝试 MCP 初始化。生产 CD 支持同名 repository variable。

请求参数和返回字段来自原技能包说明，尚待新网关实测；“其他信息不变”不能代替 OAuth token 与新入口兼容性的证据。没有改用共享 API Key，也没有要求用户公开凭证。

- `GET /capabilities` 在 HTTP 模式只返回本地固定端点、`transport=https-json`、拟用 `authentication=oauth-bearer`、`callVerified=false` 和缺失能力；`tools/capabilities` 为空，不发送探测请求、不证明远端已接受授权。
- `POST /learn` 需显式 `courseId`。`target=resources|all` 还需 `classId`，固定 `ut=s`，不接受教师身份覆盖。`target=topics` 不需要班级。参数不能猜测；超星尚未提供课程/班级发现接口，`GET /courses` 和设置课程范围明确报告缺失能力。
- 资料 GET 参数为 courseId、classId、ut、dataName、pageNumber、pageSize；空关键词核对仍显式发送 `dataName=`，最多50页。零命中重试一次后全量核对，并保留相关名称；过滤文件夹。知识点仅 GET topic-list、遍历 subList、过滤分类，不运行“查询不到自动新建”。
- 每次查询45秒总时限、实际单响应最多2MB、知识点最多5000节点，最多展示50项；达到处理上限明确提示不完整。上游业务拒绝、结构错误均失败，不当成空列表。只保留实际返回的安全 HTTPS url，不拼接下载链接；没有已验证正文接口，结果仅作目录推荐。课程名称未取得时显示课程 ID，不编造名称。
- 401清理本次旧绑定，403保留绑定。错误仅含静态文案、httpOperation 和 HTTP 状态，不回传上游正文或凭证。

新 HTTP 接口没有课程列表/正文契约，且本轮用户确认未提供测试课程或班级 ID。因此不能把本地回归作为真实学生查询验收，#1009 继续保持未完成。下文 MCP 映射章节仅适用于显式 MCP 模式。

## 手动命令

用户已要求保留自动推荐并补上手动斜杠入口。现有菜单已登记 `/course-search <关键词>` 和 `/topic-search <关键词>`，后端按命令固定查询目标并直达只读学习服务。

两条命令复用现有平台的授权、会话范围和只读学习服务。接口/工具的查询目标分离、命令发现与失败反馈，以[手动命令增量规格](chaoxing-manual-commands.md)为唯一详细契约。手动入口与自然语言自动推荐须分别验收；真实超星联调完成前，不将平台侧实现视为真实课程已可查。

## 授权准备

1. 配置 CHAOXING_CLIENT_ID、CHAOXING_CLIENT_SECRET、CHAOXING_REDIRECT_URI、CHAOXING_CREDENTIAL_SECRET（至少32字符，独立加密根，随数据库备份安全保管；更换后旧授权无法解密，需要重新绑定）。任一授权字段配置时必须完整配置；全未配置时保留原平台功能，学习入口不启用。
2. 将正式回调地址交超星登记。候选：`https://researcher.acautomata.top/api/v1/integrations/chaoxing/callback`。部署并确认真实域名后再联调。
3. 按超星 2026-10-23 回复，MCP 授权请求使用 scope `statistic:studyai:read`；S256 PKCE 和 token 客户端认证仍需分别核验。默认 CHAOXING_PKCE=true；只有对方确认不支持时配置 false。CHAOXING_TOKEN_AUTH 可为 body（默认）或 basic。
4. scope 更新不会提升既有 token 的权限，刷新 token 也不能视为已取得新 scope。部署后，已绑定用户需在账号设置重新发起绑定并完成授权，再检查 `/capabilities`；不批量清除既有绑定。账号设置发起绑定，由学生在超星登录，授权后返回平台。回调以一次性 state 和同浏览器 HttpOnly/SameSite=Lax cookie 关联，后台不接收学生密码。解绑清除本地授权；尚无已验证的远端撤销协议。
5. 后端 GET `/api/v1/integrations/chaoxing/capabilities`（平台 Bearer 认证）可查看该学生获授权的 MCP 工具与 schema。工具名和参数不要从猜测填入映射，也不要记录令牌。可在现有管理台 `/admin/docs` 展开“超星学习”→“检查本人授权的 MCP 工具目录”→ Try it out → Execute，使用当前平台会话调用，不必导出 token。调试界面自动生成的 curl 含认证头，不可截图或复制到票面。

## MCP 工具映射

CHAOXING_MCP_MAPPING 是 JSON 对象，可配置 courses/search/topics/read 四项。每项包含真实工具名 name 和经人工核验的 readOnlyConfirmed=true。每次连接取得完整工具目录后检查实际调用目标；对端明确声明 readOnlyHint=false 或 destructiveHint=true 时拒绝调用，即使本地已确认只读。缺少声明不代表自动确认只读，仍须人工核验业务语义。平台只调用这四种已配置能力；MCP 目录里的其他工具不交给模型。

- courses：发现本人课程。列表由 itemsPath 指定，字段由 idField/nameField/classIdField 指定。
- search：查询课程资料。参数名用 courseArg/classArg/queryArg/pageArg/sizeArg 映射；列表路径用 itemsPath，条目用 idField/nameField/urlField/textField/typeField 映射。
- topics：已有知识点树查询。支持 subListField；只查询，不调用包中的添加接口。
- read：可选正文读取。参数用 courseArg/resourceArg；正文和链接用 textField/urlField。

默认结果列表路径为 items，字段默认为 id/name/classId/url/text/type/subList；参数默认为 courseId/classId/query/pageNumber/pageSize/resourceId。totalPagesPath 默认为 totalPages；缺失时视为单页。路径用点号访问对象字段，空路径表示根列表；不支持通配或数组表达式。若接口提供不同的分页模型或需要额外身份参数，应新增经核验的适配，不能假称当前映射已支持。

MCP 内容支持 structuredContent，或含 JSON 的 text 内容块；其他响应需实际联调后补适配。链接仅接受工具实际返回的 HTTPS 地址。正文单条截断到12000字符；最多读取5份缺正文的命中资料，其他资料明确提示只有目录。单次自动检索最多10门课程、每类每课程50页、展示50项，达到上限明确告知。限制内的正文作为学习证据，不能作为授权或执行指令。

## 核验报告与安全诊断（#1009）

`GET /capabilities` 成功仅说明本次初始化和完整目录读取完成，不执行 `tools/call`，也不代表任何业务查询已经验收：

- `connection`：SDK 实际协商的 `protocolVersion`、`transport=streamable-http`、`authentication=oauth-bearer`，以及 `sessionMode=stateful|stateless`。不返回会话 ID、令牌或请求头。
- `tools`：完整分页目录中的名称、说明、输入 schema、对端提供的输出 schema 和 annotations。目录可包含写工具，仅用于核验；不把目录直接装配给模型。
- `mappingChecks`：四种映射各为 `not-configured`、`tool-missing`、`not-read-only` 或 `listed`。`callVerified=false` 明确本接口没有实际调用验证；`capabilities` 只列本次目录中存在且未声明写操作的配置项。
- 错误仍为 #312 的 90003 信封；`data.mcpStage` 区分 `initialize`、`tools/list`、`tools/call`。上游 HTTP 拒绝时附 `data.httpStatus`；仅返回静态阶段提示，不返回上游正文、原异常或任何认证材料。401 清理对应旧绑定，403/超时不等同于授权撤销。
- 初始化及单次目录请求上限20秒，目录最多10页；游标停滞或超限直接失败，不将半份目录标成完整。目录缓存只存在于本次 MCP 连接，不能跨用户复用。

真实能力矩阵及后续最小调用步骤见 [#1009 核验记录](chaoxing-mcp-verification.md)。学生授权、拒绝/异常 state、双用户隔离、刷新失败与解绑边界见 [#1008 验收记录](chaoxing-authorization-verification.md)。

## 两个外部技能包的复用

资料检索包：查询参数准备、分页、过滤 afolder、零命中重试和全量核对、50项展示上限已移植到现有 TypeScript 工具链。知识点包：查询和树遍历适配进入 topics，添加分支未移植。原始接口文档保留在 docs/references/chaoxing，作为字段和权限核验材料。

不直接执行 Python，也不恢复 SKILL.md 加载。原包默认教师身份和共享 API Key 不适用于当前学生按人授权方案，不能无条件沿用；当前生产调用使用经映射核验的 MCP，HTTP 脚本若有必要另经授权验证后适配。

## 开发、测试与生产配置

本地纯逻辑测试使用外部传输替身和临时 SQLite；真实控制面按仓库约束使用容器化 dev 栈。CHAOXING_* 环境变量需传入 server 容器。生产 server 通过 compose env_file 接收，CD 支持同名可选 GitHub Secrets：四个授权字段和 MCP_MAPPING；PKCE/TOKEN_AUTH 使用 GitHub Variables。未配置不会影响原平台启动；部分配置无效会启动失败，避免凭证错误被隐藏。

验收真实联调：绑定测试学生 → 检查工具目录并核验只读映射 → 不选课程直接讨论学习概念 → 确认工具真实查询、正文依据、推荐课程出处和链接 → 可选限定/解除范围 → 授权过期刷新 → 解绑后停止访问。

自动测试不能证明模型会在所有学习提问中主动调用工具。自动推荐由 Agent 指导与只读工具配合实现，需用实际模型和代表性学习问题验证；没有实时超星授权时不得将其报告为线上验收通过。

## 发布

改动在功能分支提交，不自动推送或合并。主分支 CI 成功会触发线上 CD；合并前确保回调登记、测试账号、工具映射和凭证已经准备好。

## 本地验证记录（2026-10-22）

- 后端类型检查、构建通过；超星 REST/MCP/工具与真实 Agent 图专项测试通过。覆盖同浏览器一次性回调、跨用户隔离、并发刷新、重新授权与旧刷新竞态、解绑后在飞数据阻断、课程范围切换 run 快照、正文与来源进入模型消息。
- 前端全量78文件/945测试通过，构建及 admin 产物隔离检查通过。
- 后端全量165文件执行：160文件通过，1761测试通过；4个真实 Docker 套件因 /var/run/docker.sock 缺失失败，1项既有退役扫描被本地 .zcode 工作流产物触发。这些文件不属于本功能变更。审查后新增回归测试另行专项通过，未宣称全量全绿。
- 双轴审查：规范轴发现并修复旧刷新误清新授权竞态；需求轴要求的课程快照及跨用户范围变更补充测试。真实模型推荐质量和超星授权数据验收仍待外部条件完成。
