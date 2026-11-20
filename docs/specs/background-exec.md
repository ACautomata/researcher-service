# 后台 Shell 执行

用户确认的边界：当前会话（含 teammate）的后台任务面板，不提供跨会话总览。

## 时间与资源

模型的 `execute` 工具通过原有审批后，由 `BackgroundExecService` 装饰 backend 的
`execute` 方法。保留工具 start/end 事件、文件日志工具身份和原有审批顺序。
内部 mkdir、文档提取等 Docker 原语不采用后台化策略。

| 配置 | 默认 | 语义 |
| --- | --- | --- |
| `EXEC_FOREGROUND_MS` | 600000 | 前台等待上限，到期返回 taskId，ReAct Loop 继续 |
| `EXEC_HARD_TIMEOUT_MS` | 86400000 | 独立进程硬超时，从命令启动起计；不因转后台或重启控制面重置 |
| 每会话并发 | 4 | 与该会话所有 teammate 共享，包含尚未转后台的执行 |
| 单任务日志 | 20 MiB | stdout/stderr 各保留前 10 MiB，后续字节持续排空，不阻塞命令 |
| 模型结果 | 50000 字符 | 两个流各最多 25000 字符，明确截断并提示查询工具 |

两个时间参数均为正整数毫秒，独立设置。硬超时小于前台阈值时，命令先按硬超时结束。
命令沿用容器默认工作目录；supervisor 的工作目录不泄漏给用户命令。

## 运行与恢复

任务身份由 threadId、原 runId、toolCallId 派生，先写 SQLite `background_execs`，再通过
Docker detached exec 启动沙箱内 supervisor。原子 mkdir 是重复启动围栏，控制面重放
同一个工具调用只接管已有命令。启动应答不确定时保留可查询记录，由轮询协调恢复。

supervisor 使用 `setsid` 创建进程组，FIFO 有界保存日志，独立 watchdog 执行硬超时；
取消和超时均终止该进程组。沙箱镜像必须提供 `sh`、`setsid`、`head`、`mkfifo`、`kill`、
`sleep` 等 BusyBox 基础命令。主动自行脱离进程组的程序不属于可取消进程组，沙箱删除会
最终回收整个容器的进程。

每个待交付任务同时保存该线程最新 Loop 的命令和收尾状态（用户新轮次、审批恢复也更新）。
若重启时该 Loop 尚未收尾，则保留其 runId 从 checkpoint 恢复，并以独立、确定性的恢复
队列 job ID 去重，避免在待执行工具节点上插入新轮次。任务原 runId/toolCallId 始终保留。

控制面重启不终止沙箱进程。任务表、沙箱输出和退出标记支持重新接管；运行中的任务持续
touch 沙箱，避免闲置清理。容器启动代次变化、进程消失或容器删除时标记中断，不自动重跑
用户命令。沙箱/宿主重启不承诺进程续跑；已落库的输出保留。

任务状态：starting、running、succeeded、failed、timed_out、cancelled、interrupted。
结果交付状态独立：pending、delivered、suppressed。delivered 表示已进入持久化模型上下文，
不等同于模型已成功处理完毕。任务及持久化结果随会话保留、随会话删除级联清理。

## 结果交付与会话操作

- Loop 运行中：beforeModel 在下一模型调用前追加带确定性消息 ID 的结果，注明它是工具输出。
  checkpoint 中已有该 ID 时仅确认交付，不重复追加。
- Loop 正常结束：使用原有串行 RunService 和 BullMQ 队列提交确定性 ID 的续跑命令。
  持久化结果在提交前存在，失败重试或控制面重启不会重跑 Shell 命令。
- 审批 interrupted/suspended：结果保持 pending，不自动批准、不自动 resume；用户恢复后消费。
- 用户停止：先终止正在执行的主/teammate Loop，再抑制未交付结果并终止后台任务。
  后续用户请求不会重新注入被抑制的结果。
- 回退：在锚点有效性检查之后、回退写入之前，取消当前会话的后台执行并抑制旧结果。
  `chat/files/all` 三种 scope 均先停止后台写入；Shell 已发生的文件副作用仍遵守现有降级语义。
- 删除：沿用非终态 Run 门禁；取消后台进程成功后才删沙箱和会话数据。
- fork：不复制任务记录；仍有后台进程写入时拒绝分叉，避免复制变化中的沙箱。

## 查询与前端

全部 REST 经认证和 owner 校验；不存在与越权均返回 50002，沿用全局响应信封。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/v1/sessions/:id/background-tasks` | 当前会话及 teammate 的后台任务元数据 |
| GET | `/api/v1/sessions/:id/background-tasks/:taskId?offset=0&limit=16384` | 状态、退出码、stdout/stderr、nextOffset、截断标记 |
| POST | `/api/v1/sessions/:id/background-tasks/:taskId/cancel` | 空对象请求体，终止任务并抑制交付 |

offset/limit 使用 UTF-16 字符索引，同时作用于两个输出流；limit 最大 16384。
模型工具 `background_exec_status` 提供同样的会话隔离读面，无 taskId 时列任务。
SSE `background_exec.updated` 只发送任务 ID；REST 是重连后的权威来源。

`useBackgroundTasks` 负责 REST、SSE 刷新和 3 秒轮询补偿；`BackgroundTasksPanel` 为
props/emits 展示组件。切换会话和卸载会使在途旧响应失效。面板显示命令、执行者、耗时、
状态、交付状态、退出码及分页输出；日志按文本渲染，不解释 HTML。

## 验证

`backgroundExec.test.ts` 使用真实 SQLite、checkpoint、ReAct 图和 fake Docker 接缝，验证
前后台转交、重放、恢复、并发限制、取消、结果注入、审批保持及认证查询。
`backgroundExecDockerSmoke.test.ts` 是真实 Docker 门控测试：supervisor 接管、输出限额、
超时进程组终止、取消和容器重启检测。无 Docker 时必须报告跳过，不能以 fake 测试替代
真实进程验证。数据库版本 19 为 additive 变更，升级脚本可幂等重跑。

回滚代码前应先清空或取消活跃后台任务；旧版本控制面不会接管任务表中的执行。
