"""ws 连接生命周期协作者（issue #271/#275，parent #213 / #214 / #217）。

``ConnectionCore``：单条已配对长连接的 ws 生命周期单源（门面内部协作者，组合非继承）——connect
握手（challenge 提取 / 共享 connect_timeout 预算 / hello-ok policy 解析）、握手期恢复泵
（``_run_until`` 边 recv 边等恢复协程）、静默看门狗 recv_loop、dead 判定与 on_dead 上报、
4000 收尾、aclose 幂等清理。**唯一 I/O（ws 收发）独占此处**；``transport=`` 注入 seam 保留。

门面经构造注入本协作者（url/device_token/identity/scopes/transport/connect_frame_builder/
connect_timeout/on_dead）；跨桶通信经构造注入回调（不反向引用门面）：
- ``run_recovery``：握手成功后执行的恢复协程（门面传 ``RecoveryCoordinator.run``）；
- ``on_res``：握手/泵期 res 帧的回执结算（门面传 ``_resolve_ack``，RequestRouter 桶）；
- ``buffer_event``：泵期 event 帧缓冲（门面传 ``RunEventRouter.buffer_connect_event``）；
- ``handle_event``：recv_loop 的 event 分发（门面传 ``RunEventRouter.handle``）；
- ``flush_connection_level``：恢复完成后兜底回放连接级缓冲（门面传
  ``RunEventRouter.flush_connection_level_buffered``）；
- ``notify_all_error``：请求/路由桶收尾回调（门面传 ``_notify_all_error``）——recv_loop 断连与
  aclose 时 fail 全部挂起请求 + 活跃路由推终态 error 帧，带 message 参数（'容器连接断开' /
  'client closed'）。

owner（门面）注入用于 on_dead 上报：原 ``_mark_dead`` 调 ``self._on_dead(self)`` 的 ``self`` 是
门面——pool 的 ``_schedule_reconnect(key, reporter)`` 按「报告方是否是池中当前值」判定，回调须
携带门面身份而非本协作者（否则连接死亡通知被丢弃）。
"""
from __future__ import annotations

import asyncio
import json
import uuid

import websockets

from integration.openclaw.wire import (
    ChatConnectError,
    GatewayPolicy,
)
from integration.openclaw.wire import (
    ConnectFrameBuilder as _ConnectFrameBuilder,
)


class ConnectionCore:
    """ws 连接生命周期（握手/看门狗/dead/4000/aclose），独占 ws I/O，transport= 注入保留。"""

    def __init__(  # pylint: disable=too-many-arguments
        self,
        *,
        url: str,
        device_token: str,
        owner,
        identity=None,
        scopes=None,
        transport=None,
        connect_frame_builder=None,
        connect_timeout: float = 10.0,
        on_dead=None,
        run_recovery,
        on_res,
        buffer_event,
        handle_event,
        flush_connection_level,
        notify_all_error,
    ) -> None:
        self._url = url
        self._device_token = device_token
        self._owner = owner
        # session connect 帧 device 签名块所需（issue #139/#140）：identity 为 DeviceIdentity、
        # scopes 为配对时网关批准的 scopes（#141 pool 从 Pairing 注入）。两者可选——缺省（identity=None）
        # 走旧路径：不签名，仅 gateway_token + device_token（向后兼容）。nonce 不再构造注入，
        # 由 connect() 等 connect.challenge 动态提取（#140）。
        self._identity = identity
        self._scopes = scopes
        self._nonce = ''  # #140：connect() 等 challenge 提取后填入，供默认 builder 读（seam 保持 2 参）
        self._connect = transport or websockets.connect
        self._build_connect = connect_frame_builder or self._default_connect_frame
        self._connect_timeout = connect_timeout
        self._ws = None
        self._cm = None
        self._recv_task: asyncio.Task | None = None
        self._closed = False
        self._dead = False  # recv loop 退出（连接断开）→ pool 据此驱逐重建
        # #196 T1 / #213：网关 policy（hello-ok 解析；握手前为协议默认）。tick_interval_ms 驱动静默看门狗。
        self._policy = GatewayPolicy.default()
        # #196 T3 / #215：标 dead 时回调（pool 注入以触发主动重连；None = 不触发，如单测直建 client）。
        self._on_dead = on_dead
        # 握手成功后执行的恢复协程（RecoveryCoordinator.run，门面注入）。
        self._run_recovery = run_recovery
        # 握手/泵期 res 帧的回执结算（门面 _resolve_ack，RequestRouter 桶）。
        self._on_res = on_res
        # 泵期 event 帧缓冲（RunEventRouter.buffer_connect_event）。
        self._buffer_event = buffer_event
        # recv_loop 的 event 分发（RunEventRouter.handle）。
        self._handle_event = handle_event
        # 恢复完成后兜底回放连接级缓冲（RunEventRouter.flush_connection_level_buffered）。
        self._flush_connection_level = flush_connection_level
        # 请求/路由桶收尾（门面 _notify_all_error：fail 请求 + 活跃路由推终态 error，带 message）。
        self._notify_all_error = notify_all_error

    # ── 门面经委托 property 直读/直写的可变状态（测试直写 _ws/_dead/_policy 保语义）──

    @property
    def url(self) -> str:
        """连接目标 URL（门面经委托 property ``_url`` 直读）。"""
        return self._url

    @property
    def device_token(self) -> str:
        """配对 deviceToken（门面经委托 property ``_device_token`` 直读）。"""
        return self._device_token

    @property
    def ws(self):
        return self._ws

    @ws.setter
    def ws(self, value):
        self._ws = value

    @property
    def dead(self) -> bool:
        return self._dead

    @dead.setter
    def dead(self, value: bool) -> None:
        self._dead = value

    @property
    def policy(self) -> GatewayPolicy:
        return self._policy

    @policy.setter
    def policy(self, value: GatewayPolicy) -> None:
        self._policy = value

    @property
    def recv_task(self):
        return self._recv_task

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def cm(self):
        return self._cm

    @property
    def nonce(self) -> str:
        return self._nonce

    @property
    def identity(self):
        """本连接的 DeviceIdentity（#215：pool 主动重连复用同份材料重建，无需重读配对）。"""
        return self._identity

    @property
    def scopes(self):
        """本连接的已批准 scopes（#215：pool 主动重连复用重建）。"""
        return self._scopes

    @property
    def on_dead(self):
        return self._on_dead

    @property
    def is_closed_or_dead(self) -> bool:
        """连接是否已不可用（recv loop 退出或被显式关闭）；pool 据此不复用。"""
        return self._dead or self._closed

    def _default_connect_frame(self, req_id: str, device_token: str) -> dict:
        """已配对长连接帧：委托给单一来源 ConnectFrameBuilder.session()（issue #102 / #139 / #140）。

        spec §8.1 step5 + #139：配对后用 deviceToken 直连（auth.token）并附 Ed25519 device 签名块
        （identity/scopes 构造期注入；nonce 由 connect() 等 connect.challenge 提取后写入 self._nonce，#140）。
        identity 为 None（未配对/旧路径）时不签名——返回仅 gateway_token + device_token 的
        connect 帧（无 device 块，向后兼容）。

        codex #150 P2：本 builder 与注入的 connect_frame_builder 共用 (req_id, device_token) 两参契约
        ——nonce 经 self._nonce 实例态传入（connect() 提取后填），不在 seam 上加第三参，保持自定义
        两参 builder 可继续注入。
        """
        if self._identity is None:
            return {
                'type': 'req',
                'id': req_id,
                'method': 'connect',
                'params': {'auth': {'token': device_token}},
            }
        return _ConnectFrameBuilder.session(
            req_id=req_id, identity=self._identity, device_token=device_token,
            nonce=self._nonce, scopes=self._scopes,
        )

    async def connect(self) -> None:
        try:
            self._cm = self._connect(self._url)
            self._ws = await self._cm.__aenter__()  # pylint: disable=unnecessary-dunder-call
            req_id = uuid.uuid4().hex
            # 握手期独占 recv。codex #150 P2：challenge + connect res 共享**一份** connect_timeout
            # 预算——算一个 deadline，两段各用剩余时长，避免 challenge 卡到边界后 res 又拿整份
            # 预算（最坏 ~2× connect_timeout），拖慢 pool.get_or_create() 对慢/坏网关的感知。
            deadline = asyncio.get_running_loop().time() + self._connect_timeout
            try:
                if self._identity is not None:
                    # issue #140：先等 connect.challenge 提取 nonce，用 DeviceIdentity 签名后才发帧
                    self._nonce = await asyncio.wait_for(
                        self._await_challenge(), timeout=self._remaining(deadline),
                    )
                # 向后兼容：无 device_identity 走旧路径——不等 challenge、不签名、立即发帧。
                # 统一两参调用（builder seam 契约）；签名所需 nonce 已由默认 builder 读 self._nonce。
                frame = self._build_connect(req_id, self._device_token)
                await self._ws.send(json.dumps(frame))
                hello_ok = await asyncio.wait_for(
                    self._await_res(req_id), timeout=self._remaining(deadline),
                )
                # #213：解析 hello-ok payload.policy（驱动静默看门狗 2×tick）；缺字段由 from_hello_ok 回退默认
                self._policy = GatewayPolicy.from_hello_ok(hello_ok.get('payload'))
                # #196 T4 / #217：握手成功后（首连与每次重连）按契约恢复——sessions.subscribe →
                # （有活跃会话）messages.subscribe + chat.history + 采用 inFlightRun 重建路由。
                # 恢复经 _rpc 发 RPC 等 res，而握手期无 _recv_loop 收帧——connect 在恢复完成前持续
                # recv 并经 _on_res 分发（含 _rpc res 解析），恢复完成停泵交棒给 _recv_loop（防双 reader）。
                # 失败按建连失败处理（下方 BaseException → aclose + raise）。
                try:
                    await asyncio.wait_for(
                        self._run_until(self._run_recovery()),
                        timeout=self._remaining(deadline),
                    )
                finally:
                    # codex #236 P2-419：恢复完成后兜底回放泵期缓冲的**连接级** event 帧（approval /
                    # approvalResolved 无 runId、fan-out 不需路由）——否则无活跃会话 / 无可采用 run 时
                    # 它们滞留到无关的未来 send 才浮现。run-scoped 帧不在此弹（路由未就绪回放即被
                    # handle 丢弃），留待路由注册（send ack / inFlightRun 重建）时回放，不丢帧。
                    self._flush_connection_level()
            except TimeoutError as exc:
                raise ChatConnectError('connect handshake timeout') from exc
        except BaseException:
            await self.aclose()
            raise
        self._recv_task = asyncio.create_task(self.recv_loop())

    @staticmethod
    def _remaining(deadline: float) -> float:
        """deadline 前剩余秒数（codex #150 P2 共享预算）。已过期时返回 0——wait_for(0) 立即
        TimeoutError → connect() 归一为 ChatConnectError，而非对负 timeout 抛 ValueError。"""
        return max(0.0, deadline - asyncio.get_running_loop().time())

    async def _recv_until(self, predicate, describe: str) -> dict:
        """循环读帧直到 predicate 命中；忽略无关帧（乱序 event/stray res 容错，对齐 pairing_ws）。"""
        while True:
            raw = await self._ws.recv()
            msg = json.loads(raw)
            if predicate(msg):
                return msg

    async def _await_challenge(self) -> str:
        """等网关 connect.challenge 事件并提取 nonce（issue #140，对齐 pairing_ws._await_nonce）。"""
        msg = await self._recv_until(
            lambda m: m.get('type') == 'event' and m.get('event') == 'connect.challenge',
            'connect.challenge',
        )
        nonce = (msg.get('payload') or {}).get('nonce')
        if not nonce:
            raise ChatConnectError('connect.challenge missing nonce')
        return nonce

    async def _await_res(self, req_id: str) -> dict:
        msg = await self._recv_until(
            lambda m: m.get('type') == 'res' and m.get('id') == req_id,
            f'connect res (id={req_id})',
        )
        if not msg.get('ok'):
            raise ChatConnectError('connect handshake rejected by gateway')
        return msg

    async def _run_until(self, work) -> None:
        """跑 ``work``（connect 期恢复协程）并持续 recv 分发入站帧，直到 work 完成（#217）。

        握手期 _recv_loop 未起，work 内 _rpc 发的 req 需有人 recv 其 res——本泵即临时 reader，
        逐帧经 _on_res 分发（res 解析 pending RPC）。**event 帧缓冲**（buffer_event）：恢复期到达的
        事件路由尚未由 _recv_loop 接管，直接分发会丢（route 未就绪）；缓冲后由 _recv_loop 启动时
        回放，不丢帧。recv 用**短轮询**（10ms 超时重试）而非长阻塞：work 完成最后一帧 res 分发后
        即 done，泵下一轮轮询见 task.done() 即退出，不空等（真网关静默 / fake 挂起队列都不卡死）。
        work 完成（或失败）即返回；connect 在 finally 置 connect_done 后由 _recv_loop 接管（防双 reader）。
        """
        task = asyncio.ensure_future(work)
        try:
            while not task.done():
                try:
                    raw = await asyncio.wait_for(self._ws.recv(), timeout=0.01)
                except TimeoutError:
                    continue  # 暂无入站帧：复查 work 是否完成
                msg = json.loads(raw)
                if msg.get('type') == 'res':
                    self._on_res(msg)  # 回执结算（门面 _resolve_ack，同步方法——不 await）
                    # 让渡：恢复协程收到最后一帧 res 需一拍才标 done——让渡让其完成，下轮 while
                    # 见 task.done() 即退出，不多读一帧。
                    await asyncio.sleep(0)
                else:
                    # event：泵期路由未就绪（恢复重建的 inFlightRun / send_message 注册的 route 尚未
                    # 就位），缓冲待路由注册时由 _resolve_ack 回放——重连期进行中 run 事件不丢。
                    self._buffer_event(msg)
        finally:
            if not task.done():
                task.cancel()
            # 传播 work 的异常（恢复失败 → connect 失败）；取消泵自身不吞 work 结果。
            await asyncio.gather(task, return_exceptions=False)

    async def recv_loop(self) -> None:
        """静默看门狗 recv 循环（门面起 task，方法体即原门面 ``_recv_loop``）。

        #196 T1 / #213：连续静默 > 2×tickIntervalMs 即按契约 close code 4000 语义关闭、置 _dead、
        拒全部挂起请求（不重放）。tickIntervalMs 取自 hello-ok policy（缺省 30s → 60s）。
        每收到一帧 wait_for 重置，等价于「最后一次收帧后起算」的静默计时；半开连接（recv 永久挂起）
        超时即走断连收尾，让 pool 驱逐重建——修复原裸 recv() 永久挂起、_dead 永不置位、连接永不自愈。
        """
        silence_timeout = self._policy.tick_interval_ms * 2 / 1000
        try:
            while True:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=silence_timeout)
                msg = json.loads(raw)
                if msg.get('type') == 'res':
                    self._on_res(msg)  # 回执结算（门面 _resolve_ack，同步方法——不 await）
                else:
                    await self._handle_event(msg)
        except asyncio.CancelledError:  # pylint: disable=try-except-raise
            # #196 T1 / #213：task 取消即连接不可用（REST 跨 loop 清理 / 服务关闭竞态）。原分支只 raise
            # 不置位 → pool 快路径（not client.dead）无限复用假活 client，该容器聊天永久变砖。
            self._mark_dead()
            raise
        except Exception:  # pylint: disable=broad-exception-caught
            # 连接断开 / 静默超时（含看门狗 TimeoutError）：标记 dead 供 pool 驱逐重建，拒全部挂起请求
            # （不重放），按契约 close code 4000 语义关闭套接字（best-effort；pool 重建时 aclose 兜底）。
            self._mark_dead()
            if not self._closed:
                await self._notify_all_error('容器连接断开')
            if self._ws is not None:
                try:
                    await self._ws.close(4000)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
            return

    def _mark_dead(self) -> None:
        """置 dead 并触发 on_dead 回调（#215 pool 注入以启动主动重连）。回调 best-effort 不杀 recv loop。
        传入 owner（门面，codex #221 P1）：pool 按「报告方是否仍是池中当前值」判定，且能在 client 于
        connect() 后、放入 pool 前死亡时不丢通知（回调可直接携带报告方身份）。"""
        self._dead = True
        if self._on_dead is not None:
            try:
                self._on_dead(self._owner)
            except Exception:  # pylint: disable=broad-exception-caught
                pass

    async def aclose(self) -> None:
        """幂等清理（原门面 ``aclose``）：置 _closed、fail 请求/路由、取消 recv_task、关 ws/cm。

        fail 请求/路由经注入的 ``_notify_all_error('client closed')``（codex #219 七轮 P1：活跃
        路由推终态 error 帧）。与 recv-loop 清理幂等。
        """
        self._closed = True
        await self._notify_all_error('client closed')
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except (asyncio.CancelledError, Exception):  # pylint: disable=broad-exception-caught
                pass
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # pylint: disable=broad-exception-caught
                pass
        if self._cm is not None:
            try:
                await self._cm.__aexit__(None, None, None)
            except Exception:  # pylint: disable=broad-exception-caught
                pass
