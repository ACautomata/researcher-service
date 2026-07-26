"""OpenClaw wire 域常量单一来源（防腐层集成包 / spec #97 / ADR 0002 / issue #98）。

收口 chat 三处（pairing_ws / chat_client / event_translate）重复的 wire 知识：协议版本、
connect 帧标识（client_id / mode / role / agent_id）、operator 权限 scopes/caps、配对必须 scope
集、事件族名（approval / tool）。

边界（ADR 0002）：
- 仅 wire 域常量在此收口。容器/编排域常量（GATEWAY_INTERNAL_PORT 等）单一来源仍在 containers app
  （#88-90 后续统一到 containers/constants.py），本包不重复定义。
- 标识符（runId / sessionKey / deviceToken 等）保留 OpenClaw 原生命名、集中管理、不翻译。
"""
# 协议版本（spec §8.1 / r13 §5.4）
PROTOCOL = 4

# connect 帧固定标识（r13 §5.4 / r40 §3）：client/mode/role 用网关后端语义。
CLIENT_ID = 'gateway-client'
CLIENT_MODE = 'backend'
ROLE = 'operator'
AGENT_ID = 'main'

# spec §8.1：operator.read/write/admin/approvals 四 scope + tool-events cap。
SCOPES = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals']
CAPS = ['tool-events']

# 验收要求：协商 scopes 必须至少包含以下三者，否则聊天/审批调用会缺权失败。
REQUIRED_SCOPES = {'operator.read', 'operator.write', 'operator.approvals'}

# 事件族名（语义层归一用，r26 / spec §8.2）—— Translator 据此把 OpenClaw 原生事件族
# 归一为内部 approval / tool 语义。确切事件名/payload 待配对后实测校准（r26 §0/§3）。
# T06 权限审批（issue #42）：exec/plugin 两族共用同一翻译；连接级事件（不挂 chat runId，r26:88）；
# payload 字段级 schema 官方未给全 → 取值链集中在 Translator._approval_card。
APPROVAL_REQUESTED_EVENTS = ('exec.approval.requested', 'plugin.approval.requested')
# resolved 仅 plugin 族有（r26:47-52，exec 族无对应）；他端 operator 连接 resolve 后网关广播，
# 译为 approvalResolved 帧让共享 client 的 peer 卡片收敛。payload schema 待实测，无 id 跳过（不伪造）。
APPROVAL_RESOLVED_EVENTS = ('plugin.approval.resolved',)
# T08 工具执行（issue #44）：挂在 chat run 内（r26 §3），帧带 runId 走既有 runId 路由。
TOOL_START_EVENTS = ('agent.tool.start',)
TOOL_END_EVENTS = ('agent.tool.result',)
