# #1078 历史多目标读取、长消息续读与版本失效验收记录

## 已确认事项

- 用户明确启动 implement 技能实施 [#1078](https://github.com/ACautomata/researcher-service/issues/1078)（RF-T02），授权代理决定实施接缝与任务拆分。
- 范围为 RF-T02：分段读完一个或多个历史会话，在长消息、重叠上下文、部分失败及来源变化下仍得到连续、可定位且不混版的证据。
- 测试接缝沿用票内决议：真实临时 SQLite + 公共 `execute` 口、真实只读适配器；长消息与正则边界由纯匹配器测试补充。既有 `sessionsApi` / `neutralExport` / `sessionsReducer` 回归不改动。
- 生产组合根仍不注入历史能力；两个新工具继续等待 RF-T12 完整发布门禁。

## 实现边界

- `sessions/history` 新增 `cursor.ts`：服务级不透明书签注册表（owner/调用会话/原条件/绝对 30 分钟到期；每用户 4、全局 64、单状态 256KiB 元数据；重启即失效；续读复用同一书签且不延长到期）。
- `SqliteHistoryReader` 改为 `sessions()` + `scan()`：会话冻结候选含变更版本与消息上界，候选超过冻结上限时返回 `limited`；扫描支持 `after/before/beforeInclusive/upTo`、turn 范围、消息时间、消息数与字节预算。授权与读取仍在同一只读连接事务内。
- 历史变更版本由 `prisma/history-triggers.sql` 维护：消息 UPDATE/DELETE、归档行 INSERT、会话 `archivedAt/isTeammate` 变化与业务写入同事务递增；普通消息追加、标题与模型设置不递增。版本表无外键（会话级联删除时触发器守卫父行存在），会话删除触发器清理版本行。
- `service` 负责分页、目标状态、局部失效、响应字节计量与长区域分段调度；`evidence` 提供按区域连续片段；`matcher` 增加分段字面匹配与 regex 单字段上限。
- Result 增加 `cursor` / `cursor_expires_at`，`progress` 支持 `complete/more/stopped`，group 状态支持 `pending/reading/complete/incomplete`，证据增加 `segment` 与 `attached_fields`。

## 验收映射

| 测试 | 本票覆盖 |
|---|---|
| `sessionsHistoryPaging` | C7–C8、O1–O21、P9/P11/P12、B1–B3/B7–B10/B13–B18、M7/M9：多目标顺序与状态、分页推进、长消息连续重组与跨段命中、上下文重叠合并与跨页命中前上下文、冻结候选、追加不变/旧内容变化/删除/归档插入/rewind 清理/fork 复制、书签绑定/到期不续期/重启、注入预算边界、候选会话冻结上限、regex 字段上限、目录排序与空会话回退、中文短词与聚合外字段不命中 |
| `sessionsHistoryService`（更新） | P2/P3/P5、P8/P9/P15–P19、C2/C3/C5/C6/C12、M3/M5/M6：真实 SQLite 权限、损坏聚合、日志白名单、只读连接；分页失败改为 `more` + 可续读书签的契约 |
| `sessionsHistoryParams` | C9/C11/C13/C14、G10、B15/B17：schema 白名单、时间与范围、正则语法 |
| `runnerHistoryAssembly` | G1–G5、P13：真实 Leader 图装配、免审批、子助手排除 |
| 既有 `sessionsApi` / `neutralExport` / `sessionsReducer` / `approvalFunnel` / `pluginsRegistry` | 共享产品解析与审批/注册外部契约回归 |

## 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过。
- 历史参数/业务口/分页/图装配 + runnerHistory：5 文件 95 测试通过。
- 共享回归（sessionsApi、neutralExport、sessionsReducer、approvalFunnel、pluginsRegistry）：5 文件 125 测试通过。
- `npm test` 全量：182 文件中 176 通过、19 跳过；失败为 5 个需真实 docker daemon 的 smoke suite，以及退役术语扫描扫入既有未跟踪工作区目录（`.scratch`/`.zcode` 等），与本次改动无关。
- 未运行真模型评测或容器化人工冒烟，不声称完整历史合同或生产发布门禁通过。

## Code review 双轴结论与修复

- Standards 轴：无硬性违规；采纳并修复重复的 scan/budget 包装（统一 `BudgetedScanner`）、重复书签保存分支（`issueCursor`）、重复的默认值（`matcher` 常量单源）、未使用的 `scan.next`、状态联合类型重复；更新 `server-modules.md` 与 `constraints.md` 的模块/测试接缝说明。
- Spec 轴指出并修复：跨页续读的 before 上下文取错（新增 `beforeInclusive` 尾部窗口）、候选会话 1000 上限静默截断（`sessions()` 返回 `limited` 并显式停止）、搜索续读对未开始的变化会话语义（现在给出 `changed` 标记）、空页待扫描进度应为 `more`（已按 I2 修正）。
- 补充测试：M7 删除/归档插入/rewind 批量归档/fork 复制、B14 全平台容量与状态大小、B13 绝对到期与不续期、B18 候选冻结上限、O11 目录排序与空会话回退、C8 跨页上下文、O20 控制字段保留。

## 后续接续与发布门禁

- RF-T03：独立 Worker/进程及原生查询硬终止、在飞取消、共享并发与状态容量、持久主请求额度及恢复、正式日志装配。当前分页与扫描仍为同步只读连接；`stopped` 只表示本次调用限额。
- RF-T12：完整 C/O/P/B/M/G 集合、真实模型及容器化人工冒烟、正式生产装配。
- 原地图“92点”与矩阵编号求和的差异沿用 #1077 决议：以实际完整 ID 集合为准。
