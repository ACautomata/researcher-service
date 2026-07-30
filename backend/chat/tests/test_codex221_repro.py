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
        self._approval_subs = []

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

    # codex #219 接缝：get_or_create 合并后调 _migrate_subscribers → 需订阅者 API
    def approval_subscribers(self):
        return list(self._approval_subs)

    def add_approval_subscriber(self, cb):
        if cb not in self._approval_subs:
            self._approval_subs.append(cb)

    def remove_approval_subscriber(self, cb):
        if cb in self._approval_subs:
            self._approval_subs.remove(cb)


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
    """connect 成功但按代际决定是否立即标死（P1 #221 R3+R4：换入的替换 client 已 dead）。

    第 1 代（index 0）connect 后不标死（正常建连）；仅第 2 代 connect 后立即标死并触发
    on_dead——模拟「重连握手完成但替换连接立刻断开」；第 3 代起恢复存活，让重连循环有限步内
    收敛（第 1 次换入 dead 第 2 代 → 重试 → 第 2 次换入存活第 3 代 → run 成功退出）。
    real client 的 _recv_task 在 connect() 内启动、可先于插入 _clients 标死。
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
        if i == 1:  # 仅第 2 代：握手完成但立刻死亡
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
    """P1（codex #221 第三/四轮）：重连换入的替换 client 已 dead 时，重连循环必须**真发起第二次
    建连**继续重试，而非把死替换留池中提前退出。

    根因（R3）：_reconnect_once 在当前重连 task 内运行，插入新 client 后 _reschedule_if_dead →
    _start_reconnect，但当前 task 仍占 _reconnect_tasks[key]，幂等检查把补调度当重复丢弃；run()
    随后视 _reconnect_once 成功而 return，死替换无人再重试。
    修复引入的次生竞态（R4）：若 _reconnect_once 先 `self._clients[key]=new_client`（发布死替换）
    再 raise，run() 下一轮 stop 谓词 `_clients[key] is not target` 会因池中已是死替换而命中、在
    第二次 _connect **前**退出——只断言「记录了第二次退避」会假绿。

    修复：_reconnect_once 确认存活后才发布——new_client 已 dead 则 aclose 丢弃 + raise（不写入
    _clients[key]，池中仍是 target，stop 不误命中），run() continue 退避翻倍、下轮重试。

    本测试第 2 代 dead、第 3 代存活：循环应「换入 dead 第 2 代 → 重试 → 换入存活第 3 代」有限步
    收敛，最终池中换入存活的第 3 代、run 成功退出。
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
    # 等重连 task 有限步收敛（假时钟不真睡；第 2 代 dead→重试→第 3 代存活→run 退出）。
    await asyncio.wait_for(asyncio.shield(task), timeout=5)
    # R3 期望：循环把「换入已 dead」视为失败继续重试——退避 ≥2 次（非只 1 次即退出）。
    assert len(clock.sleeps) >= 2, (
        f'P1 R3: 重连换入已 dead 替换后循环退出（只退避 {len(clock.sleeps)} 次），'
        '死替换留在池中无人再重试')
    # R4 期望：真发起了第二次建连（factory 调用 3 次：第 1 代 + dead 第 2 代 + 存活第 3 代），
    # 证明 stop 谓词没在第二次 _connect 前误命中。
    assert index[0] == 3, (
        f'P1 R4: 重连循环建连次数异常（factory 调用 {index[0]} 次，期望 3）——'
        '死替换被提前发布污染池、stop 误命中提前退出')
    # 最终池中换入的是**存活的第 3 代**（dead 第 2 代被 aclose 丢弃、未污染池）。
    final = pool._clients[key]
    assert final is not c1 and not final.dead, (
        'P1: 重连收敛后池中仍是死 client（dead 替换未被丢弃重建）')
    await pool.aclose_all()


@pytest.mark.asyncio
async def test_p1_replaces_stale_reconnect_when_current_client_dies():
    """P1（codex #221 第六轮）：当前 client 死亡时，若槽位仍被「守护陈旧 target 的退避 task」
    占着，必须取消它并为当前 target 重启——否则陈旧 task 醒来 stop 命中退出，当前 dead client
    无人主动重连。

    场景链：
      1. A dead → 调度过期退避 task T_A（target=A，还在睡）
      2. 前台 get_or_create() 驱逐 dead A、重建换入 B（慢路径不取消 T_A）
      3. B 也断开 → on_dead → _schedule_reconnect(key, B)：B 是当前值 → _start_reconnect(key, B)
      4. buggy：_start_reconnect 幂等检查见 T_A 仍 in-flight 即 return（不为 B 启动）；
         T_A 醒来 stop 谓词 `_clients[key] is not A`（池中是 B）命中 → 退出，B dead 无人连。
      期望：识别 T_A 守护的是陈旧 target，取消并为 B 重启新 task。
    """
    index = [0]
    clock = _clock()
    # 让 T_A 卡在首次退避里（sleeper 挂起），横跨 get_or_create 换入 B——
    # 否则假时钟不真睡，T_A 在 get_or_create 的 await 点就跑完退避、stop 命中退出，测不到竞态。
    first_sleep_block = asyncio.Event()

    async def blocking_sleeper(x):
        clock.sleeps.append(x)
        if len(clock.sleeps) == 1:
            await first_sleep_block.wait()  # 首次退避（T_A）挂起，直到测试放行

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return GenClient(url, dt, identity=identity, scopes=scopes,
                         on_dead=on_dead, index=index)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=blocking_sleeper))
    inst = SimpleNamespace(name='a', port=19001)
    a = await pool.get_or_create(inst)  # A
    key = (a.url, a.device_token)
    a.kill()  # A dead → 调度 T_A（target=A，卡在首次退避里）
    t_a = pool._reconnect_tasks.get(key)
    assert t_a is not None
    await asyncio.sleep(0)  # 让 T_A 进入退避挂起点
    assert not t_a.done()
    # 前台 get_or_create 驱逐 dead A、重建换入 B（A 已 dead → 走慢路径，不取消 T_A）
    b = await pool.get_or_create(inst)
    assert b is not a and not b.dead
    assert pool._clients[key] is b
    assert pool._reconnect_tasks.get(key) is t_a, '慢路径重建不应取消 T_A（前置假设）'
    # B 也断开 → on_dead → _schedule_reconnect(key, B)
    b.kill()
    # P1 期望：槽位换成守护 B 的新 task（非陈旧 T_A），且 T_A 已被取消
    t_b = pool._reconnect_tasks.get(key)
    assert t_b is not None and t_b is not t_a, (
        'P1 R6: 当前 client B 死亡时未替换守护陈旧 target A 的重连 task——'
        'T_A 醒来 stop 命中退出后，B 无人主动重连')
    first_sleep_block.set()  # 放行 T_A 的挂起退避，让其 cancel/落定
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert t_a.done(), '陈旧 task T_A 应被取消终止'
    await pool.aclose_all()


class SlowConnectClient(GenClient):
    """connect 可挂起（P2 #221 R6：in-flight 建连与 evict 并发）。第 2 次及以后 connect 在
    connect_gate set 前挂起，模拟「已开始建连但尚未插入 _clients」的窗口；首次 connect 不挂
    （让初始 c1 正常建连）。connect_started 在第 2 代 connect 到达挂起点时 set，供测试同步
    「in-flight 已读 evict 代际、正挂在 connect」后再触发 evict。"""

    def __init__(self, *args, connect_gate=None, connect_started=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._connect_gate = connect_gate
        self._connect_started = connect_started

    async def connect(self):
        i = self._index[0]
        await super().connect()  # 先递增 index（i 为本次代际）
        if i >= 1 and self._connect_gate is not None:
            if self._connect_started is not None:
                self._connect_started.set()  # 标记：in-flight 已进入 connect 挂起窗口
            await self._connect_gate.wait()  # 第 2 代起：connect 完成前挂起（in-flight 窗口）


@pytest.mark.asyncio
async def test_p2_evict_fences_inflight_pool_insertion():
    """P2（codex #221 第六轮）：evict 与「已开始 connect 但尚未插入 _clients」的 get_or_create
    并发时，evict 快照漏掉 in-flight key，其随后发布已删/旧凭证 client 并无限重连。

    场景：c1 在池中 → c1 dead → 后台/前台 get_or_create 开始慢路径重建（第 2 代 connect 挂起，
    尚未插入 _clients）→ 此时 evict_url(url)（force-repair/删除）快照 _clients 只看到 dead c1、
    逐出它，但漏掉 in-flight 重建 → evict 返回后 connect 完成、把第 2 代 client 插入 _clients
    （凭证仍是被 evict 时读的材料）→ 该 client 成为重连 target 无限重试已删/旧凭证。

    期望（per-key 锁 fencing）：evict_url 对同 url 的 per-key 锁 acquire，与 in-flight 建连互斥；
    建连在锁内插入前复核 evict 代际，建连期间发生 evict 则丢弃新 client 不发布。
    """
    index = [0]
    clock = _clock()
    connect_gate = asyncio.Event()  # 未 set：第 2 代 connect 挂起
    connect_started = asyncio.Event()  # in-flight 进入 connect 挂起窗口时 set

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return SlowConnectClient(url, dt, identity=identity, scopes=scopes,
                                 on_dead=on_dead, index=index, connect_gate=connect_gate,
                                 connect_started=connect_started)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=_sleeper(clock)))
    inst = SimpleNamespace(name='a', port=19001)
    c1 = await pool.get_or_create(inst)  # 第 1 代：正常建连（i=0 不挂）
    url = c1.url
    key = (url, c1.device_token)
    c1.kill()  # c1 dead → 取消死亡调度的重连，聚焦 in-flight 窗口本身
    pool._cancel_reconnect(key)
    # 后台启动慢路径重建：第 2 代 connect 挂起（in-flight，尚未插入 _clients）
    inflight = asyncio.ensure_future(pool.get_or_create(inst))
    # 等 in-flight 真正到达 connect 挂起点（已读 evict 代际、正挂在 connect 窗口内）
    await asyncio.wait_for(connect_started.wait(), timeout=5)
    assert not inflight.done()
    # 此时 evict_url(url)（force-repair/删除）：落在「读 gen0 之后、读 gen1 之前」的窗口内
    await pool.evict_url(url)
    assert key not in pool._clients
    # 放行 in-flight connect——buggy：第 2 代被插入 _clients（凭证是被 evict 时读的旧材料）；
    # 修复后：建连期间已 evict（代际变），in-flight 丢弃新 client 并 raise ConnectionError。
    connect_gate.set()
    with pytest.raises(ConnectionError):
        await inflight
    # P2 期望：in-flight 建连完成**后**，旧凭证 client 未发布进池（建连期间已 evict，凭证作废）。
    assert key not in pool._clients, (
        'P2 R6: in-flight 建连在 evict 后仍把旧凭证 client 发布进池——'
        '该 client 将成为重连 target 无限重试已删/旧凭证')
    await pool.aclose_all()


@pytest.mark.asyncio
async def test_p2_evict_advances_generation_before_awaiting_aclose():
    """P2（codex #221 第七轮）：evict_url 的代际递增必须在**第一个 await（aclose）之前**
    （tombstone-first）。评论原文「Advance the eviction generation before awaiting cleanup」：
    若递增在 aclose await 之后，evict 快照→aclose 让渡期间，已读旧代际的 in-flight get_or_create
    connect 完成、插入新 client——随后才递增的代际拦不住这个已发布 client（不再检查而存活）。

    本测试直接验证**位置语义**：evict 卡在 c1 的 aclose await（挂起）期间，该 url 的代际必须
    **已递增**——这样任何在 evict 开始前读过旧代际的 in-flight，插入前复核都会发现已变而丢弃。
    用 SlowCloseClient 让 evict 停在 aclose await，断言此刻代际 > evict 前的值。
    """
    index = [0]
    clock = _clock()
    aclose_gate = asyncio.Event()      # 未 set：c1 的 aclose 挂起（evict 停在 aclose await）
    aclose_started = asyncio.Event()   # evict 进入 c1.aclose 挂起点时 set

    class SlowCloseClient(GenClient):
        async def aclose(self):
            aclose_started.set()
            await aclose_gate.wait()
            await super().aclose()

    def factory(url, dt, *, identity, scopes, on_dead=None):
        return SlowCloseClient(url, dt, identity=identity, scopes=scopes,
                               on_dead=on_dead, index=index)

    pool = ChatConnectionPool(
        pairing_service=FakePairingService(), client_factory=factory,
        ws_url_for=_url_for, reconnect_policy=ReconnectPolicy(sleeper=_sleeper(clock)))
    inst = SimpleNamespace(name='a', port=19001)
    c1 = await pool.get_or_create(inst)
    url = c1.url
    gen_before = pool._evict_gen.get(url, 0)
    # 后台 evict：tombstone-first 下开头即递增代际，然后停在 c1.aclose 挂起点
    evict_task = asyncio.ensure_future(pool.evict_url(url))
    await asyncio.wait_for(aclose_started.wait(), timeout=5)  # evict 已到 c1.aclose await
    assert not evict_task.done()
    # P2 期望：evict 仍卡在 aclose await（清理未完成），但代际**已递增**（tombstone-first）——
    # 凡 evict 开始前读过旧代际的 in-flight，插入前复核必发现已变而丢弃。
    assert pool._evict_gen.get(url, 0) > gen_before, (
        'P2 R7: evict 的 aclose await 期间代际仍未递增（递增放在 cleanup 之后）——'
        '该窗口内 in-flight 读旧代际插入的 client 会存活漏拦')
    aclose_gate.set()  # 放行 evict 的 aclose
    await evict_task
    await pool.aclose_all()
