# #1037 正常轮次的下一步提示贯通：实现与验收

日期：2026-11-19（Asia/Singapore）。来源：GitHub [#1037](https://github.com/ACautomata/researcher-service/issues/1037)，功能与默认值以父规格 [#1036](https://github.com/ACautomata/researcher-service/issues/1036) 为准。

开发分支：`codex/1037-next-step-suggestions`；基线：`1138aab5af134f375eb5dac03e0c03aaf0ba7099`。本次只交付 #1037 切片，未合并、未部署。

## 实现

- 普通主对话接纳时，在用户消息落行事务内推进提示版本并清空当前提示；命令携带捕获的版本及用户原文。附件校验或入队失败时按版本条件恢复此前提示状态。
- 回复落行返回精确的回复 id。主运行正常完成且活跃路径处理后，将同轮已解析模型句柄、用量回调和来源交给独立建议调度器，不等待生成结果，不创建新 agent run，也不复用主运行取消信号。
- 仅输入本轮用户原文与最终答复；两者合计至多 12,000 个 Unicode 码点，短侧额度让给长侧，超长侧保留头尾并计入截断标记。调用设置 512 token 输出预算；结果经共享 Zod 校验，空结果跳过，非法结果不截短冒充合法输出。
- 独立调用总预算 10 秒，AbortSignal 透传传输。每用户一个运行中、一个最新候选；全局最多四个运行中、64 个候选，等待最多 10 秒。运行槽在实际调用结束后才释放。来源哨兵防重复生成，版本/归属/回复未归档/活跃路径检查和保存处于同一事务。
- 会话投影增加 `suggestionVersion` 与可空 `nextStepSuggestion {text, runId, messageId, version}`；保存后复用 `session.updated {projectionChanged:true}`。提示单独存储，不改回复聚合、附件或检查点。
- 空输入且可编辑时，以清晰的浅灰占位文字显示提示。普通 Tab 通过事件交给会话编排采用，焦点及光标留在末尾；采用不发送。已有文字不被覆盖，清空后可重显。明确发送拒绝后重拉权威投影，恢复仍有效的提示。
- SQLite schema v18：增加提示版本、可空提示数据及来源哨兵；启动增量升级和初始化共享幂等过程，旧行默认无提示。

## #1037 验收证据

| 任务单验收项 | 自动化证据与结果 |
| --- | --- |
| 保存后交接，来源绑定会话/运行/回复/捕获版本 | `sessionsApi.test.ts` 延迟模型用例检查认证投影中的来源；通过 |
| 建议未返回时主运行已结束，可发送下一条 | 同文件在第一条建议未返回时发送第二条请求，确认成功接纳；通过 |
| 只含本轮可见文本、使用本轮模型、无工具、允许空结果 | 外部模型接缝检查输入及工具缺省；正常空结果不显示；通过 |
| 上下文、输出、取消及有界调度 | `nextStepSuggestion.test.ts` 锁定 Unicode 节选与输出契约；认证入口验证 512 token 配置及真实 10 秒传输取消；通过。完整负载矩阵留给 #1039 |
| 保存不改主回复，新请求拒绝旧结果 | 认证投影检查正文保持原文；新版本使迟到结果写入失败；请求校验/入队失败保持旧提示；通过 |
| 认证投影恢复与完成后更新通知 | `sessionsApi.test.ts` 与 `useChatSession.test.ts` 验证迟到提示恢复；通过 |
| 灰字与基本 Tab 采用 | `ChatComposerSuggestion.test.ts`、`ChatView.test.ts` 真实 textarea 键盘事件确认仅采用、可编辑、光标末尾、点击发送才提交、已有草稿保护；通过 |
| 旧数据、旧投影、接口说明与信封兼容 | `schemaUpgrade.test.ts` 验证 v17 旧行升级及重跑保留数据；前端无字段清空提示；OpenAPI 与路由文档同步；通过 |
| 已确认测试接缝贯通 | 认证消息入口使用真 SQLite、RunService、归属/版本判断，仅外部模型与沙箱原语替身；前端经真实 ChatView/Composer 验证投影通知到 Tab 与编辑发送；通过（分层集成） |

## 检查结果

测试环境为本机 Node/npm、临时 SQLite、Vitest/jsdom；未调用真实收费模型，未启动控制面或部署服务。

- `cd server && npm run typecheck`：通过。
- `cd server && npm test`：执行了全部 173 个文件；发现本次引入的旧模型夹具兼容问题后已修复。四个 Docker smoke suite 和一个既有退役扫描失败的环境原因见下节。
- 最终服务端复跑：`npm test -- --exclude test/dockerArchiveBackendSmoke.test.ts --exclude test/sandboxSmoke.test.ts --exclude test/wikiContainerSmoke.test.ts --exclude test/wikiDocsPortSmoke.test.ts --exclude test/openclawRetirement.test.ts --poolOptions.forks.maxForks=2 --poolOptions.forks.minForks=2`：168 文件通过，1,834 项通过、3 项按既有条件跳过，耗时 174.88 秒。之前四并发复跑出现一次 `chaoxingTools.test.ts` 的 `ECONNRESET`；该文件单独复跑及最终两并发套件均通过。
- `cd frontend && npm test`：82 文件、967 项全部通过。
- `cd frontend && npm run build`：Vue 类型检查、Vite 构建及 admin 产物隔离检查通过。
- `git diff --check`：通过。

## 代码审查

Standards 轴：发现的 turn 分配重复逻辑已收敛为事务客户端上的 `insertNextTurn`，三条落行路径共用；复核无遗留问题。

Spec 轴：补全 Markdown 包装拒绝，并修复确定性发送拒绝后的提示恢复；均有回归用例，复核无遗留问题。

## 后续验收边界

- 本次没有把 #1038 的跨会话/乱序投影/回退完整竞态矩阵、#1039 的全部触发范围与负载矩阵、#1040 的快捷键和可访问性完整回归标为完成。
- 真实浏览器输入法/焦点走查与八场景真实模型质量终验尚未执行，保留给 #1041；jsdom 键盘测试不替代真实浏览器终验。
- 完整服务端首次执行暴露四个 Docker smoke suite 因 daemon 不可用失败（`ENOENT /var/run/docker.sock`）。本机 `docker info --format` 在连接失败时仍返回退出码 0，使既有探测误判可用；本次未修改不相关的探测器。
- `openclawRetirement.test.ts` 的全仓叙述扫描命中已有、被忽略的 `.zcode/workflow-drafts/…`、`.zcode/workflow-runs/…`、`.zcode/workflows/…` 和 `server/.zcode/workflow-runs/…` 四个工作流文件。本次未修改这些文件或放宽退役检查。
