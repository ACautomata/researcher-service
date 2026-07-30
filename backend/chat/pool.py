"""chat.pool —— 每容器已配对长连接的连接池（issue #41 / spec §8.2 / #141 identity+scopes 传递）。

dict[(url,device_token)→OpenClawChatClient]：同容器复用、异容器隔离。get_or_create 读 Pairing 行
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
        self._clients: dict[tuple[str, str], OpenClawChatClient] = {}
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

    async def get_or_create(self, instance) -> OpenClawChatClient:
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
            await new_client.connect()  # 握手有界（chat_client.connect_timeout）
            self._clients[key] = new_client
            self._reschedule_if_dead(key, new_client)  # codex #221 P1：插入前死亡的补调度
            return new_client

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
        """为该 key 的 target client 启动后台主动重连（幂等：已有在途重连则不重复启动）。

        用独立 ReconnectPolicy 实例跑本轮重连（成功 reset 退避、失败翻倍）。stop 条件：fast-path 在
        重连在途期间已把该 key 换成**别的** client（用户流量迁走）→ 本次重连作废，防双 client 分裂。
        connect_factory 复用 get_or_create 的「驱逐 → 重建」材料（`_reconnect_once`）。
        """
        existing = self._reconnect_tasks.get(key)
        if existing is not None and not existing.done():
            return
        policy = self._reconnect_policy.fork(lambda: self._reconnect_once(key, target))
        task = asyncio.ensure_future(
            policy.run(lambda: self._clients.get(key) is not target))
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
            await new_client.connect()
            self._clients[key] = new_client
            # codex #221 R3 P1：换入的替换 client 已 dead（握手完成但 recv 立刻退出）时，**不能**
            # 在此 _reschedule_if_dead/_start_reconnect——当前重连 task 仍占 _reconnect_tasks[key]，
            # 幂等检查会把补调度当重复丢弃；run() 又会把本次 _reconnect_once 当成功退出，死替换
            # 留在池中无人再连。改为抛 ConnectionError 让 run() 视为本轮失败 continue：退避翻倍、
            # task 槽位被自己占着，下一轮循环自然重连。get_or_create 路径无此循环，仍用
            # _reschedule_if_dead 独立补调度（见该处）。
            if new_client.dead:
                raise ConnectionError('reconnect replacement died immediately after handshake')

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
