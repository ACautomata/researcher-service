"""chat.pool —— 每容器已配对长连接的连接池（issue #41 / spec §8.2 / #141 identity+scopes 传递）。

dict[(url,device_token)→OpenClawChatClient]：同容器复用、异容器隔离。get_or_create 读 Pairing 行
（PairingService.get_status，database_sync_to_async 包，供 async consumer 调 sync ORM），未 paired /
无 deviceToken → NotPaired（上层提示先配对，spec §8.1）；已 paired 则从 Pairing 重建 DeviceIdentity
+ 解析 scopes，传 factory 创建 client 并按 (url,device_token) 复用或 connect。#141 移除 gateway_token
依赖（gateway_token 仅配对握手需要，session 重连不需要）。ChatFleet service locator（对齐
chat.pairing.PairingFleet）。

issue #222 / #197-01：session 握手对失败与协商结果给出**结构化、按码分流**的恢复策略，不再统一
塌缩成「连接容器失败，请稍后重试」：
- AUTH_TOKEN_MISMATCH（deviceToken 被撤销/轮换）：同一 client 有界重试一次已存 deviceToken，仍失败
  → 停止自动重连、标记配对失效（PairingService.mark_pairing_invalid）并 raise NotPaired 引导重配——
  不再用同一失效 token 无限重建（否则聊天永久变砖）。
- AUTH_SCOPE_MISMATCH：直接路由重新配对（不当 token 错误重试——scope 问题重试无意义）。
- UNAVAILABLE + details.reason="startup-sidecars"：按 details.retryAfterMs 有界重试（合法启动暂不可用）。
- hello-ok 协商采纳：授予 scopes 收窄（client.scopes_narrowed）→ 标记失效 + NotPaired 路由重配；
  新 auth.deviceToken 经注入的 on_device_token_rotated 钩子持久化（PairingService.update_device_token）
  并以新 token re-key 供后续连接复用。
"""
from __future__ import annotations

import asyncio

from channels.db import database_sync_to_async

from chat.chat_client import ChatConnectError, OpenClawChatClient
from chat.device_crypto import DeviceIdentity
from chat.models import Pairing
from chat.pairing import PairingService
from integration.openclaw.wire import REQUIRED_SCOPES

# issue #222 问题1：UNAVAILABLE+startup-sidecars 有界重试上限（合法启动暂不可用，非无限等待）。
_STARTUP_SIDECARS_MAX_RETRIES = 3


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
            # issue #222 问题1：握手按结构化错误码分流恢复（重配引导 / 有界重试），不再统一塌缩。
            await self._connect_with_recovery(new_client, instance, pairing)
            # issue #222 问题2：hello-ok 授予 scopes 收窄 → 标记失效 + 路由重配
            # （后续 RPC 会逐个 FORBIDDEN，须尽早暴露而非零散失败）。
            if getattr(new_client, 'scopes_narrowed', False):
                await self._invalidate(instance, 'hello-ok granted scopes narrowed')
                raise NotPaired(pairing.status, pairing.pairing_request_id)
            # issue #222 问题2：hello-ok 轮换下发新 deviceToken（client 在 connect 内已采纳为当前值
            # 并经 on_device_token_rotated 钩子通知）→ 加密落库 + 以新 token re-key 供后续连接复用
            # （旧 token 被撤销即死局，采纳新 token 解之）。
            if new_client.device_token != pairing.device_token:
                await database_sync_to_async(self._pairing.update_device_token)(
                    instance, new_client.device_token,
                )
            self._clients[(url, new_client.device_token)] = new_client
            return new_client

    async def _invalidate(self, instance, reason: str) -> None:
        """标记配对失效（STATUS_ERROR）引导重配（issue #222）。"""
        await database_sync_to_async(self._pairing.mark_pairing_invalid)(instance, reason)

    async def _connect_with_recovery(self, client, instance, pairing) -> None:
        """按结构化错误码分流的握手恢复策略（issue #222 问题1）。成功返回；最终失败抛
        NotPaired（重配引导）或 ChatConnectError（UNAVAILABLE 有界耗尽等暂态硬失败）。"""
        # AUTH_TOKEN_MISMATCH：同一 client 有界重试一次已存 deviceToken（共 2 次尝试）。
        for attempt in range(2):
            try:
                await client.connect()
                return
            except ChatConnectError as exc:
                if exc.code == 'AUTH_TOKEN_MISMATCH':
                    if attempt == 0:
                        continue  # 有界重试一次已存 deviceToken
                    # 仍失败：停止自动重连、标记配对失效、引导重配（不再无限重建）。
                    await self._invalidate(instance, 'deviceToken rejected (AUTH_TOKEN_MISMATCH)')
                    raise NotPaired(pairing.status, pairing.pairing_request_id) from exc
                if exc.code == 'AUTH_SCOPE_MISMATCH':
                    # scope 不匹配：直接路由重配（重试 token 无意义）。
                    await self._invalidate(instance, 'scope mismatch (AUTH_SCOPE_MISMATCH)')
                    raise NotPaired(pairing.status, pairing.pairing_request_id) from exc
                if exc.code == 'UNAVAILABLE' and exc.details.get('reason') == 'startup-sidecars':
                    # 合法启动暂不可用：按 retryAfterMs 有界重试。
                    await self._retry_startup_sidecars(client, exc)
                    return
                raise  # 其它码（UNKNOWN/网络等）：原样上抛
        return  # 不可达（for-else 均 return/raise），显式标注

    async def _retry_startup_sidecars(self, client, first_exc: ChatConnectError) -> None:
        """UNAVAILABLE+startup-sidecars：按 details.retryAfterMs 有界重试（issue #222 问题1）。"""
        exc = first_exc
        for _ in range(_STARTUP_SIDECARS_MAX_RETRIES):
            retry_ms = exc.details.get('retryAfterMs') or 0
            if retry_ms > 0:
                await asyncio.sleep(min(retry_ms / 1000, 5.0))  # 上限 5s 防异常值拖死
            try:
                await client.connect()
                return
            except ChatConnectError as retry_exc:
                if retry_exc.code == 'UNAVAILABLE' and retry_exc.details.get('reason') == 'startup-sidecars':
                    exc = retry_exc
                    continue
                raise
        # 有界耗尽：抛最后一次 ChatConnectError（暂态硬失败，非配对问题，不路由重配）。
        raise exc

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
