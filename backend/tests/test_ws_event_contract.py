"""L4 T7 chat 事件翻译契约守护（codex #193 P2 R3，issue #184）。

被钉契约：集成测试 ``tests.integration.test_integration_ws`` 记录的事件包络与断言白名单必须
与生产 ``ChatEventTranslator`` 的实际产出一致——

- C5：result+isError=true 时翻译器**故意**发 ``state='error'``（backend/chat/event_translate.py
  ``_translate_tool``），集成断言白名单 ``_ACCEPTED_TOOL_STATES`` 须接纳之；否则真实工具失败
  会被误报为契约失败。
- C4：审批卡的子类型（exec/plugin）在 ``kind`` 键，事件判别符在 ``type`` 键——两键分离；集成
  事件包络用 ``kind:'approval'`` 作判别符、``subtype`` 记子类型。原写法第二个 ``kind`` 覆盖
  判别符致 ``kind=='approval'`` 过滤永不命中、审批断言成死代码。

集成测试只在真 Docker + 真 LLM 环境跑（``-m integration``），本文件把同一契约钉进 CI 单元回归：
driving 真翻译器、零外部依赖（不起 daemon、不连网关）。
"""
from __future__ import annotations

from chat.event_translate import ChatEventTranslator
from integration.openclaw.wire import (
    APPROVAL_REQUESTED_EVENTS,
    TOOL_AGENT_EVENT,
    TOOL_STREAM,
)
from tests.integration.test_integration_ws import _ACCEPTED_TOOL_STATES


class _ToolFrameBuilder:
    """构造网关工具事件帧（event:agent + stream:tool + data.phase），隔离翻译器入参。

    字段布局对齐 ADR-0003 / issue #153 实测：工具事件 = ``event:"agent"`` +
    ``payload.stream:"tool"`` + ``payload.data.phase``；name/toolCallId/args/isError 在 data 下。
    """

    def __init__(self, run_id: str, name: str) -> None:
        self._run_id = run_id
        self._name = name

    def frame(self, phase: str, is_error: bool = False) -> dict:
        data = {'name': self._name, 'phase': phase}
        if phase == 'result':
            data['isError'] = is_error
        return {
            'type': 'event',
            'event': TOOL_AGENT_EVENT,
            'payload': {
                'stream': TOOL_STREAM,
                'runId': self._run_id,
                'data': data,
            },
        }


def test_tool_result_error_state_is_accepted():
    """C5：result+isError=true → 翻译器发 state='error'；集成白名单必须接纳。"""
    builder = _ToolFrameBuilder('run-err', 'shell')
    frames = ChatEventTranslator().translate(builder.frame('result', is_error=True))

    assert len(frames) == 1
    state = frames[0].get('state')
    assert state == 'error', f'translator must emit error for isError tool, got {state!r}'
    assert state in _ACCEPTED_TOOL_STATES, (
        f'integration test must accept translator-emitted tool state {state!r}, '
        f'got whitelist={_ACCEPTED_TOOL_STATES}'
    )


def test_tool_lifecycle_states_subset_of_accepted():
    """C5 完备性：翻译器对工具所有可达 phase 产出的 state 必须全部落在集成白名单内。

    update phase 故意产出空（partial 增量跳过，codex #162 P2），不计入。一旦未来翻译器新增
    终态而忘了同步白名单，或有人把 ``error`` 从白名单移除，这里立刻 red。
    """
    builder = _ToolFrameBuilder('run-life', 'shell')
    emitted: set[str] = set()
    for phase, is_error in (('start', False), ('result', False), ('result', True)):
        frames = ChatEventTranslator().translate(builder.frame(phase, is_error=is_error))
        emitted.update(f.get('state') for f in frames)

    extra = emitted - set(_ACCEPTED_TOOL_STATES)
    assert not extra, f'tool states {extra} leak outside accepted {_ACCEPTED_TOOL_STATES}'
    assert emitted == {'running', 'done', 'error'}, (
        f'expected full tool terminal set, got {emitted!r}'
    )


def test_approval_subtype_distinct_from_discriminator():
    """C4：审批卡子类型在 ``kind`` 键，判别符在 ``type`` 键——两键分离、取值不同。

    集成包络用 ``kind:'approval'`` 作判别符、``subtype`` 记 ``c.kind``；本测试钉住生产侧
    ``_approval_card`` 同时暴露 ``type=='approval'`` 与非空 ``kind`` 子类型，且子类型不与
    'approval' 判别符撞值（否则集成过滤 + 断言会再次失效）。
    """
    event = next(iter(APPROVAL_REQUESTED_EVENTS))  # exec.approval.requested
    frame = {
        'type': 'event',
        'event': event,
        'payload': {
            'id': 'apx-1',
            'request': {'command': 'curl https://example.invalid', 'sessionKey': 'sk-1'},
        },
    }
    cards = ChatEventTranslator().translate(frame)

    assert len(cards) == 1
    card = cards[0]
    assert card.get('type') == 'approval', f'card discriminator must be approval, got {card!r}'
    assert isinstance(card.get('id'), str) and card['id'], (
        f'approval card must carry non-empty id, got {card!r}'
    )
    subtype = card.get('kind')
    assert isinstance(subtype, str) and subtype, (
        f'approval subtype (exec/plugin) must be non-empty string, got {subtype!r}'
    )
    assert subtype != 'approval', (
        f'subtype {subtype!r} must not collide with the approval discriminator'
    )
