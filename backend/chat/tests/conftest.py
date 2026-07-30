"""chat consumer 测试共享 seam：FakeChatClient / FakePool / NotPairedPool + 连接助手 + fixtures。

供 test_consumers.py（握手/审批契约）与 test_consumers_self_heal.py（issue #214 自愈 + codex #219）
共用。WebsocketCommunicator 经 config.asgi.application（含 JwtAuthMiddleware）；ChatFleet.override
注入 FakePool（FakeChatClient 记录 send_message、可 emit 事件回调）。
"""
import pytest
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import RefreshToken

from chat.pool import ChatFleet, NotPaired
from config.asgi import application
from containers.models import Instance

User = get_user_model()


class FakeChatClient:
    """记录 send_message 的 client 替身；emit 直接触发注册过的 on_event 回调。"""

    def __init__(self):
        self.sent = []  # (session_key, message)
        self._handlers = {}
        self.discarded = []
        self.resolved = []  # (approval_id, kind, decision)
        self.resolve_payload = {}  # resolve_approval 返回的权威 payload
        self.pending = []  # start 时补拉的待审批卡（codex P2 断线恢复）
        self._approval_subscribers = []
        # issue #214 T2：对齐真实 client 的 public dead 契约（chat_client.dead = _dead or _closed）。
        # consumer 自愈据此判定；真实场景由 #213 T1 看门狗/CancelledError 置位。
        self.dead = False
        # codex #219 P1：记录每次 send_message 收到的 idempotency_key（验证重试复用同 key）。
        self.sent_idempotency_keys = []

    async def send_message(self, session_key, message, *, on_event, idempotency_key=None):
        run_id = f'run-{len(self.sent) + 1}'
        self.sent.append((session_key, message))
        self.sent_idempotency_keys.append(idempotency_key)
        self._handlers[run_id] = on_event
        return run_id

    def discard(self, run_id):
        self.discarded.append(run_id)
        self._handlers.pop(run_id, None)

    async def emit(self, frame):
        cb = self._handlers.get(frame.get('runId'))
        if cb is not None:
            await cb(frame)

    # T06：订阅者集合（codex P1）+ 权威 decision 回覆 + start 补拉待审批（codex P2）
    def add_approval_subscriber(self, cb):
        if cb not in self._approval_subscribers:
            self._approval_subscribers.append(cb)

    def remove_approval_subscriber(self, cb):
        if cb in self._approval_subscribers:
            self._approval_subscribers.remove(cb)

    def approval_subscribers(self):
        # codex #219 P2：对齐真实 client 的迁移访问器（_reacquire_client 迁全部订阅者用）。
        return list(self._approval_subscribers)

    async def resolve_approval(self, approval_id, kind, decision):
        self.resolved.append((approval_id, kind, decision))
        return self.resolve_payload

    async def broadcast_approval_resolved(self, approval_id, decision):
        # 与真实 client 一致：fan-out approvalResolved 到全部订阅者（codex R2 P2 副本收敛）
        await self.emit_approval({'type': 'approvalResolved', 'id': approval_id, 'decision': decision})

    async def list_pending_approvals(self):
        return list(self.pending)

    async def emit_approval(self, frame):
        for cb in list(self._approval_subscribers):
            await cb(frame)


class FakePool:
    def __init__(self, client):
        self._client = client
        self.created = []
        self.evicted = []  # codex #219 四轮 P2-891：记录 evict 调用（consumer 重取前驱逐濒死 client）
        self._next = None  # stage_next 预排的、evict 后 get_or_create 应返回的新 client

    def set_client(self, client):
        # issue #214：替换 get_or_create 将返回的 client（模拟 pool 驱逐死连接后重建新 client）。
        self._client = client

    async def get_or_create(self, instance):
        self.created.append(instance.name)
        return self._client

    async def evict(self, instance):
        # codex #219 四轮 P2-891：对齐真 pool.evict——把当前 client 标记移出（置 None），
        # 下次 get_or_create 返回 _next（模拟重建的新 client）。无 _next 则维持 _client。
        self.evicted.append(instance.name)
        if self._next is not None:
            self._client = self._next
            self._next = None

    def stage_next(self, client):
        """预排 evict 后 get_or_create 应返回的新 client（模拟真 pool 驱逐后重建）。"""
        self._next = client

    async def get_live(self, instance):
        # codex #219 P2：对齐真实 pool 的非创建式查活——返回当前存活 client（dead 则 None）。
        if self._client is not None and not getattr(self._client, 'dead', False):
            return self._client
        return None

    async def reacquire(self, instance, expected_client):
        # codex #219 六轮 P1-872：对齐真 pool.reacquire 的锁内语义——
        # 缓存项健康且非 expected_client（别的 consumer 已换好）→ 采纳，不 evict 不重建；
        # 否则（缓存==expected 死/濒死 client，或已驱逐无缓存）→ 驱逐并重建（经 _next / set_client）。
        # codex #219 十四轮 P2-183：返回 (fresh, replaced)——replaced 是实际驱逐的缓存 client
        # （采纳路径无驱逐 → None），供 consumer 从被替换的那代迁订阅者。
        self.created.append(instance.name)
        cur = self._client
        if cur is not None and not getattr(cur, 'dead', False) and cur is not expected_client:
            return cur, None  # 采纳 peer 换好的健康连接（无驱逐）
        # 驱逐自己持有的死/濒死 client 并重建
        replaced = cur
        self.evicted.append(instance.name)
        if self._next is not None:
            self._client = self._next
            self._next = None
        return self._client, replaced


class NotPairedPool:
    async def get_or_create(self, instance):
        raise NotPaired('pending', 'req-9')

    async def evict(self, instance):
        return None  # codex #219 四轮 P2-891：自愈重取前先 evict，未配对 noop

    async def reacquire(self, instance, expected_client):
        raise NotPaired('pending', 'req-9')  # codex #219 六轮 P1：未配对重取也抛 NotPaired

    async def get_live(self, instance):
        return None


async def _access_token(username='alice'):
    user = await database_sync_to_async(User.objects.create_user)(
        username=username, password='strong-pass-1')
    return str(RefreshToken.for_user(user).access_token)


async def _connect_authed(username='alice'):
    token = await _access_token(username)
    return WebsocketCommunicator(
        application, '/ws/chat/', subprotocols=['access_token', token])


@pytest.fixture
def fake_client():
    return FakeChatClient()


@pytest.fixture
def override_pool(fake_client):
    pool = FakePool(fake_client)
    ChatFleet.override(pool)
    yield pool
    ChatFleet.reset()


@pytest.fixture
def instance():
    return Instance.objects.create(
        name='demo', port=19000, token='gw', home_dir='/tmp/x',
        status=Instance.STATUS_RUNNING, image='img:tag',
    )
