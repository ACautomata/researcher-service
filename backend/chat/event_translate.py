"""chat.event_translate —— OpenClaw chat 事件 → 前端契约翻译（issue #41 / spec §8.2）。

纯翻译策略（无状态）：把网关 chat 事件（state:delta/final/error/aborted + runId）翻译成前端
契约帧（text/done/error）。MVP 仅处理 deltaText 增量变体；replace/message 与 tool/approval/cot
待协议实测（spec §8.3），一律忽略返回 None——由 test_event_translate 显式断言，非静默吞错。
"""
from __future__ import annotations

# delta state 下 MVP 唯一处理的增量字段；replace/message 变体语义待实测（spec §8.2）。
_DELTA_TEXT = 'deltaText'


class ChatEventTranslator:
    """OpenClaw chat 事件 → 前端契约帧（Strategy：纯翻译、无状态、可注入替换）。"""

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
            delta = payload.get(_DELTA_TEXT)
            if not delta:
                return None
            return {'type': 'text', 'runId': run_id, 'delta': delta}
        if state in ('final', 'aborted'):
            return {'type': 'done', 'runId': run_id}
        if state == 'error':
            return {'type': 'error', 'runId': run_id, 'message': payload.get('message', '')}
        return None
