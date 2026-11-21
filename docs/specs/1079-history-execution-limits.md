# #1079 历史检索隔离执行、硬终止与主请求额度验收记录

## 已确认事项

- 用户明确启动 implement 技能实施 [#1079](https://github.com/ACautomata/researcher-service/issues/1079)（RF-T03），授权代理决定实施接缝与任务拆分。
- 范围为 RF-T03：历史查询在重负载、取消、故障恢复时有真实执行上限，主任务不被后台失控扫描拖住，恢复不重新获得额度。
- 测试接缝沿用票内决议：真实执行器 + 临时 SQLite + 真实 `RunService` 恢复链；硬停止以真实子进程终止证明，不以 `Promise.race` 或 fake 执行器替代。
- 生产组合根仍不注入历史能力；两个新工具继续等待 RF-T12 完整发布门禁。

## 实现边界

- **SQL 单一真源**：`sessions/history/sqliteCore.cjs`（带 `sqliteCore.d.cts` 类型声明）承载授权、候选冻结与扫描 SQL。`SqliteHistoryReader`（进程内）与独立执行子进程共用；`.cjs` 让 `npm run build`（CJS 产物）与 vitest 源目录都能加载，`build` 脚本显式拷贝该文件。
- **独立只读执行器** `executor.ts`（#1082 起子进程与执行槽原语抽到 `utils/leasedProcessPool.ts` + `utils/readonlyProcessChild.cjs`，历史与反思记录检索共用、各自独立池与配额）：每次工具调用独占一条从 `process.execPath` 拉起的子进程，子进程 `readonly: true` 打开可信装配传入的 DB 路径。服务级执行槽：每用户 1、全平台 4，满额返回 `busy`，无队列、无自动重试。2 秒协作时限由业务层逐行检查 + 子进程核心检查；5 秒硬停止由主进程 `SIGKILL`，`child` 的 stderr 不进入响应。取消（`AbortSignal`）同样真实终止子进程并立即释放槽。整套资源在 `dispose()` 关闭。
- **业务层异步化**：`HistoryReader.sessions/scan` 允许返回 Promise；`service.ts` 全链路改为 await。`executionLease()` 由服务持有并在 `execute` 的 finally 释放；协作时限按可信上下文注入，不再依赖挂钟常量。
- **主请求额度** `model.ts` 的 `HistoryRequestBudgetStore` + `prismaLedger.ts`：`requestId` = 可信 `triggerMessageId`（`SessionService.sendMessage` 落行后盖印到 `RunCommand.triggerMessageId`），与可重建的 `runId` 分离。`RunService` 在图构建前经 `history.resolveRunRequest` 解析：`message` 新建账本，`resume/recover` 从持久行沿用；找不到行（或 `requiresRequestIdentity` 下无身份）关闭本 run 的历史增强，不重新发放额度。`RunServiceDeps.history` 由 `Pick<SessionHistoryService,'execute'>` 扩为结构子集（+`resolveRunRequest`/`dispose`）。
- **计量**：`reserve` 在任何解析/执行之前计入调用次数（失败与重试也计入，10 次/主请求）；`settle` 在交付前写入返回字节与等待（30 秒/256KiB，含错误响应）。剩余额度优先于单次上限：单次响应上限取 `min(maxResponseBytes, 剩余字节)`，可用余量不足 1024B 直接明确拒绝；交付前再次按该上限校验，额度计量失败则停止增强。
- **生命周期**：书签注册表增加启动即扫与每分钟 TTL 清理（`cursorSweepMs` 可关），`SessionHistoryService.dispose()` 停定时器、清内存书签并释放执行器；`RunService.dispose()` 联动。
- **日志**：`logging.ts` 提供正式精简访问日志（字段白名单事件对象，无 query/正文/书签）；日志故障只告警，不阻断已授权读。
- **装配**：`history/runtime.ts` 组合执行器 + 账本 + 日志（`createHistoryRuntime`），`runner/assembly.ts` 增加可注入的 `history` 选项；生产 `server.ts` 仍不注入。

## 验收映射

| 测试 | 本票覆盖 |
|---|---|
| `sessionsHistoryExecution`（新增） | B4/B5/B6/B11/B12/B19/B20/B21、M6/M8/M9、G6/G7/G8/G9：真实子进程只读连接与硬终止、取消与槽释放、每用户/全局槽位 busy、主请求次数/字节额度与失败计入、重建不重置、剩余额度优先、书签重启失效、1000 消息性能预算与 64KiB 输出上限、真实 RunService interrupt→resume 链上 `requestId` 延续且 ≠ runId、跨用户隔离、无账本时停止增强、真实执行路径的停止状态回喂与出处可解释 |
| `sessionsHistoryService` / `sessionsHistoryPaging` / `sessionsHistoryParams` / `runnerHistoryAssembly`（回归） | RF-T01/T02 全量历史契约；历史域行为断言未改动（新增 schema 版本 20 的断言更新见下） |
| 既有 `sessionsApi` / `neutralExport` / `sessionsReducer` / `approvalFunnel` / `pluginsRegistry` | 共享产品解析与审批/注册外部契约回归 |
| `schemaUpgrade` / `skillsPackage` / `providerMigration` | 版本断言由 19 更新为 20（`SCHEMA_VERSION` 单源），并断言 `history_request_budgets` 在增量升级路径建出 |

## 验证结果

- `npm run typecheck`：通过；`npx prisma validate`：通过；新表 DDL 与 `prisma migrate diff` 产物逐字节一致。
- 历史 + 图装配 + 共享回归 + schema 版本：11 文件 226 测试通过。
- 新增 `sessionsHistoryExecution`：12 测试通过（含真实子进程 SIGKILL、取消、槽位、额度、重启、64KiB 上限、跨用户隔离，以及真实 RunService interrupt→resume 链）。
- `npm run build`：通过（`sqliteCore.cjs` / `readonlyProcessChild.cjs` / `reflectionCore.cjs` 显式拷贝进 dist；#1082 起）。
- `npm test` 全量：2048 测试中 2028 通过、19 跳过；失败为需真实 docker daemon 的 5 个 smoke 套件，以及在 4 并发 fork 高负载下的 1 个既有偶发超时（`sessionsModelOverride` 单跑通过）；历史相关套件全绿。
- 未运行真模型评测或容器化人工冒烟，不声称完整历史合同或生产发布门禁通过。

## Code review 双轴结论与修复

- Standards 轴：采纳并修复重复的取消判定、共享错误代码映射（`mapHistoryErrorCode`）、执行槽 `leasedOwners`/`maxPerUser` 双机制、额度请求数据对象（`HistoryBudgetRequest`）、执行器子进程脚本外置为 `executorChild.cjs`、`RunServiceDeps.history` 复用 `HistoryRuntimePort`、书签清扫委托冗余、测试里第三用户身份与行版本断言单源。
- Spec 轴：采纳并修复运行时把服务级协作/硬停止时限穿线到执行器；`RESERVE_BYTES` 双重扣减；resume 以 `resumeOfRunId` 精确绑定原主请求账本；补 64KiB 输出上限与 G7 跨用户隔离断言；G8/G9 改为真实执行路径（真实执行器 + 真实账本 + 协作时限）产生停止状态，不再使用预设返回。

## 后续接续与发布门禁

- RF-T12：完整 C/O/P/B/M/G 集合、正式生产装配（`createHistoryRuntime` 接入 `server.ts`）、真实模型及容器化人工冒烟。
- 当前硬停止为 5 秒子进程终止；协作时限 2 秒。若真实数据下性能预算不可达（B21），回规格调整，不静默放宽。
