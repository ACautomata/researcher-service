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
import threading
from typing import ClassVar

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
        # 注（issue #201）：asyncio.Lock 绑定创建时的 loop、跨 loop 不可共享——当前成立依赖
        # 「单 Daphne 进程单 loop」前提；随 follow-up 的 client 专属 loop 方案，全部锁收敛到
        # 该专属 loop 内，REST 线程只经 run_coroutine_threadsafe 进入，跨 loop 问题自然消解。
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
            return new_client

    async def aclose_all(self) -> None:
        for client in list(self._clients.values()):
            await client.aclose()
        self._clients.clear()

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
    # issue #201 问题 4：并发首调双检——两线程同时首次 get() 只能建一个 pool，
    # 否则多建的 pool 泄漏（client/recv 协程孤儿）。
    _pool_lock: ClassVar[threading.Lock] = threading.Lock()

    @classmethod
    def get(cls) -> ChatConnectionPool:
        if cls._pool is None:
            with cls._pool_lock:
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
