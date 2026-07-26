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


def test_unknown_state_returns_empty(translator):  # pylint: disable=function-redefined
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
        {'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'rm -rf /tmp/x', 'sessionKey': None},
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
    assert out == [{'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': '', 'sessionKey': None}]


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
    assert out == [{'type': 'approval', 'id': 'ap-2', 'kind': 'plugin',
                    'command': 'plugin do-thing', 'sessionKey': None}]


def test_approval_kind_falls_back_to_event_name_family(translator):
    """codex/审查 P1：payload 缺 kind 时从事件名派生（exec/plugin），不可一律回退 'exec'。

    r26 §1：payload 只保证稳定 id + systemRunPlan，kind 非文档字段；缺省时须按事件族派生，
    否则 plugin 审批会以 kind='exec' 回覆 approval.resolve（类型无关审批对要求匹配 kind）。
    """
    frame = {'type': 'event', 'event': 'plugin.approval.requested', 'payload': {'id': 'ap-7'}}
    out = translator.translate(frame)
    assert out[0]['kind'] == 'plugin'
    frame2 = {'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-8'}}
    assert translator.translate(frame2)[0]['kind'] == 'exec'


def test_approval_card_carries_session_key(translator):
    """codex P1：systemRunPlan.sessionKey 透传到卡片，前端据此把审批归属到对应会话过滤。"""
    frame = {'type': 'event', 'event': 'exec.approval.requested',
             'payload': {'id': 'ap-1', 'systemRunPlan': {'rawCommand': 'x', 'sessionKey': 'sess-9'}}}
    out = translator.translate(frame)
    assert out[0]['sessionKey'] == 'sess-9'


def test_approval_card_session_key_absent_tolerated(translator):
    # 无 systemRunPlan/sessionKey（连接级审批未必挂会话）→ sessionKey 为 None，前端按当前会话处理
    frame = {'type': 'event', 'event': 'exec.approval.requested', 'payload': {'id': 'ap-1', 'command': 'x'}}
    out = translator.translate(frame)
    assert out[0]['sessionKey'] is None


def test_non_chat_event_returns_empty(translator):
    # 未证实的事件名（tool.start，非 agent.tool.*）不猜测处理——T08 工具事件走 agent.tool.start/result
    frame = {'type': 'event', 'event': 'tool.start', 'payload': {'runId': 'r1'}}
    assert translator.translate(frame) == []


# ---- T08 工具执行（issue #44 / spec §8.2/§9.4 / r26 §3）----
# agent.tool.start / agent.tool.result（r26 §3 二手线索；**确切事件名/payload 待配对后实测校准**，
# r26 §0 警告 agent.* 族与 chat 单事件模型冲突）→ 工具帧。工具挂在 chat run 内（r26 §3），帧带 runId
# 走既有 runId 路由；前端只显一行标题+状态（spec §9.4）。事件名集中常量便于实测后单点校准。


def _tool(event: str, run_id: str = 'r1', **extra) -> dict:
    payload = {'runId': run_id}
    payload.update(extra)
    return {'type': 'event', 'event': event, 'payload': payload}


def test_tool_start_becomes_tool_running_frame(translator):
    # agent.tool.start → 工具 running 帧；name 取 payload.tool，title/input 透传，result 占位 None（统一 shape）
    frame = _tool('agent.tool.start', tool='wiki.search', toolCallId='call-1', title='检索 wiki',
                  input={'query': '对比学习'})
    assert translator.translate(frame) == [
        {'type': 'tool', 'runId': 'r1', 'name': 'wiki.search', 'state': 'running',
         'id': 'call-1', 'title': '检索 wiki', 'input': {'query': '对比学习'}, 'result': None},
    ]


def test_tool_call_id_fallbacks(translator):
    # id 取值链（codex P2，字段名待实测校准）：toolCallId → tool_call_id → callId → id；缺省 None
    assert translator.translate(_tool('agent.tool.start', tool='x', toolCallId='c1'))[0]['id'] == 'c1'
    assert translator.translate(_tool('agent.tool.start', tool='x', tool_call_id='c2'))[0]['id'] == 'c2'
    assert translator.translate(_tool('agent.tool.start', tool='x', callId='c3'))[0]['id'] == 'c3'
    assert translator.translate(_tool('agent.tool.start', tool='x', id='c4'))[0]['id'] == 'c4'
    assert translator.translate(_tool('agent.tool.start', tool='x'))[0]['id'] is None


def test_tool_result_becomes_tool_done_frame(translator):
    # agent.tool.result → done 帧；result 字段透传（前端显"· N 结果"摘要）；title/input/id 缺省 None
    frame = _tool('agent.tool.result', tool='wiki.search', result={'count': 3})
    assert translator.translate(frame) == [
        {'type': 'tool', 'runId': 'r1', 'name': 'wiki.search', 'state': 'done',
         'id': None, 'title': None, 'input': None, 'result': {'count': 3}},
    ]


def test_tool_event_missing_run_id_returns_empty(translator):
    # 工具事件必须挂 runId（r26 §3，路由到所属 chat run）；无 runId → 不投递
    frame = {'type': 'event', 'event': 'agent.tool.start', 'payload': {'tool': 'x'}}
    assert translator.translate(frame) == []


def test_tool_event_missing_name_returns_empty(translator):
    # 无工具名 → 无法渲染工具行 → []（对网关 payload 0 信任；字段名待实测校准）
    assert translator.translate(_tool('agent.tool.start')) == []


def test_tool_name_fallbacks(translator):
    # name 取值链（字段名待实测校准）：payload.tool → payload.name → payload.toolName
    assert translator.translate(_tool('agent.tool.start', name='fs.read'))[0]['name'] == 'fs.read'
    assert translator.translate(_tool('agent.tool.start', toolName='bash'))[0]['name'] == 'bash'


def test_tool_input_result_fallbacks(translator):
    # input 取 input→args；result 取 result→output（字段名待实测校准）
    out = translator.translate(_tool('agent.tool.result', tool='bash', args='ls', output='ok'))
    assert out[0]['input'] == 'ls'
    assert out[0]['result'] == 'ok'


# ---- codex R3 P2：网关 resolved 事件（他端 operator 回覆后广播）----
def test_plugin_approval_resolved_becomes_resolved_frame(translator):
    # plugin.approval.resolved（r26:51 文档已证）→ approvalResolved 帧，透传权威 decision
    frame = {'type': 'event', 'event': 'plugin.approval.resolved',
             'payload': {'id': 'ap-1', 'decision': 'deny'}}
    assert translator.translate(frame) == [
        {'type': 'approvalResolved', 'id': 'ap-1', 'decision': 'deny'},
    ]


def test_plugin_approval_resolved_unknown_decision_passes_through(translator):
    # 未知/待实测权威值（expired 等）透传原值，由前端判 unknown 而非默认批准（ChatView onApprovalResolved）
    frame = {'type': 'event', 'event': 'plugin.approval.resolved',
             'payload': {'id': 'ap-1', 'decision': 'expired'}}
    assert translator.translate(frame)[0]['decision'] == 'expired'


def test_plugin_approval_resolved_missing_id_returns_empty(translator):
    # 无 id 无法定位卡片 → 跳过，不伪造 approvalResolved 帧
    frame = {'type': 'event', 'event': 'plugin.approval.resolved', 'payload': {'decision': 'approve'}}
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


def test_unknown_state_returns_empty(translator):  # pylint: disable=function-redefined
    # 未知 state 不猜测，留待协议实测明确后再扩展
    assert translator.translate(_chat('streaming')) == []
