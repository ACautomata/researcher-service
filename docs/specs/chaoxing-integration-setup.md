# 超星接入配置与联调

## 当前交付与限制

平台已提供账号设置绑定/解绑、OAuth 授权码回调、令牌加密、刷新、MCP Streamable HTTP 客户端、只读学习工具、可选会话课程范围及自动推荐提示。

真实超星协议和工具清单尚未授权验证。下面的工具映射是一种部署适配契约，不是对超星实际工具名称或字段的断言。当前不能宣称真实课程、正文与链接已可用；映射为空时允许检查目录，学习工具明确报告缺少课程发现能力。

## 授权准备

1. 配置 CHAOXING_CLIENT_ID、CHAOXING_CLIENT_SECRET、CHAOXING_REDIRECT_URI、CHAOXING_CREDENTIAL_SECRET（至少32字符，独立加密根，随数据库备份安全保管；更换后旧授权无法解密，需要重新绑定）。任一授权字段配置时必须完整配置；全未配置时保留原平台功能，学习入口不启用。
2. 将正式回调地址交超星登记。候选：`https://researcher.acautomata.top/api/v1/integrations/chaoxing/callback`。部署并确认真实域名后再联调。
3. 确认对方接受 scope `mooc:resource mooc:qbank`、S256 PKCE 和 token 客户端认证。默认 CHAOXING_PKCE=true；只有对方确认不支持时配置 false。CHAOXING_TOKEN_AUTH 可为 body（默认）或 basic。
4. 账号设置发起绑定，由学生在超星登录，授权后返回平台。回调以一次性 state 和同浏览器 HttpOnly/SameSite=Lax cookie 关联，后台不接收学生密码。解绑清除本地授权；尚无已验证的远端撤销协议。
5. 后端 GET `/api/v1/integrations/chaoxing/capabilities`（平台 Bearer 认证）可查看该学生获授权的 MCP 工具与 schema。工具名和参数不要从猜测填入映射，也不要记录令牌。

## MCP 工具映射

CHAOXING_MCP_MAPPING 是 JSON 对象，可配置 courses/search/topics/read 四项。每项包含真实工具名 name 和经人工核验的 readOnlyConfirmed=true。平台只调用这四种已配置能力；MCP 目录里的其他工具不交给模型。

- courses：发现本人课程。列表由 itemsPath 指定，字段由 idField/nameField/classIdField 指定。
- search：查询课程资料。参数名用 courseArg/classArg/queryArg/pageArg/sizeArg 映射；列表路径用 itemsPath，条目用 idField/nameField/urlField/textField/typeField 映射。
- topics：已有知识点树查询。支持 subListField；只查询，不调用包中的添加接口。
- read：可选正文读取。参数用 courseArg/resourceArg；正文和链接用 textField/urlField。

默认结果列表路径为 items，字段默认为 id/name/classId/url/text/type/subList；参数默认为 courseId/classId/query/pageNumber/pageSize/resourceId。totalPagesPath 默认为 totalPages；缺失时视为单页。路径用点号访问对象字段，空路径表示根列表；不支持通配或数组表达式。若接口提供不同的分页模型或需要额外身份参数，应新增经核验的适配，不能假称当前映射已支持。

MCP 内容支持 structuredContent，或含 JSON 的 text 内容块；其他响应需实际联调后补适配。链接仅接受工具实际返回的 HTTPS 地址。正文单条截断到12000字符；最多读取5份缺正文的命中资料，其他资料明确提示只有目录。单次自动检索最多10门课程、每类每课程50页、展示50项，达到上限明确告知。限制内的正文作为学习证据，不能作为授权或执行指令。

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
