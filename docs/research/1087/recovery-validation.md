# #1087 恢复与资源治理

## 已确认事项

- 本票范围为完整反思流程的审批恢复、进程重启、取消、关闭与备份恢复一致性。
- 测试接缝沿用真实 SQLite、真实执行器、真实 RunService；分类器和故障通过端口注入。
- 两个新工具继续等待最终完整发布门禁，生产不得提前注入。

## 恢复与关闭

确认前以 owner/message 唯一键持久占位。重放读取已有授权，不重新分类或续期；分类失败或分类中崩溃的消息不重新批准，用户需重新展示并重新确认。占位不保存正文，账号删除同步清理。稳定请求身份使用账本 originRunId/lastRunId 与 checkpoint 的原始 HumanMessage.id 精确关联；不读取最新用户消息猜测。审批中断后重建 RunService、图和反思 runtime，继续消费原 grant。

关闭先取消增强操作，再等待全部在飞操作和真实查询进程退出。进程存活集合独立于执行槽，取消后尚未退出的进程仍属于关闭等待范围；历史检索关闭 Promise 贯通至 runner。SQLite 写连接 busy timeout 为 250ms。

访问事件仅允许 ownerId、operation、category、durationMs；确认日志不含用户原文或草稿。访问日志故障告警后继续已授权操作，提交事件仍与正式写同事务。

## 备份恢复步骤

安全日志由 `reflection-recovery.sql` 与业务变更同事务生成；独立于90天访问事件保留期。备份链存续期间不得截断 `reflection_safety_journal`。日志白名单为 seq、ownerId、kind、objectId、state，禁止加入正文、摘录、用户问题或凭证。恢复库必须保持控制面和 runner 离线。

1. 正常备份使用 `DATABASE_URL=file:/path/live.db npx tsx scripts/reflection-recovery.mts backup /path/backup.db`。脚本使用 SQLite 一致性备份，只发布已上锁产物；保留 lineage 和已有日志前缀。更新至本票 schema 后方可建立受支持备份链。
2. 在恢复停写截点，从最新权威库导出最终完整日志：`DATABASE_URL=file:/path/live.db npx tsx scripts/reflection-recovery.mts export /path/safety.json /independent/final.sha256`。最终摘要必须单独保管为可信停写水位，不得从旧日志重新计算代替。日志必须单独备份，不能从待恢复旧库导出充当最新日志。export 拒绝覆盖已有文件。
3. 离线恢复旧数据库，先运行 schema 升级，再执行 `DATABASE_URL=file:/path/restored.db npx tsx scripts/reflection-recovery.mts replay /path/safety.json /independent/final.sha256`。replay 在读取文件之前持久锁住反思门；文件缺失、最终摘要不匹配、日志断链、lineage不匹配、清理失败均保持锁定。禁止绕过脚本直接开放旧备份。
4. replay 撤销全部旧可消费授权、清理未提交草稿，重放记录删除/账号删除/来源失效，排空 outbox，再解锁。日志不携带新正文，发生版本/状态变化的旧记录保守停用并标记待复核，不把旧内容恢复为有效经验。需重新展示和确认才能管理。
5. 在对外开放前核查：已删除记录、revision、草稿/展示、幂等结果均无正文；失效来源摘录及专属副本已清理；旧 grant 不可消费；游标因进程重启已失效。保留日志文件、停写截点和退出码供核对。没有权威停写截点的完整日志时保持关闭。

日志完整性以权威库停写截点为边界；此机制不证明外部日志来源可信，不提供第三方备份的全副本擦除。原任务继续沿用既有恢复链路。

## 验证接缝

- 真实 SQLite：确认重放不重新分类，分类失败后重启不再批准；真实独立 Node 进程重试未知提交结果；原有提交幂等/撤回/过窗/事件回滚回归。
- 真实 RunService：审批中断后重建图/服务和模型适配器，原 grant 保存恰一条记录。
- 真实子进程：关闭、取消后立即关闭、硬终止与槽回收。
- 真实 SQLite 备份：缺日志/断链封锁，完整日志重放删除，重复重放幂等。
- schema v24 初始化/升级；相关历史查询、来源失效、生命周期及投影/导出回归。

## 本次执行结果

- server typecheck、build、diff whitespace 检查通过。
- 最终关键接缝：4 个文件、50 项通过；包括真实新进程提交恢复、已锁备份/安全日志重放、真实子进程取消后关闭、跨服务审批恢复。
- 广泛回归：188 个文件、2137 项通过。排除 `backgroundExecDockerSmoke`、`dockerArchiveBackendSmoke`、`sandboxSmoke`、`wikiContainerSmoke`、`wikiDocsPortSmoke`（本机无 `/var/run/docker.sock`）及 `openclawRetirement`（本地嵌套 worktree 被全仓扫描命中）。完整测试命令已实际执行并暴露这些环境问题；本票引入的 schema 升级失败已修复并复验。
- Standards / Spec 双轴审查及修复后复审通过，无未解决发现。生产工具仍保持发布门禁，不宣称真模型评测或 Docker smoke 已通过。
