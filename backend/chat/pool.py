"""chat.pool —— 每容器已配对长连接的连接池（issue #41 / spec §8.2 / #141 identity+scopes 传递）。

dict[(url,device_token)→OpenClawWire]：同容器复用、异容器隔离。pool 以防腐层 OpenClawWire Port
为类型依赖（#231 / ADR 0004）；唯一实现是 integration.openclaw.wire_client.OpenClawWireClient
（经默认 client_factory 实例化，OpenClawChatClient 为其同对象 alias）。get_or_create 读 Pairing 行
（PairingService.get_status，database_sync_to_async 包，供 async consumer 调 sync ORM），未 paired /
无 deviceToken → NotPaired（上层提示先配对，spec §8.1）；已 paired 则从 Pairing 重建 DeviceIdentity
+ 解析 scopes，传 factory 创建 client 并按 (url,device_token) 复用或 connect。#141 移除 gateway_token
依赖（gateway_token 仅配对握手需要，session 重连不需要）。ChatFleet service locator（对齐
chat.pairing.PairingFleet）。
"""
from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable

from channels.db import database_sync_to_async

from chat.chat_client import OpenClawChatClient
from chat.device_crypto import DeviceIdentity
from chat.models import Pairing
from chat.pairing import PairingService
from integration.openclaw import OpenClawWire
from integration.openclaw.wire import REQUIRED_SCOPES


class NotPaired(Exception):
    """容器未完成设备配对；上层应提示用户先配对（spec §8.1）。"""

    def __init__(self, status: str, request_id: str = '') -> None:
        super().__init__(f'container not paired (status={status})')
        self.status = status
        self.request_id = request_id


class ReconnectPolicy:
    """#196 T3 / #215：指数退避主动重连策略（注入式对象，组合优于继承、无自由函数）。

    契约 ``GATEWAY_RECONNECT_POLICY``：初始退避 ``initial``、每次失败翻倍、上限 ``cap``，重连成功
    ``reset()`` 后回 ``initial``。``sleeper`` 注入便于测试假时钟（记录时长不真睡）；``connect_factory``
    由 pool 绑定为该 key 的「client 建连」协程（对齐 ``get_or_create`` 无参样式）。
    """

    def __init__(
        self,
        *,
        initial: float = 1.0,
        cap: float = 30.0,
        sleeper: Callable[[float], Awaitable[None]] | None = None,
        connect_factory: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._initial = initial
        self._cap = cap
        self._sleep = sleeper or asyncio.sleep
        self._connect = connect_factory
        self._delay = initial

    async def next_delay(self) -> float:
        """记录并返回本次退避时长，随后翻倍（封顶 cap）——供测试断言指数序列。"""
        delay = self._delay
        self._delay = min(self._delay * 2, self._cap)
        return delay

    def reset(self) -> None:
        """重连成功后重置退避回 initial（契约「重连成功即重置退避」）。"""
        self._delay = self._initial

    def fork(self, connect_factory: Callable[[], Awaitable[None]]) -> ReconnectPolicy:
        """派生一个绑定新 connect_factory、退避重置回 initial 的同类实例（pool 每轮重连用）。

        把「克隆自身配置（initial/cap/sleeper）+ 换新 connect_factory」收进拥有数据的类，
        调用方（pool）不再掏本类私有字段。每轮重连用独立实例 → 上轮失败累计的退避不跨轮泄漏。
        """
        return type(self)(
            initial=self._initial, cap=self._cap, sleeper=self._sleep,
            connect_factory=connect_factory,
        )

    async def run(self, stop: Callable[[], bool]) -> None:
        """指数退避重连循环：退避 → 建连，失败翻倍重试，成功即重置退避并返回。

        每轮退避后先查 ``stop()``（fast-path 已复活 / pool 关闭）避免无谓重连。被取消（aclose_all /
        client aclose / fast-path 命中存活）时 CancelledError 自然传播退出，不吞。
        """
        while True:
            await self._sleep(await self.next_delay())
            if stop():
                return
            try:
                await self._connect()
            except Exception:  # pylint: disable=broad-exception-caught
                continue  # 建连失败：已退避翻倍，下轮重试
            self.reset()
            return


class ChatConnectionPool:
    """每容器一条已配对长连接的连接池（Object Pool）。"""
    def __init__(
        self,
        *,
        pairing_service: PairingService | None = None,
        client_factory=None,
        ws_url_for=None,
        transport=None,
        reconnect_policy: ReconnectPolicy | None = None,
    ) -> None:
        self._pairing = pairing_service or PairingService()
        self._client_factory = client_factory or self._default_client_factory
        # 复用 PairingService 的 ws url 构造（连同一容器，scheme/host 一致）
        self._ws_url_for = ws_url_for or PairingService._default_ws_url
        self._transport = transport
        self._clients: dict[tuple[str, str], OpenClawWire] = {}
        # per-key 锁（Lock Strippling）：同 (url,device_token) 串行建连（TOCTOU 防重复 orphan），
        # 异 key 并行——避免一个坏容器（建连挂起）阻塞所有其他容器的 chat（codex P1）。
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        # #196 T3 / #215：注入式主动重连策略（组合优于继承）。client 标 dead 即后台指数退避重连，
        # 不再干等下次 get_or_create 惰性重建——半开断线无需用户发消息即自愈（T4 恢复在途 run 的前提）。
        self._reconnect_policy = reconnect_policy or ReconnectPolicy()
        self._reconnect_tasks: dict[tuple[str, str], asyncio.Task] = {}
        # codex #221 P2：aclose_all 期间置位——此时 client.aclose() 取消 recv_task 会触发 on_dead，
        # _schedule_reconnect 见此标志直接返回，避免 drain 后又生新重连 task / 泄漏替换连接。
        self._closing = False
        # codex #221 R6 P2：每 url 的 evict 代际。evict_url 递增；get_or_create 慢路径建连前读、
        # 插入前再读，代际变了说明建连期间发生 evict（force-repair/删除）→ 丢弃新 client 不发布，
        # fencing「evict 快照漏掉 in-flight key、其随后发布旧凭证」的并发窗口。
        self._evict_gen: dict[str, int] = {}

    def _key_lock(self, key: tuple[str, str]) -> asyncio.Lock:
        # 同步创建（无 await），单事件循环内原子；并发同 key 第一次进入会拿到同一把锁
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    def _default_client_factory(
        self, url: str, device_token: str, *, identity, scopes, on_dead=None,
    ) -> OpenClawChatClient:
        """生产 client factory：签名对齐 #141，identity+scopes 由 get_or_create 从 Pairing 注入。
        nonce 由 connect() 等 connect.challenge 提取（#140）。transport 注入（测试用 FakeTransport）。
        on_dead（#215）：client 标 dead 时回调（pool 注入以触发主动重连）。"""
        kwargs: dict = {}
        if self._transport is not None:
            kwargs['transport'] = self._transport
        return OpenClawChatClient(
            url, device_token, identity=identity, scopes=scopes, on_dead=on_dead, **kwargs,
        )

    async def get_or_create(self, instance) -> OpenClawWire:
        pairing = await database_sync_to_async(self._pairing.get_status)(instance)
        if pairing.status != Pairing.STATUS_PAIRED or not pairing.device_token:
            raise NotPaired(pairing.status, pairing.pairing_request_id)
        url = self._ws_url_for(instance)
        key = (url, pairing.device_token)
        # 快路径：命中存活 client 直接返回（无需锁）；dead 的不复用（codex P1：连接断开后驱逐重建）。
        # #215：幂等取消该 key 悬挂的重连——活着就不该再有重连在途（防「快路径复用 client 而重连又
        # 换入新 client」的双 client 分裂；竞态防御，重连 task 收尾本已 self-clean）。
        client = self._clients.get(key)
        if client is not None and not client.dead:
            self._cancel_reconnect(key)
            return client
        # 同 key 串行建连，异 key 并行（per-key lock）；建连耗时/挂起只阻塞同 key
        async with self._key_lock(key):
            client = self._clients.get(key)
            if client is not None and not client.dead:
                self._cancel_reconnect(key)
                return client
            if client is not None:  # 死连接：best-effort 清理后丢弃
                try:
                    await client.aclose()
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
            # #141：从 Pairing 行重建 DeviceIdentity + 解析 scopes，传 factory
            identity = self._build_identity(pairing)
            scopes = self._pairing_scopes(pairing)
            # codex #151 P2：PAIRED 但 identity 不完整 → 配对材料损坏，路由重新配对
            if pairing.status == Pairing.STATUS_PAIRED and identity is None:
                raise NotPaired(pairing.status, pairing.pairing_request_id)
            # codex #151 P2：identity 非空但 scopes 为空 → 配对材料不完整，路由重新配对
            if identity is not None and not scopes:
                raise NotPaired(pairing.status, pairing.pairing_request_id)
            # codex #151 P2：identity 非空但缺少 REQUIRED_SCOPES → scopes 损坏/不足，路由重新配对
            if identity is not None and not REQUIRED_SCOPES.issubset(set(scopes)):
                raise NotPaired(pairing.status, pairing.pairing_request_id)
            new_client = self._make_client(key, url, pairing.device_token, identity, scopes)
            # codex #236 R2 P1-318：死路径驱逐重建也 propagate 记住会话（原仅 _reconnect_once）——
            # 否则前台驱逐重建的 connect 不带记住 sessionKey，恢复永不触发。
            if client is not None:
                self._propagate_recovery(client, new_client)
            # codex #221 R6 P2：建连前读 evict 代际——connect 期间若发生 evict（force-repair/删除），
            # 代际会递增。
            gen0 = self._evict_gen.get(url, 0)
            await new_client.connect()  # 握手有界（chat_client.connect_timeout）
            # 插入前复核代际：建连期间发生 evict → 本 client 用的是被 evict 时读的旧凭证材料，
            # 发布会成为重连 target 无限重试已删/旧凭证。丢弃（aclose）并视为建连失败 raise，
            # 让上层按当前 Pairing 重新 get_or_create（force-repair 已换新 token 时按新 token 建）。
            if self._evict_gen.get(url, 0) != gen0:
                try:
                    await new_client.aclose()
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
                raise ConnectionError('pool evicted during connect; credentials superseded')
            self._clients[key] = new_client
            if client is not None:  # codex #219 十六轮 P2-219：把被替换死 client 的订阅者迁到新 client
                self._migrate_subscribers(client, new_client)
            self._reschedule_if_dead(key, new_client)  # codex #221 P1：插入前死亡的补调度
            return new_client

    @staticmethod
    def _migrate_subscribers(old_client, new_client) -> None:
        """把 old_client 的全部审批订阅者迁到 new_client（old 退订、new 幂等注册）。

        codex #219 十六轮 P2-219：reacquire 重建失败会把已关闭的 client 放回缓存作迁移源；
        若下次替换它的是 get_or_create（REST / 另一浏览器 start）而非 reacquire，原实现直接
        丢弃被关 client、不迁订阅者——已连接浏览器仍订阅在被关对象上、错过新审批。故
        get_or_create 驱逐死 client 时也迁（aclose 不清订阅者，仍挂其上可迁）。同步无 await，
        单事件循环内对订阅者列表原子，无跨协程竞态。
        """
        for cb in old_client.approval_subscribers():
            old_client.remove_approval_subscriber(cb)
            new_client.add_approval_subscriber(cb)

    @staticmethod
    def _propagate_recovery(old_client, new_client) -> None:
        """#196 T4 / #217 / codex #236 R2 P1-318：把 old_client 记住的活跃会话逐条 propagate 到
        new_client（建替换 client 后、connect 前调用）。

        所有「驱逐旧 client 重建新 client」路径都须经此——_reconnect_once（主动重连）、reacquire
        （consumer 自愈）、get_or_create 死路径（前台驱逐重建）——否则该路径 connect 不携带记住的
        sessionKey，恢复（messages.subscribe + chat.history + inFlightRun）永不触发、remembered
        session 随旧 client 丢弃。getattr 防御：stub/无 recovery_sessions 的 client 视为无记住。
        """
        sessions = getattr(old_client, 'recovery_sessions', None)
        if sessions is None:
            return
        for session_key, on_event in sessions():
            new_client.record_active_session(session_key, on_event)

    def _make_client(self, key, url, device_token, identity, scopes):
        """经 client_factory 建 client，best-effort 注入 on_dead 回调（#215 触发主动重连）。

        on_dead 是 pool 内部优化钩子：自定义 factory 不接受该 kwarg（如既存测试 stub 的固定签名）
        时回退不传，不影响建连主路径。
        """
        try:
            return self._client_factory(
                url, device_token, identity=identity, scopes=scopes,
                on_dead=lambda reporter: self._schedule_reconnect(key, reporter),
            )
        except TypeError:
            return self._client_factory(url, device_token, identity=identity, scopes=scopes)

    # ── #196 T3 / #215：主动重连（指数退避 1s→30s）─────────────────

    def _schedule_reconnect(self, key, reporter) -> None:
        """client 经 on_dead 上报标死时触发主动重连（仅当 reporter 仍是池中当前值）。

        reporter（codex #221 P1）是触发 on_dead 的那个 client——回调直接携带报告方身份，不再靠
        重新查 pool。reporter 已不是池中当前值（被 fast-path 换入的新 client 顶掉 / 池已清空）时不
        再为其启动重连（否则与 fast-path 复用的新 client 分裂）。池关闭中（aclose_all）也不再调度。
        """
        if self._closing:
            return
        if self._clients.get(key) is not reporter or not reporter.dead:
            return
        self._start_reconnect(key, reporter)

    def _reschedule_if_dead(self, key, client) -> None:
        """插入 _clients 后复查（codex #221 P1）：client 在 connect() 后、放入 pool 前已死亡时，
        on_dead 曾因「reporter 尚非池中当前值」被丢弃——此处插入完成后补调度，不丢这次死亡。"""
        if not self._closing and client.dead:
            self._start_reconnect(key, client)

    def _start_reconnect(self, key, target) -> None:
        """为该 key 的 target client 启动后台主动重连（幂等：已有守护**同一** target 的在途重连才不重复启动）。

        用独立 ReconnectPolicy 实例跑本轮重连（成功 reset 退避、失败翻倍）。stop 条件：fast-path 在
        重连在途期间已把该 key 换成**别的** client（用户流量迁走）→ 本次重连作废，防双 client 分裂。
        connect_factory 复用 get_or_create 的「驱逐 → 重建」材料（`_reconnect_once`）。
        """
        existing = self._reconnect_tasks.get(key)
        if existing is not None and not existing.done():
            # codex #221 R6 P1：槽位 task 守护的 target 非本次 target（fast-path 已换走旧 client、
            # 当前值是新 client 且也死了）时，不能当重复丢弃——陈旧 task 醒来 stop 谓词命中即退出，
            # 当前 dead client 将无人主动重连。取消陈旧 task、落入下方为当前 target 重启。
            if getattr(existing, '_pool_target', None) is target:
                return  # 真重复：已有守护同一 target 的在途重连
            existing.cancel()  # 陈旧 task：守护已被换走的旧 client，其 stop 本就会命中退出
        policy = self._reconnect_policy.fork(lambda: self._reconnect_once(key, target))
        task = asyncio.ensure_future(
            policy.run(lambda: self._clients.get(key) is not target))
        task._pool_target = target  # 供代际比较：本 task 守护哪个 client（见上方幂等检查）
        self._reconnect_tasks[key] = task
        # codex #221 P2：仅当槽位仍指向本 task 才弹出——避免「旧 task 的 done_callback 晚于同 key 新
        # task 注册执行」时误删新 task（新 task 失跟踪 → aclose_all 无法取消、死亡又起重复重连）。
        task.add_done_callback(
            lambda _t, _task=task: self._reconnect_tasks.pop(key, None)
            if self._reconnect_tasks.get(key) is _task else None)

    def _cancel_reconnect(self, key) -> None:
        """取消该 key 悬挂的重连计时器（fast-path 命中存活 / client aclose / aclose_all 时调）。"""
        task = self._reconnect_tasks.pop(key, None)
        if task is not None and not task.done():
            task.cancel()

    async def _drain_reconnects(self) -> None:
        """取消并等待全部重连 task 落定（aclose_all 用：确保无悬挂 task，契约 #215 验收②）。"""
        tasks = [t for t in (self._reconnect_tasks.pop(k, None) for k in list(self._reconnect_tasks)) if t]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):  # pylint: disable=broad-exception-caught
                await task

    async def _reconnect_once(self, key, target) -> None:
        """单次主动重连：驱逐 target（已断连的 client）→ 重建换入池中。

        仅当 target 仍是池中当前值时执行——fast-path 若已换成别的 client（stop 已拦），或并发重复
        进入，则不重复重连。与 get_or_create 同走 per-key 锁串行化，防与前台建连竞态；重建复用
        target 的连接材料（identity/scopes，与 fast-path 建它时一致），半开断线经此自愈换入全新连接。
        """
        url, device_token = key
        async with self._key_lock(key):
            if self._clients.get(key) is not target:
                return  # fast-path 已换成别的 client（并发防御；stop 是主拦截）
            try:
                await target.aclose()  # best-effort 清理旧连接
            except Exception:  # pylint: disable=broad-exception-caught
                pass
            new_client = self._make_client(key, url, device_token, target.identity, target.scopes)
            # #196 T4 / #217：把旧 client 记住的活跃会话 propagate 到替换 client——重连恢复
            # （messages.subscribe + chat.history + inFlightRun）须携带「client 记住的上次活跃
            # sessionKey」（契约步1），否则 remembered session 随旧 client 丢弃、恢复永不触发。
            self._propagate_recovery(target, new_client)
            await new_client.connect()
            # codex #221 R3+R4 P1：换入的替换 client 已 dead（握手完成但 recv 立刻退出）时，
            # **确认存活后才发布**——dead 则先 aclose 丢弃半成品、不写入 _clients[key]，再抛
            # ConnectionError 让 run() 视为本轮失败 continue。若先 `self._clients[key]=new_client`
            # 再 raise（R3 的初版修法），run() 下一轮 stop 谓词 `_clients[key] is not target`
            # 会因池中已是死替换而命中、在第二次 _connect 前退出，死替换仍留池中。保持池中为
            # target → stop 不命中 → 退避翻倍、task 槽位被自己占着，下一轮自然重连。
            # get_or_create 快路径无此循环，仍用 _reschedule_if_dead 独立补调度（见该处）。
            if new_client.dead:
                try:
                    await new_client.aclose()  # 丢弃半成品，不污染池
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
                raise ConnectionError('reconnect replacement died immediately after handshake')
            self._clients[key] = new_client

    async def aclose_all(self) -> None:
        # codex #221 P2：先置 _closing（阻断 client.aclose() 触发 on_dead 又生新重连 task），
        # 并把 clients 一次性移出池再逐个 aclose——快照外新生的替换连接不会逃过关闭。
        self._closing = True
        await self._drain_reconnects()  # #215：先取消并等待全部退避计时器落定，无悬挂 task
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            await client.aclose()
        await self._drain_reconnects()  # 兜底：aclose 间若有漏网重连（_closing 前已调度）一并清
        self._closing = False

    async def evict_url(self, url: str) -> None:
        """逐出某网关 url 下全部 client + 取消其重连 task（codex #221 第二轮 P2）。

        force-repair（PairingView.ensure_paired(force_repair=True)）换 device_token 后，旧
        key=(url, old_token) 的 client 仍留池中、其 target 永是当前值 → 重连 stop 永不触发，每 30s
        无限重建已撤销凭证。本方法让凭证变更路径能清掉该 url 下所有旧 key 的 client 与重连，
        后续 get_or_create 按新 token 重建。
        """
        # codex #221 R6+R7 P2：代际递增必须在**第一个 await 之前**（tombstone-first）。若放在
        # 下方 aclose() await 之后（R6 初版位置），evict 的 aclose 让渡期间，并发 get_or_create
        # 会读到旧代际、connect、并插入新 client——随后才递增的代际拦不住这个已发布 client
        # （它不再做代际检查而存活，成为重连 target 无限重试已删/旧凭证）。开头先递增，则任何
        # evict 期间 connect 的 in-flight 在插入前复核代际都会发现已变 → 丢弃不发布（见
        # get_or_create 慢路径的代际复核）。同 event loop 单线程，本递增是同步原子。
        self._evict_gen[url] = self._evict_gen.get(url, 0) + 1
        keys = [k for k in self._clients if k[0] == url]
        for key in keys:
            self._cancel_reconnect(key)
            client = self._clients.pop(key, None)
            if client is not None:
                try:
                    await client.aclose()
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
        # 同 url 可能只剩「无 client 但悬挂重连」的 key（target 已被 fast-path 移出池）——一并取消
        for key in [k for k in list(self._reconnect_tasks) if k[0] == url]:
            self._cancel_reconnect(key)

    async def evict_instance(self, instance) -> None:
        """按容器实例逐出其网关下全部旧凭证 client + 重连（codex #221 第二轮 P2）。

        force-repair 换 device_token 后调用——url 由 pool 内部 _ws_url_for 算（与建连同源），
        调用方（REST 层）无需关心 key 构造。委托 evict_url。
        """
        await self.evict_url(self._ws_url_for(instance))

    async def get_live(self, instance) -> OpenClawWire | None:
        """非创建式查活：返回该容器当前存活 client，无则 None（codex #219 P2 退订再同步用）。

        与 get_or_create 不同——**不建连、不抛 NotPaired**，只在 pool 里查存活 client。
        consumer 自愈换 client 后，被动 consumer 缓存的 self._client 可能仍是死 client；
        disconnect/切容器退订时经此方法从 pool（唯一事实源）再解析活 client，避免退订/丢弃
        runId 落到死 client 上、把回调泄漏到存活的新 client（T06 独立退订契约）。
        """
        try:
            pairing = await database_sync_to_async(self._pairing.get_status)(instance)
        except Exception:  # pylint: disable=broad-exception-caught
            return None
        if pairing.status != Pairing.STATUS_PAIRED or not pairing.device_token:
            return None
        key = (self._ws_url_for(instance), pairing.device_token)
        client = self._clients.get(key)
        if client is not None and not client.dead:
            return client
        return None

    async def evict(self, instance) -> None:
        """把该容器当前缓存的 client 逐出池（best-effort aclose 清理），下次 get_or_create 重建。

        codex #219 四轮 P2-891：consumer 的 RPC 在刚关闭的 socket 上 ws.send() 抛原生
        ConnectionClosed——连接已断的充分证据，但后台 recv task 尚未跑异常处理器置
        client.dead（竞态窗口）。get_or_create 快路径（pool.py:80-82）只看 dead==False，
        会返回同一个濒死 client，consumer 的 identity check（fresh is client）据此放弃恢复。
        故 consumer 重取前先 evict 把该 client 逐出缓存，get_or_create 才走慢路径重建新 client。
        幂等：无缓存 / 未配对（查不到 key）时 noop 不抛。
        """
        pairing = await database_sync_to_async(self._pairing.get_status)(instance)
        if pairing.status != Pairing.STATUS_PAIRED or not pairing.device_token:
            return
        key = (self._ws_url_for(instance), pairing.device_token)
        async with self._key_lock(key):  # 与 get_or_create 慢路径同锁，避免竞态重复建连
            client = self._clients.pop(key, None)
        if client is not None:
            try:
                await client.aclose()
            except Exception:  # pylint: disable=broad-exception-caught
                pass

    async def reacquire(self, instance, expected_client) -> tuple[OpenClawWire, OpenClawWire | None]:
        """consumer 自愈用的原子重取：在 per-key 锁内「比较缓存项 → 采纳/驱逐 → 重建」一次完成。

        codex #219 六轮 P1-872：consumer 原 get_live→evict→get_or_create 三步非原子——两
        consumer 并发自愈同一死 client 时都在 get_live 见无活连接，A 在 B 检查与 evict 间装好
        健康连接，B 又把它 evict+aclose（中断 A 路由、订阅者滞留死 client）。本方法把比较与
        替换收敛进同一把 `_key_lock`，消除跨 consumer 的 TOCTOU。语义（锁内判定）：
        - 缓存项**健康且非** expected_client（别的 consumer 已换好）→ 直接采纳返回，不驱逐不重建；
        - 缓存项**就是** expected_client（本 consumer 持有的死/濒死 client）→ 驱逐后重建；
        - 缓存项缺失（已被驱逐）→ 直接重建。
        未配对/配对材料不完整仍抛 NotPaired（与 get_or_create 一致）。

        返回 `(fresh, replaced)` 二元组（codex #219 十四轮 P2-183）：`fresh` 是采纳/重建后应使用的
        client；`replaced` 是本调用在锁内**实际驱逐**的缓存 client（无驱逐则 None）。consumer 须从
        `replaced`（而非自己持有的 expected_client）迁移审批订阅者——被动 consumer 持有的
        expected_client 可能已是更早的空壳代际，而 pool 缓存里实际被替换的才是当前挂着全部
        订阅者的那一代；从 expected_client 迁会把真实订阅者丢在被关掉的 `replaced` 上。
        重建 `connect()` 失败时把 `replaced` 放回缓存再抛（codex #219 十五轮 P2-208），下次
        reacquire 仍能从缓存取到它作迁移源，不致因缓存已空而回退到空壳 expected_client。
        """
        pairing = await database_sync_to_async(self._pairing.get_status)(instance)
        if pairing.status != Pairing.STATUS_PAIRED or not pairing.device_token:
            raise NotPaired(pairing.status, pairing.pairing_request_id)
        url = self._ws_url_for(instance)
        key = (url, pairing.device_token)
        async with self._key_lock(key):
            cached = self._clients.get(key)
            # 采纳：别的 consumer 已在锁内换好健康连接（非本 consumer 持有的 expected_client）。
            # 无驱逐发生 → replaced=None（订阅者已在 peer 那代被迁走，见 adopt 调用方）。
            if cached is not None and not cached.dead and cached is not expected_client:
                return cached, None
            replaced = None
            if cached is not None:  # 自己持有的死/濒死 client（或健康但==expected，防御）：驱逐
                replaced = cached
                try:
                    await cached.aclose()
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
                self._clients.pop(key, None)
            # 重建（复用 get_or_create 慢路径同款配对材料校验，防 identity/scopes 损坏）
            identity = self._build_identity(pairing)
            scopes = self._pairing_scopes(pairing)
            if pairing.status == Pairing.STATUS_PAIRED and identity is None:
                raise NotPaired(pairing.status, pairing.pairing_request_id)
            if identity is not None and not scopes:
                raise NotPaired(pairing.status, pairing.pairing_request_id)
            if identity is not None and not REQUIRED_SCOPES.issubset(set(scopes)):
                raise NotPaired(pairing.status, pairing.pairing_request_id)
            new_client = self._make_client(key, url, pairing.device_token, identity, scopes)
            # codex #236 R2 P1-318：consumer 自愈重建也 propagate 记住会话（原仅 _reconnect_once）——
            # 否则 reacquire 的 connect 不带记住 sessionKey，恢复（messages.subscribe+chat.history）跳过。
            if replaced is not None:
                self._propagate_recovery(replaced, new_client)
            try:
                await new_client.connect()  # 握手有界（chat_client.connect_timeout）
            except Exception:
                # codex #219 十五轮 P2-208：connect 失败时 replaced 已被 pop+aclose，若就此抛错，
                # 下次 reacquire 见空缓存 → replaced=None → consumer 回退到空壳 expected_client 迁
                # 订阅者，把仍挂在 replaced 上的真实订阅者丢在被关掉的 client 上。故把 replaced 放回
                # 缓存（best-effort）：下次 reacquire 从缓存取到它作迁移源（届时再走 189-195 驱逐
                # 路径，幂等——aclose 已 _routes.clear() 可重复、pop 再删一次无碍）。
                if replaced is not None and self._clients.get(key) is None:
                    self._clients[key] = replaced
                raise
            self._clients[key] = new_client
            return new_client, replaced

    @staticmethod
    def _build_identity(pairing) -> DeviceIdentity | None:
        """从 Pairing 行重建 DeviceIdentity。三要素缺一不可——缺任意一个返回 None
        （防御：配对握手可能未写满身份字段；safe-default 不签名的旧路径）。"""
        if not (pairing.device_id and pairing.public_key_pem and pairing.private_key_pem):
            return None
        return DeviceIdentity(
            device_id=pairing.device_id,
            public_key_pem=pairing.public_key_pem,
            private_key_pem=pairing.private_key_pem,
        )

    @staticmethod
    def _pairing_scopes(pairing) -> list[str]:
        """从 Pairing 行解析 scopes_json → list[str]；损坏/缺失返回 []。"""
        import json

        try:
            decoded = json.loads(pairing.scopes_json)
        except (ValueError, TypeError):
            return []
        if not isinstance(decoded, list) or not all(isinstance(s, str) for s in decoded):
            return []
        return decoded


class ChatFleet:
    """ChatConnectionPool 单例 service locator（consumer 依赖；测试 override 注入 fake）。

    对齐 chat.pairing.PairingFleet 与 containers.orchestrator.Fleet：lazy 构造 + override/reset。
    """

    _pool: ChatConnectionPool | None = None

    @classmethod
    def get(cls) -> ChatConnectionPool:
        if cls._pool is None:
            cls._pool = ChatConnectionPool()
        return cls._pool

    @classmethod
    def override(cls, pool: ChatConnectionPool) -> None:
        """测试注入替身。"""
        cls._pool = pool

    @classmethod
    def reset(cls) -> None:
        cls._pool = None
