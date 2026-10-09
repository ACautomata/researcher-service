# frontend 结构（`frontend/src/`）

> `AGENTS.md` 的披露参考——改 `frontend/src/` 任何模块时查阅本清单。

- `router/index.ts` — 用户面板路由表 + 导航守卫（未登录重定向 `/login`，`auth.hydrate()` 恢复
  登录态；#800 起零 admin 残留——admin 路由整体迁入 /admin/ 子应用）。
- `admin/` — admin 子应用（#800 双面板 MPA）：`main.ts`（组合根 2，复用 @/api/@/stores/ElementPlus）
  /`router.ts`（base `/admin/` 独立路由表 + `decideAdminGuard` 纯函数守卫：未认证确认失效 →
  跨应用跳 /login；瞬态放行交 401 刷新链；非 admin → 回 `/`）/`AdminApp.vue`（运营 nav +
  用户面板回链）/`views/`（账号管理/审计检索/Usage 核算/内容消息/API 文档）。
  产物级隔离：vite 双入口（index.html + admin.html）按 /admin/ 分流（nginx try_files →
  admin.html；dev/preview 由 vite 插件 rewrite），`scripts/verify-admin-split.mjs` 挂入 build
  验证用户 bundle 不含 admin 代码；登录角色落点 admin → `/admin/`（LoginView）。
- `stores/` — Pinia：`auth.ts`（JWT access token + role/mustChangePassword）、`wiki.ts`、`chat.ts`
  （对话页响应式投影：纯 mutation；视图模型类型经 `chat/projection.ts` 再导出）、`fileTabs.ts`
  （会话沙箱 lab 文件 tab，#793 起 root=lab、切会话即换树）。
- `api/` — REST client 封装（`client.ts` 信封解析 + 401 刷新链 + 并发去抖；`sessions/files/wiki/models/users/plugins.ts` 按域；#858 起 containers.ts 客户端随容器管理页退役——files 客户端的 URL 前缀 /api/v1/containers 是 lab 文件面契约保留）。
- `plugins/` — 插件 web 面基建（#788 骨架 + #799 收录）：`api.ts` = definePluginWeb 契约（props 六件 details/input/state/expanded/isPartial/toolCallId + #799 增 stage 可选件——进行态装饰仅实时构造）+ `registry.ts` = pluginComponentFor 查找（未注册走默认工具行渲染零成本回退；挂点 = ToolLine 展开区——#752 §2.4 的「附件卡位」挂载缺数据通道[media 引用无 producer 工具名路由键]，随首个需要的插件再扩）+ `index.ts` = 收录清单（显式 import 各插件 web.ts 一行，现含 autofigure）+ `deps.ts` = #799 vue 运行时依赖桥（#791 plugins 树禁裸包名 import 铁律的前端对称面；type-only import 不受限）。web 面组件本体在仓库根 `plugins/<id>/`（web.ts + components/，vite/tsconfig 双端 include 分工：server tsconfig exclude web.ts+components/，frontend include 之）。
- `chat/` — chat 核心三件套（#793 · #730 §4.1，REST+SSE 换轨；网关协议机/设备配对/升级编排死区已删）：
  `projection.ts`（投影归约器纯函数——`applyEvent` 事件增量 / `fromProjection` 投影行双入口同形状，
  事件聚合语义镜像 server sessions/reducer.ts，一致性由 projection.test.ts 零差异组锁死；#799 增 figure_run.progress 归约——ToolRow.stage 进行态装饰，tool.end 与 run 终态剥落保零差异；#796 增 teammate 分区——`TeamFold`/`TeamMail` 视图模型 + `applyTeamEvent`（teammateId 路由，msgs 复用 applyEvent 同一归约器）/ `teamFoldsFromProjection`（teammates 投影行→分区，mailbox 为 REST-only 面不入事件归约））/
  `useChatSession.ts`（会话编排 composable——发送幂等/门控/断线补偿/审批/slash 系统命令；#796 起 SSE 事件按顶层 teammateId 分流进折叠区，主时间线只挂 leader 发言与产物，teammate run 失败不落 leader 错误横幅）/
  `useEventStream.ts`（SSE 薄封装——原生重连 + seq gap 检测 + 401 经刷新链关流 + session.terminated 停重连；#799 订阅目录增 figure_run.progress）/
  `restOutbox.ts`（#779 story 12 断线排队：sessionStorage 落盘、50 上限丢最旧、按序幂等 flush）/
  `attachments.ts`（采集/校验纯函数，发送经 multipart 上传换 attachmentIds）。
- `views/` — 用户面板视图：`LoginView` / `ChatView`（REST+SSE 编排壳；#796 起 teammate 具名折叠区随消息流渲染）/ `WikiView` / `ModelView` / `PluginsView`（#799 插件目录页——能力可见性唯一入口 + per-user 启用位开关）/ `LegalDocumentView` / `NotFoundView`（admin 页已随迁 `admin/views/`，#800）。FigureEditorView / CategoriesView / MdEditor 已随 #747 回归退役；ContainersView 已随 #858 退役。
- `components/` — `FileTree` / `WikiGraph`（obsidian 风格图谱）/
  ChatView 哑组件族（props-in/emits-out，零协议 import：`ChatSidebar`（会话扁平列表 + lab 文件树）/
  `ChatHeader`/`ChatStream`/`ChatComposer`/`ChatMessageItem`/`ThinkingCard`/`ToolLine`（#799 起展开区接插件渲染注册表——命中交插件组件消费 details，未注册默认输入/输出详情）/`ApprovalCard`/`ApprovalDock`（#796 审批卡具名徽标 teammateName）
  + `TeamFolds`（#796 teammate 具名折叠区——状态八值徽标/审批局部冻结/归档终态/展开轨迹同形状行 + mailbox 追问广播呈现））。

- 模型配置页统一管理平台默认端点只读卡片、六预设 BYOK 表单、模型列表、保存前试连、删除影响面与插件 LLM 指派（含 judge）。API key 编辑留空保持原值；响应只显示掩码或 key_error，不回填明文。
