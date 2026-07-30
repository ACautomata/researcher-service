"""seam: chat.consumers —— issue #214 T2 发送失效自愈 + codex #219 各轮加固。

从 test_consumers.py 拆出（该文件超 pylint C0302 1000 行阈值）：consumer 检测 cached client dead /
RPC 撞死 socket（ConnectionClosed）→ 经 pool evict + get_or_create 有界重取重试一次 → 迁移全体
审批订阅者 + 补拉待审批。共享 seam（FakePool/FakeChatClient/fixtures）在 conftest.py。
"""
import asyncio

import pytest
from websockets.exceptions import ConnectionClosedOK

from chat.chat_client import (
    ChatSendError,
    ChatSendTransmittedError,
)
from chat.tests.conftest import (
    FakeChatClient,
    _connect_authed,
)

pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]

# ── issue #214 T2：consumer 发送失效自愈（检测 dead，有界重取重试一次）────────────
# 一次 task 取消 / 跨 loop 清理（REST 触发，根因归 #201）后，pool 已驱逐重建新 client，
# 但本 consumer 仍缓存旧死 client。自愈：_handle_send/_handle_resolve 失败时检测
# self._client.dead，dead 则经 get_or_create(self._instance) 重取一次并重试（有界一次，
# 防循环）；重取成功后刷新 approval 订阅（旧退订、新订阅，对齐 _handle_start 切换逻辑）。
# 非 dead 的失败（如 rate limit）不重取，直接 error 帧。dead 判定靠 #213 T1 保证。


@pytest.mark.asyncio
async def test_send_dead_client_reacquires_and_retries(override_pool, instance, fake_client):
    """AC1：cached client dead 且 send 抛错 → 重取一次 + 新 client 重试成功发流。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    # pool 驱逐旧死 client、重建新 client（模拟 #213 看门狗置 dead 后的重建）。
    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True  # consumer 缓存的旧 client 已死

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)  # 等自愈重取 + 新 client 注册 on_event
    await fresh.emit({'type': 'text', 'runId': 'run-1', 'delta': '你好'})
    await fresh.emit({'type': 'done', 'runId': 'run-1'})
    text_frame = await comm.receive_json_from()
    assert text_frame == {'type': 'text', 'runId': 'run-1', 'delta': '你好'}
    done_frame = await comm.receive_json_from()
    assert done_frame == {'type': 'done', 'runId': 'run-1'}
    # 有界一次重取：start 一次 + 自愈一次，共两次，无循环
    assert override_pool.created == ['demo', 'demo']
    assert fresh.sent == [('sk-1', '你好')]  # 重试落在唯一的新 client 上
    await comm.disconnect()


@pytest.mark.asyncio
async def test_reacquire_refreshes_approval_subscription(override_pool, instance, fake_client):
    """AC2：重取成功后 approval 订阅刷新——旧 client 退订、新 client 订阅本 consumer 回调。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert len(fake_client._approval_subscribers) == 1  # start 已订阅

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': 'hi'})
    await asyncio.sleep(0.05)  # 等自愈完成
    # 旧 client 退订、新 client 订阅（同一 consumer 回调迁移）
    assert fake_client._approval_subscribers == []
    assert len(fresh._approval_subscribers) == 1
    # 新 client 的审批卡能 fan-out 到本 consumer
    await fresh.emit_approval({'type': 'approval', 'id': 'ap-9', 'kind': 'exec', 'command': 'x'})
    # 先排空 send 自愈成功的无任何帧——send 成功不推帧，直接收审批卡
    frame = await comm.receive_json_from()
    assert frame == {'type': 'approval', 'id': 'ap-9', 'kind': 'exec', 'command': 'x'}
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_dead_client_reacquires_and_retries(override_pool, instance, fake_client):
    """AC3：_handle_resolve 复用同一自愈 helper——dead + resolve 抛错 → 重取重试一次。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_resolve(*args):
        raise ChatSendError('client not connected')

    fake_client.resolve_approval = dead_resolve

    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    # resolve 成功是静默的（无 immediate 帧，权威值由 resolved 事件落地，codex P2 #163）
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(comm.receive_json_from(), timeout=0.5)
    # 重试落在新 client 上；有界一次重取
    assert fresh.resolved == [('ap-1', 'exec', 'allow-once')]
    assert override_pool.created == ['demo', 'demo']
    await comm.disconnect()


@pytest.mark.asyncio
async def test_send_nondead_failure_does_not_reacquire(override_pool, instance, fake_client):
    """AC4：send 失败但 client 非 dead（如 rate limit）→ 不重取，直接 error 帧。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert override_pool.created == ['demo']  # start 取一次

    async def fail_send(*args, **kwargs):
        raise ChatSendError('rate limit')

    fake_client.send_message = fail_send  # 非 dead（fake_client.dead 仍 False）

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'hi'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    # 非 dead：不触发重取，仍只 start 那一条
    assert override_pool.created == ['demo']
    await comm.disconnect()


# ── codex #219 P1 回归：自愈重试的两处漏洞 ────────────────────────────────────
# ① 自愈重试须复用同一 idempotencyKey——否则网关收下原 chat.send 但 ack 随死连接丢失时，
#    重试带新 key 会被当作新操作，起两个 run、工具被执行两次。
# ② 自愈换 client 后须补拉 list_pending_approvals——订阅只投未来事件，旧 client 收循环
#    死亡期间积累的待审批不随新订阅到达，不补拉则 agent 卡死直到用户手动再 start。


@pytest.mark.asyncio
async def test_send_initial_and_retry_share_same_key(override_pool, instance, fake_client):
    """codex #219 P1①：初次与重试携带**相同** idempotencyKey（捕捉初次 key 比对重试 key）。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    fake_client.dead = True

    captured = []  # 初次发送实际收到的 key

    async def dead_send(session_key, message, *, on_event, idempotency_key=None):
        captured.append(idempotency_key)
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)
    assert len(captured) == 1  # 初次一次
    assert len(fresh.sent_idempotency_keys) == 1  # 重试一次
    # 关键：初次 key == 重试 key（网关据此幂等去重，不起两个 run）
    assert captured[0] == fresh.sent_idempotency_keys[0]
    assert captured[0]  # 非空
    await comm.disconnect()


@pytest.mark.asyncio
async def test_reacquire_pulls_pending_approvals(override_pool, instance, fake_client):
    """codex #219 P1②：自愈换 client 后补拉待审批——死循环期间积累的卡经新 client 补到前端。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    # 旧 client 收循环死亡期间积累的待审批：换到的新 client 经 list_pending_approvals 返回
    fresh.pending = [{'type': 'approval', 'id': 'ap-pend', 'kind': 'exec', 'command': 'curl x'}]
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': 'hi'})
    # 自愈换 client 后补拉的待审批卡应被推到前端（send 成功不推帧，首个收到的即是补拉卡）
    frame = await comm.receive_json_from()
    assert frame == {'type': 'approval', 'id': 'ap-pend', 'kind': 'exec', 'command': 'curl x'}
    await comm.disconnect()


@pytest.mark.asyncio
async def test_reacquire_migrates_all_shared_subscribers(override_pool, instance, fake_client):
    """codex #219 P2：共享 client 自愈——所有 consumer（不只触发自愈的）迁到 fresh 并收补拉卡。

    A 触发自愈换 client；被动 consumer B 不能滞留死 client——B 的订阅也迁到 fresh，
    补拉的待审批 fan-out 到 A、B 两端（保住共享 fan-out 契约）。
    """
    comm_a = await _connect_authed('alice')
    await comm_a.connect()
    await comm_a.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_a.receive_json_from()  # A ready
    comm_b = await _connect_authed('bob')
    await comm_b.connect()
    await comm_b.send_json_to({'type': 'start', 'container': 'demo'})
    await comm_b.receive_json_from()  # B ready
    assert len(fake_client._approval_subscribers) == 2  # A、B 共享旧 client

    fresh = FakeChatClient()
    fresh.pending = [{'type': 'approval', 'id': 'ap-shared', 'kind': 'exec', 'command': 'curl y'}]
    override_pool.set_client(fresh)
    fake_client.dead = True

    async def dead_send(*args, **kwargs):
        raise ChatSendError('client not connected')

    fake_client.send_message = dead_send

    # A 触发 send → 旧 client dead → 自愈换 fresh
    await comm_a.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': 'hi'})
    # 补拉的待审批卡 fan-out：A、B 都收到（不只 A）
    fa = await comm_a.receive_json_from()
    fb = await comm_b.receive_json_from()
    assert fa == {'type': 'approval', 'id': 'ap-shared', 'kind': 'exec', 'command': 'curl y'}
    assert fb == {'type': 'approval', 'id': 'ap-shared', 'kind': 'exec', 'command': 'curl y'}
    # 全部订阅者迁到 fresh（旧 client 退空、fresh 有 A+B 两个）
    assert fake_client._approval_subscribers == []
    assert len(fresh._approval_subscribers) == 2
    # B 也能收 fresh 上的新审批（不只 A）
    await fresh.emit_approval({'type': 'approval', 'id': 'ap-live', 'kind': 'exec', 'command': 'z'})
    fb2 = await comm_b.receive_json_from()
    assert fb2['id'] == 'ap-live'
    await comm_a.disconnect()
    await asyncio.sleep(0.02)
    # codex #219 P2 残留泄漏修复：被动 consumer B 断开时经 pool 再解析活 client（fresh）退订——
    # 不能因缓存的 self._client 仍是死 client 而把 B 的回调泄漏在 fresh 上。
    await comm_b.disconnect()
    await asyncio.sleep(0.02)
    assert len(fresh._approval_subscribers) == 0  # A、B 均从 fresh 退订，无泄漏


# ── codex #219 P1③：已发出但 ack 丢失的 send 不盲重试 ────────────────────────
# 帧已 send、ack 在连接死前丢失（ChatSendTransmittedError）：网关可能已起 run，其事件流
# 绑在死连接上（runId 连接级，重连不可恢复）。盲重试被幂等去重到同一 runId，但新 route
# 收不到事件 → 浏览器 pending 永久卡。故 consumer 不重试，发终态 error 解锁前端。


@pytest.mark.asyncio
async def test_send_transmitted_failure_does_not_retry(override_pool, instance, fake_client):
    """codex #219 P1③：原 send 已发出但 ack 丢失 → 不重发 chat.send，发终态 error 帧。

    codex #219 P1 二轮：但**仍重取连接**（迁移全体订阅者 + 补拉待审批）——旧 client 已死，
    被收下的 run 若起审批须能经新连接投递/补拉，不因 skip 重发而滞留死 client。
    """
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert override_pool.created == ['demo']  # start 取一次

    fresh = FakeChatClient()
    fresh.pending = [{'type': 'approval', 'id': 'ap-accepted', 'kind': 'exec', 'command': 'curl z'}]
    override_pool.set_client(fresh)
    fake_client.dead = True  # 旧 client 已死

    async def transmitted_send(*args, **kwargs):
        raise ChatSendTransmittedError('chat.send ack timeout')  # 帧已发出、ack 丢失

    fake_client.send_message = transmitted_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    # 重取后补拉的待审批卡先到（被收下的 run 起的审批经新连接恢复）
    approval_frame = await comm.receive_json_from()
    assert approval_frame == {'type': 'approval', 'id': 'ap-accepted', 'kind': 'exec', 'command': 'curl z'}
    # 再收到终态 error 帧（解锁前端 pending）
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert '结果未知' in resp['message']
    # 不重发 chat.send：fresh 上无 send；但**已重取**连接（start 一次 + 自愈一次）
    assert not fresh.sent
    assert override_pool.created == ['demo', 'demo']
    # 本 consumer 的审批订阅已迁到 fresh（死 client 退空）
    assert fake_client._approval_subscribers == []
    assert len(fresh._approval_subscribers) == 1
    await comm.disconnect()


# ── codex #219 三轮 P2：RPC 自身检测死 socket 的竞态 ─────────────────────────
# send_message/resolve_approval 在刚关闭的 socket 上 ws.send() 抛原生 ConnectionClosed
# （与 ChatClientError/ChatSendError 均不相交），后台 recv task 可能还没跑异常处理器置
# client.dead。guard 只看 dead 会误判 → 返回 None → 误报失败。ConnectionClosed 本身即
# 连接已断的充分证据（帧未发出、网关未起 run），与 dead 并列触发重取；业务拒绝
# （ChatSendError rate limit）不传 evidence → 不重取。


@pytest.mark.asyncio
async def test_send_dead_socket_rpc_error_reacquires_despite_flag_unset(
        override_pool, instance, fake_client):
    """codex #219 三轮 P2-436：send 抛原生 ConnectionClosed（帧未发出）但 dead 未置位 → 仍重取重试。

    竞态：recv task 尚未置 dead，guard 若只看 dead 会漏。ConnectionClosed（与 ChatSendError
    业务拒绝不相交）本身即连接已断的充分证据。
    """
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    # 关键：dead **不**置位（模拟竞态——RPC 先于 recv task 检测到 socket 死）
    assert fake_client.dead is False

    async def dead_socket_send(session_key, message, *, on_event, idempotency_key=None):
        # 真实竞态：ws.send 在刚关闭的 socket 上抛原生 ConnectionClosed（与 ChatClientError/
        # ChatSendError 均不相交），recv task 尚未置 dead。帧未发出、网关未起 run。
        raise ConnectionClosedOK(None, None)

    fake_client.send_message = dead_socket_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)
    await fresh.emit({'type': 'text', 'runId': 'run-1', 'delta': '你好'})
    await fresh.emit({'type': 'done', 'runId': 'run-1'})
    text_frame = await comm.receive_json_from()
    assert text_frame == {'type': 'text', 'runId': 'run-1', 'delta': '你好'}
    done_frame = await comm.receive_json_from()
    assert done_frame == {'type': 'done', 'runId': 'run-1'}
    # 虽 dead 未置位，连接级异常仍触发有界一次重取（start + 自愈）
    assert override_pool.created == ['demo', 'demo']
    assert fresh.sent == [('sk-1', '你好')]
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_dead_socket_rpc_error_reacquires_despite_flag_unset(
        override_pool, instance, fake_client):
    """codex #219 三轮 P2-436：resolve 抛原生 ConnectionClosed 但 dead 未置位 → 仍重取重试。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    fresh = FakeChatClient()
    override_pool.set_client(fresh)
    assert fake_client.dead is False  # 竞态：dead 未置位

    async def dead_socket_resolve(*args):
        raise ConnectionClosedOK(None, None)  # ws.send 撞刚死 socket（竞态，dead 未置位）

    fake_client.resolve_approval = dead_socket_resolve

    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    with pytest.raises(asyncio.TimeoutError):  # resolve 成功静默
        await asyncio.wait_for(comm.receive_json_from(), timeout=0.5)
    assert fresh.resolved == [('ap-1', 'exec', 'allow-once')]
    assert override_pool.created == ['demo', 'demo']
    await comm.disconnect()


@pytest.mark.asyncio
async def test_send_rate_limit_senderror_still_no_reacquire(override_pool, instance, fake_client):
    """对照：业务级拒绝（ChatSendError rate limit，dead 未置位）**不**重取——帧已达网关被拒，
    非连接断，重连无意义。守住「只连接级异常才重取」的边界。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert override_pool.created == ['demo']
    assert fake_client.dead is False

    async def rate_limit_send(*args, **kwargs):
        raise ChatSendError('rate limit')  # ChatSendError 子类=业务拒绝，非连接级

    fake_client.send_message = rate_limit_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'hi'})
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert override_pool.created == ['demo']  # 不重取
    await comm.disconnect()


# ── codex #219 四轮 P2-891：evidence 证明死须先 evict 再 get_or_create ────────
# 三轮 P2-436 的测试用 set_client(fresh) 预先换掉 pool 的 client，掩盖了生产竞态：真实
# pool.get_or_create 快路径（pool.py:80-82）只看 dead==False，evidence（ConnectionClosed）
# 证明已死但 dead 未置位时返回**同一个**濒死 client → consumer identity check 放弃恢复。
# 这里**不**预先 set_client——只有 consumer 先 evict 驱逐旧 client，get_or_create 才会重建。


@pytest.mark.asyncio
async def test_send_dead_socket_evicts_stale_client_before_reacquire(
        override_pool, instance, fake_client):
    """codex #219 四轮 P2-891：ConnectionClosed 且 dead 未置位时，consumer 先 evict 再重取。

    复刻生产竞态（不预先 set_client）：若 consumer 不 evict，真 pool 快路径返回同一 client，
    identity check 放弃恢复、误报失败。evict 后 get_or_create 才重建新 client。
    """
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert override_pool.created == ['demo']

    # 竞态：dead 未置位（recv task 尚未跑异常处理器），但 ws.send 已撞刚死 socket
    assert fake_client.dead is False
    fresh = FakeChatClient()
    override_pool.stage_next(fresh)  # evict 后 get_or_create 应重建出 fresh（真实 pool 行为）

    async def dead_socket_send(session_key, message, *, on_event, idempotency_key=None):
        raise ConnectionClosedOK(None, None)  # evidence：帧未发出、连接已断

    fake_client.send_message = dead_socket_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    await asyncio.sleep(0.05)
    await fresh.emit({'type': 'text', 'runId': 'run-1', 'delta': '你好'})
    await fresh.emit({'type': 'done', 'runId': 'run-1'})
    assert (await comm.receive_json_from())['type'] == 'text'
    assert (await comm.receive_json_from())['type'] == 'done'
    # consumer 先 evict 驱逐濒死 client，get_or_create 才重建出 fresh 完成有界重试
    assert override_pool.evicted == ['demo']
    assert override_pool.created == ['demo', 'demo']
    assert fresh.sent == [('sk-1', '你好')]
    await comm.disconnect()


@pytest.mark.asyncio
async def test_resolve_dead_socket_evicts_stale_client_before_reacquire(
        override_pool, instance, fake_client):
    """codex #219 四轮 P2-891：resolve 撞死 socket（dead 未置位）也先 evict 再重取。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert fake_client.dead is False

    fresh = FakeChatClient()
    override_pool.stage_next(fresh)

    async def dead_socket_resolve(*args):
        raise ConnectionClosedOK(None, None)

    fake_client.resolve_approval = dead_socket_resolve

    await comm.send_json_to({'type': 'resolve', 'id': 'ap-1', 'kind': 'exec', 'decision': 'allow-once'})
    with pytest.raises(asyncio.TimeoutError):  # resolve 成功静默
        await asyncio.wait_for(comm.receive_json_from(), timeout=0.5)
    assert override_pool.evicted == ['demo']
    assert override_pool.created == ['demo', 'demo']
    assert fresh.resolved == [('ap-1', 'exec', 'allow-once')]
    await comm.disconnect()


# ── codex #219 四轮 P2-895：重试的 send 变 transmitted 也须补重取 ────────────
# 初次失败触发自愈换到 fresh，但 fresh 在发出重试的 chat.send 后又死（ack 丢失）——
# 迁移过去的全体审批订阅者还挂在新死的 fresh 上。被收下的 run 若起审批，不经再次重取
# 补拉会一直阻塞。故重试 transmitted 分支也须做同样的连接/订阅者恢复（仍不重发消息）。


@pytest.mark.asyncio
async def test_retried_send_transmitted_reacquires_again(override_pool, instance, fake_client):
    """codex #219 四轮 P2-895：重试的 send 变 transmitted（fresh 发出后死）→ 再重取迁移订阅者。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready

    # 初次 send：fake_client dead → 自愈换到 fresh
    fake_client.dead = True
    fresh = FakeChatClient()
    override_pool.set_client(fresh)

    async def first_send_dead(*args, **kwargs):
        raise ChatSendError('client dead')  # 初次失败（非 transmitted）→ 触发自愈

    fake_client.send_message = first_send_dead

    # fresh 发出重试的 chat.send 后死掉（ack 丢失 → transmitted），但 pool 已重建出更新 client
    newer = FakeChatClient()
    newer.pending = [{'type': 'approval', 'id': 'ap-retry', 'kind': 'exec', 'command': 'curl z'}]

    async def fresh_transmitted_send(*args, **kwargs):
        # fresh 发出帧后死：ack 丢失（recv loop 死 → 真实 client 会置 dead，复刻之）。
        # pool 再次重建出 newer（newer 是 get_or_create 下一返回）。
        fresh.dead = True  # transmitted ⇒ 连接已死（ack 丢失只因 recv loop 死），真实 client 必置位
        override_pool.set_client(newer)
        raise ChatSendTransmittedError('retried chat.send ack timeout')

    fresh.send_message = fresh_transmitted_send

    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk-1', 'message': '你好'})
    # 再次重取后补拉 newer 上的待审批卡（被收下 run 起的审批经新连接恢复）
    approval_frame = await comm.receive_json_from()
    assert approval_frame == {'type': 'approval', 'id': 'ap-retry', 'kind': 'exec', 'command': 'curl z'}
    # 再收到终态 error 帧（仍不重发，解锁前端 pending）
    resp = await comm.receive_json_from()
    assert resp['type'] == 'error'
    assert '结果未知' in resp['message']
    # 连接被重取两次：start + 初次自愈 + 重试 transmitted 自愈
    assert override_pool.created == ['demo', 'demo', 'demo']
    # 订阅者最终迁到 newer（fresh 已死、退空）
    assert len(newer._approval_subscribers) == 1
    await comm.disconnect()


# ── codex #219 三轮 P2-444：退订须落到持有回调的 client ─────────────────────
# POST /pairing/ force-repair 换 device_token 后，pool 可同时有旧 token client + 新 token
# live client。get_live 只返回新 client，但本 consumer 的回调/active runId 可能还在旧
# self._client 上。disconnect/切容器只退新 client 会把回调泄漏在旧 client（关闭的 consumer
# 仍被旧 client fan-out）。须从持有回调的 client（[live, self._client] 去重）都退订 + discard。


@pytest.mark.asyncio
async def test_disconnect_unsubscribes_from_both_stale_and_live(override_pool, instance, fake_client):
    """codex #219 三轮 P2-444：force-repair 换 token 后 disconnect，旧 self._client 上的回调也退订。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    assert len(fake_client._approval_subscribers) == 1  # 回调在旧 client（self._client）上

    # force-repair：pool 换成新 token 的 live client（非 dead），但本 consumer 未重连——
    # self._client 仍是旧 client，回调还挂在旧 client 上。get_live 只返回新 client。
    new_live = FakeChatClient()
    override_pool.set_client(new_live)

    await comm.disconnect()
    await asyncio.sleep(0.05)
    # 旧 client 上的回调须退订（不漏），新 live client 上本就无（幂等无害）
    assert fake_client._approval_subscribers == []
    await comm.disconnect()


@pytest.mark.asyncio
async def test_disconnect_discards_runs_on_callback_owning_client(override_pool, instance, fake_client):
    """codex #219 三轮 P2-444：active runId 的 discard 也须落到持有路由的旧 self._client。"""
    comm = await _connect_authed()
    await comm.connect()
    await comm.send_json_to({'type': 'start', 'container': 'demo'})
    await comm.receive_json_from()  # ready
    # 在旧 client 上发一条 → run-1 路由注册在旧 client
    await comm.send_json_to({'type': 'send', 'sessionKey': 'sk', 'message': 'hi'})
    await asyncio.sleep(0.05)

    # force-repair：pool 换新 token live client；旧 self._client 仍持有 run-1 路由
    new_live = FakeChatClient()
    override_pool.set_client(new_live)

    await comm.disconnect()
    await asyncio.sleep(0.05)
    # run-1 的 discard 须落到旧 client（路由持有者），不是只落到新 live client
    assert 'run-1' in fake_client.discarded
    await comm.disconnect()
