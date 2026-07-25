"""seam: chat.event_translate —— OpenClaw chat 事件 → 前端契约翻译（issue #41 / spec §8.2）。

translate 返回帧列表（一帧网关事件可产 0..N 帧线端帧）。覆盖：
delta(deltaText)→text、delta replace=true+快照→replace 帧（整段替换，前缀/非前缀均正确）、
delta replace=true 无快照→退回 deltaText、final 含未发尾部→先 text(tail) 再 done、final/aborted→done、
error→error(errorMessage|errorKind)；非 chat event / 非 event 帧 / 缺 runId / 未知 state / delta message 变体 → []。
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
    assert translator.translate(_chat('delta', deltaText='你好')) == [
        {'type': 'text', 'runId': 'r1', 'delta': '你好'},
    ]


def test_final_becomes_done(translator):
    assert translator.translate(_chat('final')) == [{'type': 'done', 'runId': 'r1'}]


def test_final_forwards_unseen_tail_then_done(translator):
    # 网关 final.message 含此前未在 delta 投递的尾部文本 → 先补 text(tail) 再 done（codex #2 / r13:128）
    translator.translate(_chat('delta', deltaText='你好'))
    out = translator.translate(_chat('final', message='你好世界'))
    assert out == [
        {'type': 'text', 'runId': 'r1', 'delta': '世界'},
        {'type': 'done', 'runId': 'r1'},
    ]


def test_final_without_message_emits_only_done(translator):
    translator.translate(_chat('delta', deltaText='你好'))
    assert translator.translate(_chat('final')) == [{'type': 'done', 'runId': 'r1'}]


def test_error_reads_gateway_error_message_field(translator):
    # 网关 error 事件字段为 errorMessage（非 message），对齐 openclaw_service / r13:118
    assert translator.translate(_chat('error', errorMessage='模型超时')) == [
        {'type': 'error', 'runId': 'r1', 'message': '模型超时'},
    ]


def test_error_falls_back_to_error_kind(translator):
    assert translator.translate(_chat('error', errorKind='RATE_LIMIT')) == [
        {'type': 'error', 'runId': 'r1', 'message': 'RATE_LIMIT'},
    ]


def test_delta_replace_with_snapshot_emits_replace_frame(translator):
    # replace=true + message 快照：整段替换（前端 set 而非 append），前缀情况
    translator.translate(_chat('delta', deltaText='你好'))
    out = translator.translate(_chat('delta', message='你好世界', replace=True))
    assert out == [{'type': 'text', 'runId': 'r1', 'delta': '你好世界', 'replace': True}]


def test_delta_replace_non_prefix_snapshot_emits_replace_frame(translator):
    # 非前缀替换（"The cat"→"The dog"）：发 replace 帧让前端整段替换，而非追加成 "The catThe dog"
    # （codex #1 / r13:115-127：非前缀替换无法追加，需传播 replacement 语义）
    translator.translate(_chat('delta', deltaText='The cat'))
    out = translator.translate(_chat('delta', message='The dog', replace=True))
    assert out == [{'type': 'text', 'runId': 'r1', 'delta': 'The dog', 'replace': True}]


def test_delta_replace_without_snapshot_falls_back_to_delta_text(translator):
    # replace=true 但无 message 快照 → 退回 deltaText 增量（追加），对齐 r13:127
    assert translator.translate(_chat('delta', deltaText='x', replace=True)) == [
        {'type': 'text', 'runId': 'r1', 'delta': 'x'},
    ]


def test_aborted_becomes_done(translator):
    # aborted 视作收尾（非错误）；MVP 无 stop 按钮，主动中止语义留给后续 ticket
    assert translator.translate(_chat('aborted')) == [{'type': 'done', 'runId': 'r1'}]


def test_unknown_state_returns_empty(translator):
    # 未知 state 不猜测，留待协议实测明确后再扩展
    assert translator.translate(_chat('streaming')) == []


# ---- T06 权限审批（issue #42 / spec §8.2）----
# exec.approval.requested 是**连接级**事件（不挂 chat runId，r26:88）→ 翻译成前端审批卡契约帧。
# payload 字段级 schema 官方未给全（标待实测）→ 翻译做防御性取值，校准点集中一处。


def _approval_requested(**extra) -> dict:
    payload = {'id': 'ap-1', 'kind': 'exec'}
    payload.update(extra)
    return {'type': 'event', 'event': 'exec.approval.requested', 'payload': payload}


def test_approval_requested_becomes_approval_card(translator):
    # 完整 payload：id/kind + systemRunPlan.rawCommand（host=node 时网关字段，r26:64）
    frame = _approval_requested(systemRunPlan={'rawCommand': 'rm -rf /tmp/x'})
    assert translator.translate(frame) == [
        {'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'rm -rf /tmp/x'},
    ]


def test_approval_requested_extracts_command_fallbacks(translator):
    # command 取值链：systemRunPlan.rawCommand → systemRunPlan.command → 顶层 command → ''（待实测校准）
    frame = _approval_requested(systemRunPlan={'command': 'openclaw wiki compile'})
    out = translator.translate(frame)
    assert out[0]['command'] == 'openclaw wiki compile'
    frame2 = _approval_requested(command='echo hi')
    assert translator.translate(frame2)[0]['command'] == 'echo hi'


def test_approval_requested_missing_command_tolerated(translator):
    # 无 command 字段仍出卡（前端显示占位），不吞掉事件
    out = translator.translate(_approval_requested())
    assert out == [{'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': ''}]


def test_approval_requested_missing_id_returns_empty(translator):
    # 无稳定审批 id 则无法 resolve → 不出卡（否则产生一张永远批不了的卡）
    frame = {'type': 'event', 'event': 'exec.approval.requested', 'payload': {'command': 'x'}}
    assert translator.translate(frame) == []


def test_approval_requested_defaults_kind(translator):
    # kind 缺省退 'exec'（decision 回覆需 id+kind+decision 三字段，spec §8.2）
    frame = {'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-9'}}
    out = translator.translate(frame)
    assert out[0]['kind'] == 'exec'


def test_plugin_approval_requested_also_translated(translator):
    # plugin.approval.requested（插件审批流，r26:51）同样翻译出卡，kind 取 payload 值
    frame = {'type': 'event', 'event': 'plugin.approval.requested',
             'payload': {'id': 'ap-2', 'kind': 'plugin', 'command': 'plugin do-thing'}}
    out = translator.translate(frame)
    assert out == [{'type': 'approval', 'id': 'ap-2', 'kind': 'plugin', 'command': 'plugin do-thing'}]


def test_non_chat_event_returns_empty(translator):
    # tool/cot 事件 MVP 不处理（spec §8.3 待实测）——approval 已单列，此处用 tool 事件名
    frame = {'type': 'event', 'event': 'tool.start', 'payload': {'runId': 'r1'}}
    assert translator.translate(frame) == []


def test_non_event_frame_returns_empty(translator):
    # req/res 帧不属于 chat 事件流
    assert translator.translate({'type': 'res', 'id': 'x', 'ok': True}) == []


def test_missing_run_id_returns_empty(translator):
    frame = {'type': 'event', 'event': 'chat', 'payload': {'state': 'delta', 'deltaText': 'x'}}
    assert translator.translate(frame) == []


def test_delta_replace_without_snapshot_or_delta_text_returns_empty(translator):
    # replace=true 但既无 message 快照也无 deltaText → 无可发增量 → []
    assert translator.translate(_chat('delta', replace=True)) == []


def test_delta_message_variant_returns_empty(translator):
    # delta 的 message 变体（非 replace 快照）MVP 不处理 → []
    assert translator.translate(_chat('delta', message='消息级 delta')) == []


def test_chat_event_without_state_returns_empty(translator):
    frame = {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1'}}
    assert translator.translate(frame) == []


def test_unknown_state_returns_empty(translator):
    # 未知 state 不猜测，留待协议实测明确后再扩展
    assert translator.translate(_chat('streaming')) == []
