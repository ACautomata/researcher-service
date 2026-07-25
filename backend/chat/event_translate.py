"""chat.event_translate —— OpenClaw chat 事件 → 前端契约翻译（issue #41 / spec §8.2）。

翻译策略：把网关 chat 事件（state:delta/final/error/aborted + runId）翻译成前端契约帧
（text/done/error）。delta 增量按 runId 累积已发文本（_sent），用于 replace=true 的整段快照求差集
（对齐 services.openclaw_service._translate，协议已实测）；error 读 errorMessage/errorKind（网关字段）。
tool/approval/cot 等非 chat 事件、以及 delta 的 message 变体（非 replace 快照）MVP 不处理，返回 None
（由 test_event_translate 显式断言，非静默吞错）。终态（final/aborted/error）清理该 runId 的累积文本。
"""
from __future__ import annotations

# delta state 下增量字段；replace=true 时改用 message 整段快照求差集（对齐 openclaw_service）。
_DELTA_TEXT = 'deltaText'


class ChatEventTranslator:
    """OpenClaw chat 事件 → 前端契约帧（Strategy：纯翻译；按 runId 累积 sent 以支持 replace 差集）。"""

    def __init__(self) -> None:
        # runId → 已发文本累积；replace=true 时与 message 快照求差集，前端保持追加式渲染
        self._sent: dict[str, str] = {}

    def translate(self, frame: dict) -> dict | None:
        """翻译一帧网关事件；非可翻译的 chat 事件返回 None（交由调用方忽略）。"""
        if frame.get('type') != 'event' or frame.get('event') != 'chat':
            return None
        payload = frame.get('payload') or {}
        run_id = payload.get('runId')
        if not run_id:
            return None
        state = payload.get('state')
        if state == 'delta':
            delta = payload.get(_DELTA_TEXT) or ''
            if payload.get('replace'):
                # replace=true：message 为整段快照，与同 runId 已发文本求差集后发增量；
                # 无快照 / 非已发前缀 → 退回 deltaText（对齐 openclaw_service）。
                snapshot = payload.get('message') or ''
                sent = self._sent.get(run_id, '')
                if snapshot and snapshot.startswith(sent):
                    delta = snapshot[len(sent):]
            if not delta:
                return None
            self._sent[run_id] = self._sent.get(run_id, '') + delta
            return {'type': 'text', 'runId': run_id, 'delta': delta}
        if state in ('final', 'aborted'):
            self._sent.pop(run_id, None)
            return {'type': 'done', 'runId': run_id}
        if state == 'error':
            self._sent.pop(run_id, None)
            # 网关 error 字段为 errorMessage（缺则退到 errorKind），对齐 openclaw_service / spec §8.2
            message = payload.get('errorMessage') or payload.get('errorKind') or ''
            return {'type': 'error', 'runId': run_id, 'message': message}
        return None
