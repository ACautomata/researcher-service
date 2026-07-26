"""chat.event_translate —— OpenClaw chat 事件 → 前端契约翻译（issue #41 / spec §8.2）。

翻译策略：把网关 chat 事件（state:delta/final/error/aborted + runId）翻译成前端契约帧列表
（text/done/error）。一帧网关事件可产 0..N 帧线端帧（final 含未发尾部时先补 text 再 done，对齐
services.openclaw_service._translate / r13-ws-protocol.md:128-129）。

delta 增量按 runId 累积已发文本（_sent）：
- replace=true + message 快照 → 整段替换（非前缀也正确）：发 replace 帧，前端 set 而非 append
  （r13:115-127 注明非前缀替换无法追加，需传播 replacement 语义）。
- replace=true 无快照 → 退回 deltaText 增量（追加）。
- 普通 delta → deltaText 增量（追加）。
error 读 errorMessage/errorKind（网关字段，r13:118 上游源码已证）。

T06 权限审批（issue #42 / spec §8.2）：`exec.approval.requested` / `plugin.approval.requested`（r26 §1
官方文档已证）是**连接级**事件（不挂 chat runId，r26:88）→ 翻译成 `{type:approval,id,kind,command}`
审批卡帧。command 取值链：systemRunPlan.rawCommand（r26:64 官方文档已证）→ systemRunPlan.command
→ 顶层 command → ''（防御性兜底）。decision 透传网关权威值（客户端 approval.resolve 方法已证 r26:78-79；网关事件 payload 待实测）。

T08 工具执行（issue #44 / spec §8.2/§9.4 / r26 §3）：`agent.tool.start`/`agent.tool.result`（r26 §3
二手来源，译者取值链兜底）→ `{type:tool,runId,name,state,title,input,result}` 工具帧，带 runId
走所属 chat run 路由。工具帧字段名取值链（name/id/input/result）集中 `_translate_tool`。

思考链 protocol v4 无独立帧（r26 §4 官方文档已证）→ 不新增 thinking 分支，整段按 text 透传
（spec §8.3 (b) 降级，前端折叠卡标注降级模式）。r13 §3 上游源码已证 chat 仅 delta/final/aborted/
error 四 state 转发；其他事件族参见 wire 模块集中常量。终态（final/aborted/error）清理该 runId
累积文本。"""
from __future__ import annotations

from integration.openclaw.wire import (
    APPROVAL_REQUESTED_EVENTS as _APPROVAL_REQUESTED_EVENTS,
    APPROVAL_RESOLVED_EVENTS as _APPROVAL_RESOLVED_EVENTS,
    TOOL_END_EVENTS as _TOOL_END_EVENTS,
    TOOL_START_EVENTS as _TOOL_START_EVENTS,
)

# delta state 下增量字段；replace=true + message 快照时改发 replace 帧（整段替换）。
_DELTA_TEXT = 'deltaText'


class ChatEventTranslator:
    """OpenClaw chat 事件 → 前端契约帧列表（Strategy：纯翻译；按 runId 累积 sent 支持 replace）。"""

    def __init__(self) -> None:
        # runId → 已发文本累积；final 尾部补发 / replace 整段替换时用于求差集或覆盖
        self._sent: dict[str, str] = {}

    @staticmethod
    def _approval_card(event: str, payload: dict) -> dict | None:
        """待审批事件 payload → 前端审批卡帧；无稳定审批 id 则返回 None（无法 resolve，不出卡）。

        kind 取值（codex/审查 P1）：payload.kind 缺省时从事件名族派生（exec/plugin）——r26 §1 指出
        kind 非文档字段，plugin 审批若一律回退 'exec' 会以错误 kind 回覆 approval.resolve（类型无关
        审批对要求匹配 kind）。sessionKey 透传自 systemRunPlan（前端据此把审批归属到对应会话过滤）。
        """
        approval_id = payload.get('id')
        if not approval_id:
            return None
        # command 取值链：systemRunPlan.rawCommand（r26:64 官方文档已证）→ systemRunPlan.command → 顶层 command → ''（防御性兜底）
        run_plan = payload.get('systemRunPlan') or {}
        command = run_plan.get('rawCommand') or run_plan.get('command') or payload.get('command') or ''
        return {
            'type': 'approval',
            'id': approval_id,
            'kind': payload.get('kind') or event.split('.')[0],  # decision 回覆需 id+kind+decision 三字段
            'command': command,
            'sessionKey': run_plan.get('sessionKey'),  # codex P1：归属会话；无则 None（前端按当前会话处理）
        }

    @staticmethod
    def _approval_resolved(payload: dict) -> dict | None:
        """网关 resolved 事件 payload → 前端 approvalResolved 帧；无 id 返回 None（不伪造，跳过）。

        decision 取值（待实测校准）：透传网关权威值；缺省/未知时前端判 unknown，不默认批准。
        """
        approval_id = payload.get('id')
        if not approval_id:
            return None
        return {
            'type': 'approvalResolved',
            'id': approval_id,
            'decision': payload.get('decision'),  # 透传权威值；未知由前端判 unknown
        }

    def translate(self, frame: dict) -> list[dict]:
        """翻译一帧网关事件；不可翻译的返回空列表（交由调用方忽略）。"""
        if frame.get('type') != 'event':
            return []
        # 审批事件是连接级广播（不挂 chat runId，r26:88）→ 单独翻译出卡，不进 chat 分支
        event = frame.get('event')
        if event in _APPROVAL_REQUESTED_EVENTS:
            card = self._approval_card(event, frame.get('payload') or {})
            return [card] if card else []
        # 他端 resolve 后的网关 resolved 事件（codex R3 P2）→ approvalResolved 帧收敛 peer 卡
        if event in _APPROVAL_RESOLVED_EVENTS:
            resolved = self._approval_resolved(frame.get('payload') or {})
            return [resolved] if resolved else []
        # T08 工具生命周期事件（runId 级，工具挂在 chat run 内，r26 §3）→ 工具帧
        if event in _TOOL_START_EVENTS:
            return self._translate_tool(frame.get('payload') or {}, 'running')
        if event in _TOOL_END_EVENTS:
            return self._translate_tool(frame.get('payload') or {}, 'done')
        if event != 'chat':
            return []
        payload = frame.get('payload') or {}
        run_id = payload.get('runId')
        if not run_id:
            return []
        state = payload.get('state')
        if state == 'delta':
            return self._translate_delta(run_id, payload)
        if state == 'final':
            return self._translate_final(run_id, payload)
        if state == 'aborted':
            self._sent.pop(run_id, None)
            return [{'type': 'done', 'runId': run_id}]
        if state == 'error':
            self._sent.pop(run_id, None)
            # 网关 error 字段为 errorMessage（缺则退到 errorKind），对齐 openclaw_service / r13:118
            message = payload.get('errorMessage') or payload.get('errorKind') or ''
            return [{'type': 'error', 'runId': run_id, 'message': message}]
        return []

    def _translate_delta(self, run_id: str, payload: dict) -> list[dict]:
        if payload.get('replace'):
            snapshot = payload.get('message') or ''
            if snapshot:
                # replace=true + 快照：整段替换（前缀/非前缀均正确）。前端按 replace 标志 set 而非 append
                self._sent[run_id] = snapshot
                return [{'type': 'text', 'runId': run_id, 'delta': snapshot, 'replace': True}]
            # 无快照 → 退回 deltaText 增量（追加），对齐 r13:127「若无 message，发 deltaText」
            delta = payload.get(_DELTA_TEXT) or ''
            if not delta:
                return []
            self._sent[run_id] = self._sent.get(run_id, '') + delta
            return [{'type': 'text', 'runId': run_id, 'delta': delta}]
        delta = payload.get(_DELTA_TEXT) or ''
        if not delta:
            return []
        self._sent[run_id] = self._sent.get(run_id, '') + delta
        return [{'type': 'text', 'runId': run_id, 'delta': delta}]

    def _translate_final(self, run_id: str, payload: dict) -> list[dict]:
        out: list[dict] = []
        message = payload.get('message') or ''
        sent = self._sent.get(run_id, '')
        # final.message 可能含此前未在 delta 投递的尾部文本 → 先补 text 再 done（r13:128-129）
        if message and message.startswith(sent) and len(message) > len(sent):
            tail = message[len(sent):]
            self._sent[run_id] = sent + tail
            out.append({'type': 'text', 'runId': run_id, 'delta': tail})
        out.append({'type': 'done', 'runId': run_id})
        self._sent.pop(run_id, None)
        return out

    @staticmethod
    def _translate_tool(payload: dict, state: str) -> list[dict]:
        """T08 工具生命周期事件 payload → 工具帧（runId 级，路由到所属 chat run，r26 §3）。

        字段名取值链（r26 §3 二手来源；集中于此便于单点校准）：
        - name: payload.tool → payload.name → payload.toolName；无 name → []（无法渲染工具行）
        - id: payload.toolCallId → payload.tool_call_id → payload.callId → payload.id（缺省 None）；
          工具调用 id，前端据此配对同名并发调用的 result（codex P2，无 id 退 name）
        - title: payload.title（缺省 None）
        - input: payload.input → payload.args（缺省 None）
        - result: payload.result → payload.output（缺省 None）
        统一 shape（start 时 result=None）便于前端按 id/name 聚合 start→result。
        """
        run_id = payload.get('runId')
        if not run_id:
            return []
        name = payload.get('tool') or payload.get('name') or payload.get('toolName')
        if not name:
            return []
        return [{
            'type': 'tool', 'runId': run_id, 'name': name, 'state': state,
            'id': payload.get('toolCallId') or payload.get('tool_call_id')
                  or payload.get('callId') or payload.get('id'),
            'title': payload.get('title'),
            'input': payload.get('input') or payload.get('args'),
            'result': payload.get('result') or payload.get('output'),
        }]
