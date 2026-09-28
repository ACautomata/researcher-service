#!/usr/bin/env bash
# wayfinder chart-the-map：在 ACautomata/researcher-service 创建
# 「LangGraph 替代 OpenClaw」map + 11 张 ticket + sub-issue 关联 + blocking wiring。
# 幂等性：无（重复运行会创建重复 issue）。
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "repo: $REPO"

# ---------- labels ----------
for l in "wayfinder:map" "wayfinder:research" "wayfinder:prototype" "wayfinder:grilling" "wayfinder:task"; do
  gh label create "$l" --color 5319e6 --description "wayfinder $l" >/dev/null 2>&1 || true
done
echo "labels ready"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

new_issue() { # $1 title  $2 label  $3 body-file  -> echoes number
  local url
  url=$(gh issue create --title "$1" --label "$2" --body-file "$3")
  echo "${url##*/}"
}

# ---------- T0 根决策（创建即关闭） ----------
cat > "$tmp/t0" <<'EOF'
## Question

用 LangGraph 生态全面替代 OpenClaw 的根架构决策栈：动机、功能面、运行时基座与拓扑、LLM 调用与配置归属、wiki 集成形态、审批模型、前端协议与老容器退役。
EOF
T0=$(new_issue "根架构决策：LangGraph 替代 OpenClaw（grilling 会话定稿）" "wayfinder:grilling" "$tmp/t0")

cat > "$tmp/t0r" <<EOF
## Resolution（grilling 会话定稿，2026-09-28）

| 决策 | 结论 |
|------|------|
| 动机 | 自主可控（摆脱 OpenClaw 升级受制）+ LangChain 生态能力 + 容器精简，综合驱动 |
| 功能面 | 全面重新设计所有 Agent behavior；审批须重造（安全门），设备配对移除 |
| 基座 | LangGraph JS；deepagentsjs 为基座候选（PoC 验证）；Python 出局（OpenWiki 同栈锁定） |
| 拓扑 | 集中式：控制面侧独立 runner 进程，工具经 docker exec / Docker Archive API 进容器；容器退化为纯执行沙箱 |
| LLM | 调用移控制面侧；provider 配置 DB 热生效 + 端点白名单（防 injection 外送 key）+ 并发配额 |
| wiki | wiki 域（API/前端）保留；OpenWiki（langchain-ai/openwiki，deepagentsjs）作为库嵌入，产物 OKF v0.2 格式，前端适配渲染 |
| 审批 | 三层漏斗：规则层（路径/命令/端点白名单，确定性前置）→ LLM judge（输入固定为：用户输入 + 之前的工具调用 + 工具调用结果；**不含模型自身推理输出**）→ 罕用人工升级（ApprovalCard 复用）；全量审计入 TextTrace |
| 前端 | 控制面成为 chat WS 提供者；新事件模型定稿后重写 frontend/src/chat 数据层（约 1.2 万行域），UI 组件按新事件面评估保留比例 |
| 退役 | 老容器冻结只读 + 30 天迁移窗口 + wiki/workspace Archive 导出；会话历史（容器网关侧 SQLite）不可迁移，明示用户 |
| 产出 | 交接规格一份（对齐 docs/research/320 先例）；实施另起 effort |

评审结论已内化：工作量量级（替代的是 agent runtime 不是工具映射）、集中式单点（长任务恢复/隔离/延迟）、双栈不可逆（数据模型分叉）三大风险为后续 ticket 必答题。
EOF
gh issue comment "$T0" --body-file "$tmp/t0r" >/dev/null
gh issue close "$T0" >/dev/null
echo "T0=$T0 (closed)"

# ---------- T1 research：LangGraph JS / deepagentsjs 调研 ----------
cat > "$tmp/t1" <<'EOF'
## Question

LangGraph JS（@langchain/langgraph）与 deepagentsjs 作为自研 agent runtime 基座的能力与成熟度：
- checkpointer 后端与持久化形态（SQLite/Postgres/自定义）
- interrupt / 程序化 resume（自动审批三层漏斗依赖此机制）
- streaming 事件粒度（token 级 / 节点级，能否支撑前端流式投影）
- 上下文管理 / compaction 现状（OpenClaw 有内置 compaction，缺口即自研量）
- deepagents 的 filesystem backend 抽象能否指向 Docker Archive API（容器内 wiki/workspace 树）
- 与 TS/Express 独立 runner 进程集成的已知坑

产出：选型确认书（含风险与缺口清单），供 PoC（prototype ticket）据此搭建。
EOF
T1=$(new_issue "调研：LangGraph JS 与 deepagentsjs 运行时能力" "wayfinder:research" "$tmp/t1")
echo "T1=$T1"

# ---------- T2 prototype：端到端最小闭环 PoC ----------
cat > "$tmp/t2" <<'EOF'
## Question

端到端最小闭环 PoC：一个测试容器 + bash/read/write 三工具（docker exec / Docker Archive）+ 控制面 WS 流式输出 + 会话落 Prisma + 人为断线后恢复一次运行。

验收要回答：
1. docker exec 工具调用延迟实测数字（一个任务几十上百次调用，累积是否可接受）
2. deepagentsjs / LangGraph JS 基座是否胜任（filesystem backend 适配容器树、interrupt 可用性）
3. 断线恢复的 checkpoint / replay 形态

产出口径用于校准全 map 的工作量估计（评审警示：工作量可能错估一个数量级）。
EOF
T2=$(new_issue "PoC：agent 循环端到端最小闭环" "wayfinder:prototype" "$tmp/t2")
echo "T2=$T2"

# ---------- T3 research：OpenWiki 嵌入面 ----------
cat > "$tmp/t3" <<'EOF'
## Question

OpenWiki（langchain-ai/openwiki，deepagentsjs）作为库嵌入新 agent runtime 的集成面：
- 其文档 agent / MCP 工具集的编程 API（库形态可用面）
- OKF v0.2 格式与 .claims/ 证据旁车的确切结构
- 现有 wiki 域（server/src/wiki 的 tree/page/graph API + WikiView/WikiGraph/MdEditor）渲染与适配 OKF 的改动面清单
- 多租户使用（每容器 wiki 树作为其 workspace）需要哪些改造

产出：嵌入方案 + 前端适配清单。
EOF
T3=$(new_issue "调研：OpenWiki 库嵌入面与 OKF 格式适配" "wayfinder:research" "$tmp/t3")
echo "T3=$T3"

# ---------- T4 grilling：新事件/消息模型 ----------
cat > "$tmp/t4" <<'EOF'
## Question

新 agent runtime 的 WS 事件/消息模型（替代 OpenClaw 协议 v4 事件投影）：
消息流、工具调用事件、thinking、审批事件（三层漏斗的 interrupt/resume 事件面）、rewind/fork 语义、outbox 离线补偿语义、会话投影与断线重放。

以 PoC 的真实循环为依据定稿；该模型决定前端改造面（哪些 UI 数据层必动）。
EOF
T4=$(new_issue "设计：新事件/消息模型（替代 OpenClaw 协议投影）" "wayfinder:grilling" "$tmp/t4")
echo "T4=$T4"

# ---------- T5 grilling：会话历史新家 ----------
cat > "$tmp/t5" <<'EOF'
## Question

会话历史新家：LangGraph checkpointer 选型与数据设计。
- 主 Prisma SQLite 单写者 vs 高频事件流 append 的锁竞争（评审提醒：事件流可能不宜进主库）
- 会话 / 消息 / 事件的存储边界
- 与 TextTrace 审计（traceLogs）的关系与边界
- 留存与清理策略

依据调研 ticket 的 checkpointer 结论定稿。
EOF
T5=$(new_issue "设计：会话历史新家与 checkpointer 数据" "wayfinder:grilling" "$tmp/t5")
echo "T5=$T5"

# ---------- T6 grilling：容器镜像与执行沙箱 ----------
cat > "$tmp/t6" <<'EOF'
## Question

不装 OpenClaw 后的用户容器规格：
- 基础镜像内容（工具集、是否需要 Node/Python 运行时、体积预算）
- wiki/workspace 树初始化
- 资源 limit（dockerRuntime 现无 NanoCpus/Memory，评审确认须补课——集中式后 runaway agent 的最后防线）
- 网络出口策略（自动审批 + 容器可出网 = key 外送面，容器层缓解；与 provider 端点白名单互补）
- 健康检查与端口池（19000–19999）的存废——集中式后容器可能不再需要宿主端口

产出：容器规格书。
EOF
T6=$(new_issue "设计：用户容器镜像与执行沙箱规格" "wayfinder:grilling" "$tmp/t6")
echo "T6=$T6"

# ---------- T7 grilling：自动审批三层漏斗规格 ----------
cat > "$tmp/t7" <<'EOF'
## Question

自动审批三层漏斗规格（根决策已定方向，本票定细节）：
1. 规则层清单：路径白名单（仅 wiki/workspace 树）、命令黑名单、provider 端点白名单的匹配语义
2. LLM judge 契约：输入固定为（用户输入 + 之前的工具调用 + 工具调用结果），不含模型自身推理输出；输出 approve/reject + 理由；reject 理由回喂主 agent；judge 模型选择与 token 成本预算
3. 升级通道阈值：哪些模式强制走人工（默认趋零但不移除）；前端 ApprovalCard 复用面
4. 全量审计（judge approve/reject 及理由）入 TextTrace 的格式

产出：审批规格书（含 judge prompt 初稿）。
EOF
T7=$(new_issue "设计：自动审批三层漏斗规格" "wayfinder:grilling" "$tmp/t7")
echo "T7=$T7"

# ---------- T8 grilling：前端 chat 改造与双协议退役 ----------
cat > "$tmp/t8" <<'EOF'
## Question

前端 chat 改造与双协议退役（依据定稿的事件模型）：
- frontend/src/chat（40+ 文件约 1.2 万行）重写面清单：outbox / rewind-fork / subagent 审批 / 会话投影 / 断线恢复 各部分的重设计 vs 保留
- UI 组件（ChatStream/ToolLine/ThinkingCard 等）消费新事件面的保留比例评估
- OpenWiki OKF 格式的 WikiView/WikiGraph 渲染适配
- 老容器「冻结只读」的前端 UX 与临时双协议适配层的退场设计

产出：前端改造清单 + 工作量估计（评审警示：勿低估）。
EOF
T8=$(new_issue "设计：前端 chat 改造与双协议退役窗口" "wayfinder:grilling" "$tmp/t8")
echo "T8=$T8"

# ---------- T9 research：model provider 配置新家 ----------
cat > "$tmp/t9" <<'EOF'
## Question

model provider 配置新家（根决策已定：控制面 DB 热生效，替代写盘+重启）：
- LangChain 的 provider 抽象（init_chat_model 等）与现有 models 域 provider CRUD 能力对齐
- per-user provider 端点白名单机制设计输入（防 prompt injection 把流量含 key 指向恶意端点）
- 全局面并发/配额限流方案
- 现有 openclaw.json provider 配置 → 新 DB 配置的迁移映射表

产出：配置域设计输入书。
EOF
T9=$(new_issue "调研：model provider 配置新家（热生效 + 白名单 + 配额）" "wayfinder:research" "$tmp/t9")
echo "T9=$T9"

# ---------- T10 grilling：老容器退役执行方案 ----------
cat > "$tmp/t10" <<'EOF'
## Question

老容器（OpenClaw fleet）退役执行方案：
- 冻结只读的服务端门（禁新消息，wiki/workspace 保持可导出）
- wiki/workspace 经 Docker Archive 导出的工具 / 入口
- 30 天窗口的公告机制与到期清理 job
- 「会话历史不可迁移（容器网关侧 SQLite）」的用户沟通文案
- 新架构上线与老 fleet 退场的编排顺序（评审警示：Q6+Q7 组合的双协议税必须有显式终点）

产出：退役 runbook。
EOF
T10=$(new_issue "设计：老容器退役执行方案（冻结 + 30 天窗口）" "wayfinder:grilling" "$tmp/t10")
echo "T10=$T10"

# ---------- T11 grilling：汇编交接规格 ----------
cat > "$tmp/t11" <<'EOF'
## Question

汇编交接规格（map 的 destination）：整合全部 ticket 结论成一份 spec，格式对齐 docs/research/320 先例——
目标架构图、模块边界、事件模型、存储设计、审批规格、容器规格、provider 配置域、前端改造与退役路径、风险清单（工作量量级 / 集中式单点 / 双栈不可逆的缓解）、PoC 实测数字附录。

本票是收尾：所有设计 ticket 关闭后执行。
EOF
T11=$(new_issue "汇编：LangGraph agent runtime 替代 OpenClaw 交接规格" "wayfinder:grilling" "$tmp/t11")
echo "T11=$T11"

# ---------- map ----------
cat > "$tmp/map" <<EOF
## Destination

一份交接规格（对齐 \`docs/research/320\` 先例）：定义以 LangGraph JS 生态自研 agent runtime 全面替代 OpenClaw 的目标架构、模块边界、事件模型、迁移与退役路径、风险清单。规格完成即到达；实施另起 effort。

## Notes

- 域：researcher-service（TS/Express 控制面 + Vue3 前端）；map 与 ticket 全部中文。
- 每会话按 ticket 类型调用对应技能：grilling 票必调 /grilling 与 /domain-modeling；research 票派 /research 子代理；prototype 票用 /prototype。
- 根决策已在 grilling 会话钉定（见 Decisions so far 首条 ticket 的 resolution comment）。后续票不得重开已钉决策；有异议先在 map 下开讨论。
- 架构评审（fable）三大风险已内化为必答题：工作量量级（替代的是 agent runtime 不是工具映射）、集中式单点（长任务恢复/资源隔离/exec 延迟）、双栈不可逆（会话数据模型分叉后无回头路）。
- 关键既有事实：wiki 域不经 OpenClaw（控制面 Docker API 直管文件树）；chat 会话/历史全在容器网关侧 SQLite；frontend/src/chat 约 1.2 万行；dockerRuntime 无资源 limit；BullMQ+Redis 为单进程模型。

## Decisions so far

- [根架构决策：LangGraph 替代 OpenClaw（grilling 会话定稿）](https://github.com/$REPO/issues/$T0) — 决策栈全录：LangGraph JS + deepagentsjs 候选基座 / 集中式 runner / LLM 移控制面 / OpenWiki 库嵌入 OKF / 自动审批三层漏斗（judge 不看模型推理）/ 老容器冻结 + 30 天窗口退役。

## Not yet specified

- **compaction / token 成本策略**：等运行时调研与 PoC 出结果才知道 LangGraph 侧缺什么、自研什么、每用户 token 成本是否要预算线。
- **subagent / commands / skills 的对应物**：OpenClaw 有 subagent 审批与 skills 体系；新事件模型（设计票）定稿后才能定义这些能力的形态与去留。
- **配额与性能量化目标**：等 PoC 实测数字（exec 延迟、流式吞吐）后才能写进 spec 的非功能需求。
- **实施拆分与排期**：spec 汇编阶段的产物，规划期不动。

## Out of scope

- **TS 控制面六域（auth/users/containers/wiki 基础 CRUD/files/models 基础设施）的重写**：根决策已钉保留——它们与 OpenClaw 解耦，重写无对应收益。
- **设备配对机制的任何等价物**：根决策已钉移除——它只为「浏览器直连网关」而生，集中式下浏览器只连控制面，JWT 已认证。
EOF
MAP=$(new_issue "Wayfinder 地图：LangGraph agent runtime 替代 OpenClaw" "wayfinder:map" "$tmp/map")
echo "MAP=$MAP"

# ---------- sub-issue 挂载 ----------
mount() { # $1 map number  $2 child number
  local dbid
  dbid=$(gh api "repos/$REPO/issues/$2" --jq .id)
  gh api --method POST "repos/$REPO/issues/$1/sub_issues" -F sub_issue_id="$dbid" >/dev/null
}
for n in "$T0" "$T1" "$T2" "$T3" "$T4" "$T5" "$T6" "$T7" "$T8" "$T9" "$T10" "$T11"; do
  mount "$MAP" "$n"
done
echo "sub-issues mounted"

# ---------- blocking wiring ----------
dbid_of() { gh api "repos/$REPO/issues/$1" --jq .id; }
block() { # $1 child  $2 blocker
  gh api --method POST "repos/$REPO/issues/$1/dependencies/blocked_by" -F issue_id="$(dbid_of "$2")" >/dev/null
}
block "$T2"  "$T1"
block "$T4"  "$T2"
block "$T5"  "$T1"
block "$T8"  "$T3"
block "$T8"  "$T4"
block "$T10" "$T4"
for b in "$T2" "$T3" "$T4" "$T5" "$T6" "$T7" "$T8" "$T9" "$T10"; do
  block "$T11" "$b"
done
echo "blocking wired"

echo
echo "================ DONE ================"
echo "map      : #$MAP  https://github.com/$REPO/issues/$MAP"
echo "root     : #$T0 (closed)"
echo "frontier : #$T1 (research) #$T3 (research) #$T6 #$T7 #$T9 (research)"
echo "blocked  : #$T2 #$T4 #$T5 #$T8 #$T10 #$T11"
