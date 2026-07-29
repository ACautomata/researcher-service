"""chat.event_translate —— OpenClaw chat 事件 → 前端契约翻译（issue #41 / spec §8.2）。

翻译策略：把网关 chat 事件（state:delta/final/error/aborted + runId）翻译成前端契约帧列表
（text/done/error）。一帧网关事件可产 0..N 帧线端帧（final 含未发尾部时先补 text 再 done，对齐
services.openclaw_service._translate / r13-ws-protocol.md:128-129）。

delta 增量按 runId 累积已发文本（_sent）：
- replace=true + message 快照 → 整段替换（非前缀也正确）：发 replace 帧，前端 set 而非 append
  （r13:115-127 注明非前缀替换无法追加，需传播 replacement 语义）。
- replace=true 无快照 → deltaText 即替换文本：发 replace 帧且 _sent 置为 deltaText（set 而非 append），
  对齐契约「非前缀替换设 replace=true 并用 deltaText 作替换文本」（issue #203 问题 3，修
  "The catThe dog" 式重复；旧注释引用的 r13:127「若无 message，发 deltaText」与契约冲突，已澄清）。
- 普通 delta → deltaText 增量（追加）。
error 读 errorMessage/errorKind（网关字段，r13:118 上游源码已证）。

issue #203（流式事件翻译与 OpenClaw 契约对齐）：
- 问题 2：payload.seq 按 runId 维护 last_seq 去重（重发/乱序 seq<=last 丢弃）；检出前向缺口
  （seq > last+1）记 warning 并置「需 chat.history 重载」标记（pending_history_reload 钩子，
  重载实现属 #196 范围，本仓仅留标记）。
- 问题 1（加法且幂等）：agent lifecycle 流 data.phase ∈ {end,error} 时，仅当该 runId 尚未经
  chat final/aborted/error 收尾才补发 done/error 帧并清理状态（done 幂等去重）；不推翻经真镜像
  实测校准的 chat state 通道。stream:assistant 的文本消费本 PR 不做（待真网关复核，deferred）。

T06 权限审批（issue #42 / spec §8.2）：`exec.approval.requested` / `plugin.approval.requested`（r26 §1
官方文档已证）是**连接级**事件（不挂 chat runId，r26:88）→ 翻译成 `{type:approval,id,kind,command}`
审批卡帧。command 取值链：systemRunPlan.rawCommand（r26:64 官方文档已证）→ systemRunPlan.command
→ 顶层 command → ''（防御性兜底）。decision 透传网关权威值（客户端 approval.resolve 方法已证 r26:78-79；网关事件 payload 待实测）。

T08 工具执行（issue #44 / #153 / spec §8.2/§9.4）：实测 ghcr 2026.6.34（ADR 0003 / PR #152 深挖 #3）
网关工具事件为 event:"agent" + payload.stream:"tool" + data.phase:"start"/"update"/"result"
→ `{type:tool,runId,name,state,title,input,result}` 工具帧，带 runId 走所属 chat run 路由。
字段在 data 子对象下：name/toolCallId/args（start）、partialResult（update）、
result/isError/meta（result）。

思考链 protocol v4 无独立帧（r26 §4 官方文档已证）→ 不新增 thinking 分支，整段按 text 透传
（spec §8.3 (b) 降级，前端折叠卡标注降级模式）。r13 §3 上游源码已证 chat 仅 delta/final/aborted/
error 四 state 转发；其他事件族参见 wire 模块集中常量。终态（final/aborted/error）清理该 runId
累积文本。"""
from __future__ import annotations

import logging

from integration.openclaw.wire import (
    APPROVAL_REQUESTED_EVENTS as _APPROVAL_REQUESTED_EVENTS,
)
from integration.openclaw.wire import (
    APPROVAL_RESOLVED_EVENTS as _APPROVAL_RESOLVED_EVENTS,
)
from integration.openclaw.wire import (
    TOOL_AGENT_EVENT as _TOOL_AGENT_EVENT,
)
from integration.openclaw.wire import (
    TOOL_STREAM as _TOOL_STREAM,
)

# delta state 下增量字段；replace=true + message 快照时改发 replace 帧（整段替换）。
_DELTA_TEXT = 'deltaText'

# issue #203 问题 1：agent 事件的 lifecycle 流（轮次终态补充通道；assistant 流文本消费 deferred）。
_LIFECYCLE_STREAM = 'lifecycle'

_logger = logging.getLogger(__name__)


class ChatEventTranslator:
    """OpenClaw chat 事件 → 前端契约帧列表（Strategy：纯翻译；按 runId 累积 sent 支持 replace）。"""

    def __init__(self) -> None:
        # runId → 已发文本累积；final 尾部补发 / replace 整段替换时用于求差集或覆盖
        self._sent: dict[str, str] = {}
        # issue #203 问题 2：runId → 已接受的最高 payload.seq（网关重发/乱序去重）
        self._last_seq: dict[str, int] = {}
        # 检出 seq 前向缺口的 runId 集合：需经 chat.history 重载该 run 投影后按 seq 续接——
        # 重载实现属 #196 范围，本 PR 仅留标记与 pending_history_reload() 钩子
        self._needs_reload: set[str] = set()
        # issue #203 问题 1：已经终态收尾（chat final/aborted/error 或 lifecycle end/error）的 runId，
        # 用于双通道终态幂等去重；标记在另一通道的重复终态到达时清除
        self._finished: set[str] = set()

    def pending_history_reload(self, run_id: str) -> bool:
        """该 runId 是否检出 seq 前向缺口、需 chat.history 重载投影（#203 问题 2 钩子，重载属 #196）。"""
        return run_id in self._needs_reload

    @staticmethod
    def _approval_card(event: str, payload: dict) -> dict | None:
        """待审批事件 payload → 前端审批卡帧；无稳定审批 id 则返回 None（无法 resolve，不出卡）。

        kind 取值（codex/审查 P1）：payload.kind 缺省时从事件名族派生（exec/plugin）——r26 §1 指出
        kind 非文档字段，plugin 审批若一律回退 'exec' 会以错误 kind 回覆 approval.resolve（类型无关
        审批对要求匹配 kind）。sessionKey 透传自 systemRunPlan（前端据此把审批归属到对应会话过滤）。

        issue #154 实测校准（ghcr 2026.6.34 / ADR 0003）：systemRunPlan 实测为 null；command 在
        payload.request.command、sessionKey 在 payload.request.sessionKey。取值链：
        request.command → systemRunPlan.rawCommand → systemRunPlan.command → 顶层 command → ''
        request.sessionKey → systemRunPlan.sessionKey → None
        """
        approval_id = payload.get('id')
        if not approval_id:
            return None
        # issue #154：实测 systemRunPlan=null，command/sessionKey 在 payload.request 下；
        # request 存在时取 request 字段（不退 systemRunPlan）；request 缺失时退 systemRunPlan（向后兼容）
        req = payload.get('request') or {}
        run_plan = payload.get('systemRunPlan') or {}
        if req:
            command = req.get('command') or ''
            session_key = req.get('sessionKey')
        else:
            command = (
                run_plan.get('rawCommand')
                or run_plan.get('command')
                or payload.get('command')
                or ''
            )
            session_key = run_plan.get('sessionKey')
        return {
            'type': 'approval',
            'id': approval_id,
            'kind': payload.get('kind') or event.split('.')[0],  # decision 回覆需 id+kind+decision 三字段
            'command': command,
            'sessionKey': session_key,  # codex P1：归属会话；无则 None（前端按当前会话处理）
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

    def translate(self, frame: dict) -> list[dict]:  # pylint: disable=too-many-return-statements
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
        # T08 工具生命周期事件（issue #153 实测校准：event:agent + stream:tool + phase）
        # 旧假设 agent.tool.start/result 独立事件——实测从不触发（#153）
        if event == _TOOL_AGENT_EVENT:
            payload = frame.get('payload') or {}
            run_id = payload.get('runId')
            # issue #203 问题 2：agent 事件 payload.seq 按 run 分配 → seq 去重/缺口检测
            if run_id and not self._accept_seq(run_id, payload.get('seq')):
                return []
            stream = payload.get('stream')
            if stream == _TOOL_STREAM:
                return self._translate_tool(payload, (payload.get('data') or {}).get('phase') or '')
            # issue #203 问题 1：lifecycle 流作轮次终态补充通道（加法且幂等，详见 _translate_lifecycle）
            if stream == _LIFECYCLE_STREAM:
                return self._translate_lifecycle(run_id, payload)
            # stream:assistant 的 data.delta/text/replaceable 文本消费本 PR 不做（需真网关复核，deferred）
            return []
        if event != 'chat':
            return []
        payload = frame.get('payload') or {}
        run_id = payload.get('runId')
        if not run_id:
            return []
        # issue #203 问题 2：chat 事件 payload.seq 去重（重发/乱序 seq<=last 丢弃；缺口打 warning 置标记）
        if not self._accept_seq(run_id, payload.get('seq')):
            return []
        state = payload.get('state')
        if state == 'delta':
            return self._translate_delta(run_id, payload)
        if state in ('final', 'aborted', 'error'):
            if run_id in self._finished:
                # done/error 幂等去重（#203 问题 1）：该 run 已经 lifecycle 通道收尾 → 不重复发终态帧
                self._finished.discard(run_id)
                self._cleanup_run(run_id)
                return []
            self._finished.add(run_id)
        if state == 'final':
            return self._translate_final(run_id, payload)
        if state == 'aborted':
            self._cleanup_run(run_id)
            return [{'type': 'done', 'runId': run_id}]
        if state == 'error':
            self._cleanup_run(run_id)
            # 网关 error 字段为 errorMessage（缺则退到 errorKind），对齐 openclaw_service / r13:118
            message = payload.get('errorMessage') or payload.get('errorKind') or ''
            return [{'type': 'error', 'runId': run_id, 'message': message}]
        return []

    def _accept_seq(self, run_id: str, seq) -> bool:
        """issue #203 问题 2：runId → last_seq 去重。返回 False 表示该帧为重发/乱序，应丢弃。

        payload 无 seq（旧网关/未分配）时不校验直接接受；seq > last+1 检出前向缺口 → warning 日志
        并置「需 chat.history 重载」标记（重载实现属 #196，见 pending_history_reload 钩子注释）。
        """
        if not isinstance(seq, int) or isinstance(seq, bool):
            return True
        last = self._last_seq.get(run_id)
        if last is not None and seq <= last:
            return False  # 网关重发/乱序：已见过或更低的 seq → 丢弃，避免文本重复追加
        if last is not None and seq > last + 1:
            _logger.warning(
                'chat run %s 检出 seq 前向缺口（last=%s, got=%s）：标记待 chat.history 重载（#196 接重载）',
                run_id, last, seq,
            )
            self._needs_reload.add(run_id)
        self._last_seq[run_id] = seq
        return True

    def _cleanup_run(self, run_id: str) -> None:
        """终态收尾时清理该 runId 的累积状态（文本缓冲 / seq / 重载标记），防跨 run 泄漏。"""
        self._sent.pop(run_id, None)
        self._last_seq.pop(run_id, None)
        self._needs_reload.discard(run_id)

    def _translate_lifecycle(self, run_id: str | None, payload: dict) -> list[dict]:
        """issue #203 问题 1（加法且幂等）：agent lifecycle 流 data.phase=end/error → 补发终态帧。

        本仓 chat state 模型经真镜像实测校准（T08 / ADR 0003 / #153），不推翻 chat 通道；lifecycle
        仅作**补充**——该 runId 尚未经 chat final/aborted/error 收尾时才补发 done/error 并清理状态；
        已收尾则幂等去重返回 []（done 不重复）。非终态 phase（start 等）不猜测，返回 []。
        """
        if not run_id:
            return []
        data = payload.get('data') or {}
        phase = data.get('phase') or ''
        if phase not in ('end', 'error'):
            return []
        if run_id in self._finished:
            # done 幂等去重：chat 通道已收尾 → 清除去重标记，不重复发终态帧
            self._finished.discard(run_id)
            self._cleanup_run(run_id)
            return []
        self._finished.add(run_id)
        self._cleanup_run(run_id)
        if phase == 'error':
            message = data.get('errorMessage') or data.get('message') or ''
            return [{'type': 'error', 'runId': run_id, 'message': message}]
        return [{'type': 'done', 'runId': run_id}]

    def _translate_delta(self, run_id: str, payload: dict) -> list[dict]:
        if payload.get('replace'):
            snapshot = self._extract_text(payload.get('message'))
            if snapshot:
                # replace=true + 快照：整段替换（前缀/非前缀均正确）。前端按 replace 标志 set 而非 append
                self._sent[run_id] = snapshot
                return [{'type': 'text', 'runId': run_id, 'delta': snapshot, 'replace': True}]
            # issue #203 问题 3：无快照时 deltaText 即替换文本（契约：非前缀替换设 replace=true，
            # 用 deltaText 作替换文本）→ 发 replace 帧且 _sent 置为 deltaText（set 而非 append），
            # 修 "The catThe dog" 式重复；旧注释引用的 r13:127「若无 message，发 deltaText」与契约冲突
            delta = payload.get(_DELTA_TEXT) or ''
            if not delta:
                return []
            self._sent[run_id] = delta
            return [{'type': 'text', 'runId': run_id, 'delta': delta, 'replace': True}]
        delta = payload.get(_DELTA_TEXT) or ''
        if not delta:
            return []
        self._sent[run_id] = self._sent.get(run_id, '') + delta
        return [{'type': 'text', 'runId': run_id, 'delta': delta}]

    @staticmethod
    def _extract_text(message) -> str:
        """从 final/delta 的 message 提取文本（实测校准 spike ghcr 2026.6.34-browser, 2026-07-27）：
        message 实测是 dict {role, content:[{type:text,text}], timestamp}，旧代码误当字符串致
        .startswith 崩。str 直返；dict 拼 content 中 type=text 的 text；None/空 → ''。"""
        if not message:
            return ''
        if isinstance(message, str):
            return message
        if isinstance(message, dict):
            return ''.join(
                b.get('text', '') for b in (message.get('content') or [])
                if isinstance(b, dict) and b.get('type') == 'text'
            )
        return ''

    def _translate_final(self, run_id: str, payload: dict) -> list[dict]:
        out: list[dict] = []
        message = self._extract_text(payload.get('message'))
        sent = self._sent.get(run_id, '')
        # final.message 可能含此前未在 delta 投递的尾部文本 → 先补 text 再 done（r13:128-129）
        if message and message.startswith(sent) and len(message) > len(sent):
            tail = message[len(sent):]
            self._sent[run_id] = sent + tail
            out.append({'type': 'text', 'runId': run_id, 'delta': tail})
        elif message and not message.startswith(sent):
            # issue #203 问题 4：final 快照与已发文本发散（非前缀）→ 记 warning（含 runId、前缀/快照
            # 长度），并按快照整段替换兜底（replace 帧，前端 set 而非 append），不再静默丢弃尾部
            _logger.warning(
                'chat run %s final 快照与已发文本发散（sent=%d 字符, snapshot=%d 字符）：按快照整段替换兜底',
                run_id, len(sent), len(message),
            )
            self._sent[run_id] = message
            out.append({'type': 'text', 'runId': run_id, 'delta': message, 'replace': True})
        out.append({'type': 'done', 'runId': run_id})
        self._cleanup_run(run_id)
        return out

    @staticmethod
    def _translate_tool(payload: dict, phase: str) -> list[dict]:
        """T08 工具生命周期事件（实测 ghcr 2026.6.34 / ADR 0003） payload → 工具帧。

        字段在 data 子对象下：name/toolCallId/args（start）、partialResult（update）、
        result/isError/meta（result）。

        phase mapping:
        - start → 'running'（工具开始）
        - update → 跳过（partial result 中间增量；前端已从 start 知工具运行中，不投新帧
          避免前端重复行，codex #162 P2）
        - result → 'done'（工具完成）或 'error'（isError=true）
        - 未知 phase → []（0 信任，不猜测）
        """
        if phase not in ('start', 'update', 'result'):
            return []
        if phase == 'update':
            return []  # 跳过中间增量；前端已有 start 帧的 running 行
        run_id = payload.get('runId')
        if not run_id:
            return []
        data = payload.get('data') or {}
        name = data.get('name')
        if not name:
            return []
        if phase == 'start':
            state, is_error = 'running', False
        else:
            is_error = bool(data.get('isError'))
            state = 'error' if is_error else 'done'
        return [{
            'type': 'tool', 'runId': run_id, 'name': name, 'state': state,
            'id': data.get('toolCallId'),
            'title': data.get('title'),
            'input': data.get('args'),
            'result': data.get('result'),
            'isError': is_error,
        }]
