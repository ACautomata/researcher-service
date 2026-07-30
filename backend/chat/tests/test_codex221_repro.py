"""codex #221 三条意见的复现（red）：on_dead 时序竞态同根因族。"""
import asyncio
from types import SimpleNamespace

import pytest

from chat.pool import ChatConnectionPool, ReconnectPolicy

pytestmark = pytest.mark.django_db


class FakePairingService:
    def get_status(self, instance):
        return SimpleNamespace(
            status='paired', device_token='dt-1', pairing_request_id='',
            device_id='dev-1', public_key_pem='PUB', private_key_pem='PRIV',
            scopes_json='["operator.read","operator.write","operator.approvals"]')


def _url_for(inst):
    return f'ws://test:{inst.port}/'


def _clock():
    return SimpleNamespace(sleeps=[])


def _sleeper(clock):
    async def s(x):
        clock.sleeps.append(x)
    return s


class EarlyDeathClient:
    """connect 成功后、被放入 _clients 之前就标死并触发 on_dead（P1 场景）。"""

    def __init__(self, url, device_token, *, identity, scopes, on_dead=None, script, index):
        self.url = url
        self.device_token = device_token
        self.identity = identity
        self.scopes = scopes
        self._on_dead = on_dead
        self._script = script
        self._index = index
        self.dead = False
        self.closed = False

    async def connect(self):
        i = self._index[0]
        self._index[0] += 1
        # 第一次建连：握手成功但立即死亡（recv loop 立刻退出），on_dead 在放入 _clients 前触发
        if i == 0:
            self.dead = True
            if self._on_dead is not None:
                self._on_dead(self)  # 此时 _clients[key] 尚无此 client → P1：通知被丢弃

    async def aclose(self):
        self.closed = True

    def discard(self, run_id):
        pass


@pytest.mark.asyncio
async def test_p1_death_before_insertion_is_not_lost():
    """P1：client 在 connect() 后、放入 _clients 前死亡 → on_dead 被丢弃，pool 存入死 client 且无重连。"""
    index = [0]
    clock = _clock()

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return EarlyDeathClient(url, dt, identity=identity, scopes=scopes,
                                on_dead=on_dead, script=None, index=index)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=_sleeper(clock)))
    inst = SimpleNamespace(name='a', port=19001)
    c = await pool.get_or_create(inst)
    # P1 期望：即便插入前死亡，pool 也应检测到并安排重连（或至少不返回死 client 而不补救）
    # 当前 buggy 行为：on_dead 在插入前触发被丢弃，_reconnect_tasks 为空
    key = (c.url, c.device_token)
    assert pool._reconnect_tasks.get(key) is not None or not pool._clients[key].dead, \
        'P1: 插入前死亡的 client 未被安排重连'
    await pool.aclose_all()


class GenClient:
    """记录 on_dead，供 P2b 代际测试手动标死。"""

    def __init__(self, url, device_token, *, identity, scopes, on_dead=None, index):
        self.url = url
        self.device_token = device_token
        self.identity = identity
        self.scopes = scopes
        self._on_dead = on_dead
        self._index = index
        self.dead = False
        self.closed = False

    async def connect(self):
        self._index[0] += 1

    def kill(self):
        self.dead = True
        if self._on_dead is not None:
            self._on_dead(self)

    async def aclose(self):
        self.closed = True

    def discard(self, run_id):
        pass


@pytest.mark.asyncio
async def test_p2b_done_callback_removes_only_own_task():
    """P2b：旧 task 的 done_callback 不应误删同 key 已注册的新 task。"""
    index = [0]
    clock = _clock()

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return GenClient(url, dt, identity=identity, scopes=scopes,
                         on_dead=on_dead, index=index)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=_sleeper(clock)))
    inst = SimpleNamespace(name='a', port=19001)
    c1 = await pool.get_or_create(inst)
    key = (c1.url, c1.device_token)
    c1.kill()
    t1 = pool._reconnect_tasks.get(key)
    assert t1 is not None
    # fast-path 取消 t1（如 get_or_create 命中）
    pool._cancel_reconnect(key)
    # 模拟「取消后、done_callback 执行前」同 key 注册了新一代 task t2——t2 必须仍 pending
    # （connect_factory 挂起），否则 t2 自身完成后自我清理，测不到「t1 误删 pending t2」。
    hang = asyncio.Event()
    c1.dead = True
    pool._start_reconnect(key, c1)
    t2 = pool._reconnect_tasks.get(key)
    assert t2 is not None and t2 is not t1
    # 把 t2 的 connect_factory 换成挂起（让它停在 connect 阶段、保持 pending）
    # 直接构造一个挂起的 task 替换 t2 槽位（等价于 t2 仍在退避/建连中）
    async def _pending():
        await hang.wait()
    t2_pending = asyncio.ensure_future(_pending())
    pool._reconnect_tasks[key] = t2_pending
    # 现在让 t1 的 done_callback 执行（t1 已被 cancel）
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    # P2b 期望：t1 的 done_callback 不应误删仍在槽位的 t2_pending
    assert pool._reconnect_tasks.get(key) is t2_pending, \
        'P2b: 旧 task 的 done_callback 误删了同 key 的新 task'
    hang.set()
    await pool.aclose_all()


@pytest.mark.asyncio
async def test_p2a_aclose_all_no_reconnect_leak_after_closing_live_client():
    """P2a：aclose_all 关闭 live client 时，其 recv_task 取消触发的 on_dead 不应在 drain 后又生新
    重连 task——aclose_all 返回后 _reconnect_tasks 必须为空（无悬挂、无泄漏替换连接）。

    用接受 on_dead 的 client：kill() 触发 on_dead 模拟「aclose 间 client 死亡上报」。aclose_all 的
    _closing 标志 + 先移出 clients 再 drain，确保关闭路径不再新生重连。
    """
    index = [0]
    clock = _clock()

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return GenClient(url, dt, identity=identity, scopes=scopes,
                         on_dead=on_dead, index=index)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=_sleeper(clock)))
    inst = SimpleNamespace(name='a', port=19001)
    c = await pool.get_or_create(inst)

    # 模拟 client.aclose() 取消 recv_task 触发的 on_dead（aclose_all 关闭路径上的死亡上报）
    original_aclose = c.aclose

    async def aclose_that_dies():
        await original_aclose()
        # recv_task 取消 → _mark_dead → on_dead（aclose_all 的 _closing 应阻断其生新重连）
        c.dead = True
        if c._on_dead is not None:
            c._on_dead(c)
    c.aclose = aclose_that_dies

    await pool.aclose_all()
    # P2a 期望：aclose_all 返回后无悬挂重连 task（on_dead 新生成的被阻断/已 drain）
    assert not pool._reconnect_tasks, \
        'P2a: aclose_all 关闭 live client 后仍残留重连 task（on_dead 在 drain 后又生新 task）'


@pytest.mark.asyncio
async def test_p2_force_repair_evicts_superseded_credential_reconnect():
    """P2（codex #221 第二轮）：force-repair 换 device_token 后，旧 key 的重连循环不应再无限
    重建已撤销凭证——pool.evict_url(url) 逐出该网关全部旧 key client + 取消其重连 task。

    根因：旧 key 的 target 永是池中当前值（force-repair 不触碰 pool），重连 stop 永不触发，
    每 30s 无限重建已撤销 token。evict_url 让 force-repair 路径能清掉旧凭证的 client 与重连。
    """
    index = [0]
    clock = _clock()

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return GenClient(url, dt, identity=identity, scopes=scopes,
                         on_dead=on_dead, index=index)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=_sleeper(clock)))
    inst = SimpleNamespace(name='a', port=19001)
    c1 = await pool.get_or_create(inst)
    url = c1.url
    old_key = (url, c1.device_token)
    c1.kill()  # 旧 token client 死亡 → on_dead 启动旧 key 重连
    assert pool._reconnect_tasks.get(old_key) is not None
    # force-repair 换 token：pool 应能逐出该 url 下全部旧凭证 client + 取消其重连
    await pool.evict_url(url)
    # P2 期望：旧 key 的 client 与重连 task 均被逐出/取消（不再无限重建已撤销凭证）
    assert old_key not in pool._clients
    assert pool._reconnect_tasks.get(old_key) is None
    assert c1.closed  # 旧 client 已被 aclose 清理
    await pool.aclose_all()


class ReplaceDeathClient:
    """connect 成功但按代际决定是否立即标死（P1 #221 R3：换入的替换 client 已 dead）。

    第 1 代（index 0）connect 后不标死（正常建连）；第 2 代起 connect 后立即标死并触发
    on_dead——模拟「重连握手完成但替换连接立刻断开」。real client 的 _recv_task 在 connect()
    内启动、可先于插入 _clients 标死。
    """

    def __init__(self, url, device_token, *, identity, scopes, on_dead=None, index):
        self.url = url
        self.device_token = device_token
        self.identity = identity
        self.scopes = scopes
        self._on_dead = on_dead
        self._index = index
        self.dead = False
        self.closed = False

    async def connect(self):
        i = self._index[0]
        self._index[0] += 1
        if i >= 1:  # 第 2 代起：握手完成但立刻死亡
            self.dead = True
            if self._on_dead is not None:
                self._on_dead(self)

    def kill(self):
        self.dead = True
        if self._on_dead is not None:
            self._on_dead(self)

    async def aclose(self):
        self.closed = True

    def discard(self, run_id):
        pass


@pytest.mark.asyncio
async def test_p1_reconnect_retries_when_replacement_already_dead():
    """P1（codex #221 第三轮）：重连换入的替换 client 已 dead 时，重连循环必须继续重试，
    而非把这次 _reconnect_once 当成功退出、把死替换留在池中无人再连。

    根因：_reconnect_once 在当前重连 task 内运行，它插入新 client 后 _reschedule_if_dead →
    _start_reconnect，但当前 task 仍占 _reconnect_tasks[key]，幂等检查把补调度当重复丢弃；
    run() 随后视 _reconnect_once 成功而 return，死替换无人再重试。

    修复：_reconnect_once 换入的新 client 已 dead 时抛 ConnectionError，让 run() 视为失败
    continue 重试（退避翻倍、task 槽位被自己占着，下轮自然重连）。
    """
    index = [0]
    clock = _clock()

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return ReplaceDeathClient(url, dt, identity=identity, scopes=scopes,
                                  on_dead=on_dead, index=index)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=_sleeper(clock)))
    inst = SimpleNamespace(name='a', port=19001)
    c1 = await pool.get_or_create(inst)  # 第 1 代：正常建连
    key = (c1.url, c1.device_token)
    assert not c1.dead
    c1.kill()  # 第 1 代死亡 → on_dead 启动重连（target=c1）
    task = pool._reconnect_tasks.get(key)
    assert task is not None
    # 让重连循环跑若干轮（假时钟，不真睡）。每轮 _reconnect_once 换入第 2+ 代（已 dead）。
    # P1 期望：循环把「换入已 dead」视为失败继续重试——sleeper 记录到**多次**退避（不只 1 次），
    # 证明 run() 没有在第 1 次换入死替换后就 return 退出。
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    # buggy 行为：run() 第 1 次 _reconnect_once（换入已 dead 的第 2 代）当成功 return →
    # 只退避 1 次。修复后：每次换入已 dead 都 continue → 退避多次。
    assert len(clock.sleeps) > 1, (
        f'P1 R3: 重连换入已 dead 替换后循环退出（只退避 {len(clock.sleeps)} 次），'
        '死替换留在池中无人再重试')
    await pool.aclose_all()
