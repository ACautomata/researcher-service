"""seam: chat.event_translate —— OpenClaw chat 事件 → 前端契约翻译（issue #41 / spec §8.2）。

覆盖：state:delta(deltaText)→text、final→done、error→error、aborted→done；
非 chat event / 非 event 帧 / 缺 runId / 未知 state → None（MVP 不处理 tool/approval/cot）；
delta 的 replace=true 变体 → 按 message 快照求差集发增量（对齐 openclaw_service，协议已实测）；
delta 的 message 变体（无 replace/快照）→ None（不静默吞错）。
"""
import pytest

from chat.event_translate import ChatEventTranslator


@pytest.fixture
def translator():
    return ChatEventTranslator()


def _chat(state: str, run_id: str = 'r1', **extra) -> dict:
    payload = {'runId': run_id, 'state': state}
    payload.update(extra)
    return {'type': 'event', 'event': 'chat', 'payload': payload}


def test_delta_delta_text_becomes_text(translator):
    frame = _chat('delta', deltaText='你好')
    assert translator.translate(frame) == {'type': 'text', 'runId': 'r1', 'delta': '你好'}


def test_final_becomes_done(translator):
    assert translator.translate(_chat('final')) == {'type': 'done', 'runId': 'r1'}


def test_error_reads_gateway_error_message_field(translator):
    # 网关 error 事件字段为 errorMessage（非 message），对齐 openclaw_service / spec §8.2
    frame = _chat('error', errorMessage='模型超时')
    assert translator.translate(frame) == {'type': 'error', 'runId': 'r1', 'message': '模型超时'}


def test_error_falls_back_to_error_kind(translator):
    # 缺 errorMessage 时退到 errorKind
    assert translator.translate(_chat('error', errorKind='RATE_LIMIT')) == {
        'type': 'error', 'runId': 'r1', 'message': 'RATE_LIMIT',
    }


def test_delta_replace_diffs_against_already_sent(translator):
    # replace=true：message 是整段快照，与同 runId 已发文本求差集后发增量
    first = translator.translate(_chat('delta', deltaText='你好'))
    assert first == {'type': 'text', 'runId': 'r1', 'delta': '你好'}
    replaced = translator.translate(_chat('delta', message='你好世界', replace=True))
    assert replaced == {'type': 'text', 'runId': 'r1', 'delta': '世界'}


def test_delta_replace_without_snapshot_falls_back_to_delta_text(translator):
    # replace=true 但无 message 快照 → 退回 deltaText 增量（对齐 openclaw_service）
    assert translator.translate(_chat('delta', deltaText='x', replace=True)) == {
        'type': 'text', 'runId': 'r1', 'delta': 'x',
    }


def test_aborted_becomes_done(translator):
    # aborted 视作收尾（非错误）；MVP 无 stop 按钮，主动中止语义留给后续 ticket
    assert translator.translate(_chat('aborted')) == {'type': 'done', 'runId': 'r1'}


def test_non_chat_event_returns_none(translator):
    # tool/approval/cot 事件 MVP 不处理（spec §8.3 待实测）
    frame = {'type': 'event', 'event': 'tool.start', 'payload': {'runId': 'r1'}}
    assert translator.translate(frame) is None


def test_non_event_frame_returns_none(translator):
    # req/res 帧不属于 chat 事件流
    assert translator.translate({'type': 'res', 'id': 'x', 'ok': True}) is None


def test_missing_run_id_returns_none(translator):
    # 无 runId 无法路由回发起方
    frame = {'type': 'event', 'event': 'chat', 'payload': {'state': 'delta', 'deltaText': 'x'}}
    assert translator.translate(frame) is None


def test_delta_replace_without_snapshot_or_delta_text_returns_none(translator):
    # replace=true 但既无 message 快照也无 deltaText → 无可发增量 → None
    assert translator.translate(_chat('delta', replace=True)) is None


def test_delta_message_variant_returns_none(translator):
    # delta 的 message 变体（非 replace 快照）MVP 不处理 → None
    assert translator.translate(_chat('delta', message='消息级 delta')) is None


def test_chat_event_without_state_returns_none(translator):
    frame = {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1'}}
    assert translator.translate(frame) is None


def test_unknown_state_returns_none(translator):
    # 未知 state 不猜测，留待协议实测明确后再扩展
    assert translator.translate(_chat('streaming')) is None
