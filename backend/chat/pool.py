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


class ChatConnectionPool:
    """每容器一条已配对长连接的连接池（Object Pool）。"""

    def __init__(
        self,
        *,
        pairing_service: PairingService | None = None,
        client_factory=None,
        ws_url_for=None,
        transport=None,
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

    def _key_lock(self, key: tuple[str, str]) -> asyncio.Lock:
        # 同步创建（无 await），单事件循环内原子；并发同 key 第一次进入会拿到同一把锁
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    def _default_client_factory(
        self, url: str, device_token: str, *, identity, scopes,
    ) -> OpenClawChatClient:
        """生产 client factory：签名对齐 #141，identity+scopes 由 get_or_create 从 Pairing 注入。
        nonce 由 connect() 等 connect.challenge 提取（#140）。transport 注入（测试用 FakeTransport）。"""
        kwargs: dict = {}
        if self._transport is not None:
            kwargs['transport'] = self._transport
        return OpenClawChatClient(
            url, device_token, identity=identity, scopes=scopes, **kwargs,
        )

    async def get_or_create(self, instance) -> OpenClawChatClient:
        pairing = await database_sync_to_async(self._pairing.get_status)(instance)
        if pairing.status != Pairing.STATUS_PAIRED or not pairing.device_token:
            raise NotPaired(pairing.status, pairing.pairing_request_id)
        url = self._ws_url_for(instance)
        key = (url, pairing.device_token)
        # 快路径：命中存活 client 直接返回（无需锁）；dead 的不复用（codex P1：连接断开后驱逐重建）
        client = self._clients.get(key)
        if client is not None and not client.dead:
            return client
        # 同 key 串行建连，异 key 并行（per-key lock）；建连耗时/挂起只阻塞同 key
        async with self._key_lock(key):
            client = self._clients.get(key)
            if client is not None and not client.dead:
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
            new_client = self._client_factory(
                url, pairing.device_token, identity=identity, scopes=scopes,
            )
            await new_client.connect()  # 握手有界（chat_client.connect_timeout）
            self._clients[key] = new_client
            if client is not None:  # codex #219 十六轮 P2-219：把被替换死 client 的订阅者迁到新 client
                self._migrate_subscribers(client, new_client)
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

    async def aclose_all(self) -> None:
        for client in list(self._clients.values()):
            await client.aclose()
        self._clients.clear()

    async def get_live(self, instance) -> OpenClawChatClient | None:
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

    async def reacquire(self, instance, expected_client) -> tuple[OpenClawChatClient, OpenClawChatClient | None]:
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
            new_client = self._client_factory(
                url, pairing.device_token, identity=identity, scopes=scopes,
            )
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
