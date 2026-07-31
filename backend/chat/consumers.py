"""chat.consumers —— ChatConsumer：前端 WS ↔ 容器 pool client（issue #41 / spec §8.4）。

握手经 JwtAuthMiddleware（scope['user'] 已验 JWT；匿名被 4401 拒）。前端发 start{container} → 经
ChatFleet 连该容器已配对长连接 → ready；发 send{sessionKey,message} → client.chat.send，chat 事件
经 _on_event 回推前端（text/done/error）。断开时 discard 活跃 runId，避免推已关闭连接。

T06 权限审批（issue #42 / spec §8.2）：start 后经 add_approval_subscriber 注册连接级审批订阅
（codex P1 订阅者集合：多 consumer 共享同一 pooled client 时 fan-out 到所有订阅者、独立退订不互伤），
审批卡经 _on_approval 透传给前端（type:approval，无 runId）；前端发 resolve{id,kind,decision} →
client.resolve_approval → 回执 approvalResolved{id,decision} 用网关权威 decision（first-answer-wins，
codex P1）；start 后 list_pending_approvals 补拉断线期间积累的待审批（codex P2）。disconnect 独立退订。

授权模型（安全复审 acknowledge）：容器是**全面板共享基础设施**（spec §5.2/§5.3/§5.4——共享 LLM key、
共享端口池、Django 挂 docker.sock 统一编排），`Instance`/`Session` 均无 owner/user_id。故 start/send/
resolve 与容器创建/删除等整个控制面一致，仅吃全局 IsAuthenticated，**无对象级归属校验**——认证用户
即可操作任意容器。这是既定的共享信任模型，非本 diff 引入；审批的 per-user 隔离数据（sessionKey→user）
网关不提供，后端无从绑定。若将来需要 per-user 隔离，须在 `Instance`/`Session` 加 owner 并在容器创建/
删除/对话/审批等**所有**控制面统一加对象级门（单独给审批加门会造成与等价特权面不一致的虚假安全感）。
"""
from __future__ import annotations

import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from websockets.exceptions import ConnectionClosed

from chat.chat_client import ChatPayloadTooLargeError, ChatSendTransmittedError
from chat.pool import ChatConnectionPool, ChatFleet, NotPaired
from containers.models import Instance


class ChatConsumer(AsyncJsonWebsocketConsumer):
    """前端对话 WS：把 start/send 适配到该容器已配对长连接 client（Adapter）。"""

    async def connect(self):
        self._client = None  # pylint: disable=attribute-defined-outside-init
        # issue #214 T2：缓存 start 成功的 instance，供 client 失效后经 get_or_create 重取。
        self._instance = None  # pylint: disable=attribute-defined-outside-init
        self._active_runids: set[str] = set()  # pylint: disable=attribute-defined-outside-init
        # #217 / codex #236 P2-261 + R2 P1-223：本 consumer 经 record_active_session 记住的 sessionKey
        # 集合（多会话共存，不再单一 slot），供 disconnect/切容器时逐一对称 unregister（防池化 client
        # 重连把恢复投影投到已关闭 consumer）。
        self._recovery_session_keys: set[str] = set()  # pylint: disable=attribute-defined-outside-init
        # codex #190 P1: 浏览器 WebSocket subprotocol 要求服务器回复匹配的协议值。
        # 前端传 ['access_token', <jwt>]；JwtAuthMiddleware 验证通过后透传给
        # ChatConsumer，视取 'access_token' 回显给浏览器，避免「无响应 subprotocol」
        # 导致浏览器拒绝握手（closeCode=1006）。
        subprotocol = None
        for proto in self.scope.get('subprotocols', []):
            if proto == 'access_token':
                subprotocol = 'access_token'
                break
            if isinstance(proto, str) and proto.startswith('access_token.'):
                # 单值格式 ['access_token.<jwt>']：必须原样回显，不能硬编码为
                # 'access_token'（codex #190 P2），否则浏览器因响应 subprotocol
                # 不在已声明列表中而拒绝握手（closeCode=1006）。
                subprotocol = proto
                break
        await self.accept(subprotocol)

    async def receive_json(self, content):  # pylint: disable=arguments-differ
        msg_type = content.get('type')
        if msg_type == 'start':
            await self._handle_start(content)
        elif msg_type == 'send':
            await self._handle_send(content)
        elif msg_type == 'resolve':
            await self._handle_resolve(content)
        elif msg_type == 'ping':
            # codex #249 P1：浏览器↔Channels 腿的应用层心跳回显。本腿除 ready/业务事件外无周期帧
            # （daphne 默认不发协议 ping），前端静默看门狗若无 JS 可见活性信号会把 idle 健康连接误
            # 判半开掐死。前端周期 ping → 此处回 pong（纯活性，不触 run/session/容器状态）。
            await self.send_json({'type': 'pong'})

    async def _handle_start(self, content):
        name = content.get('container')
        instance = await database_sync_to_async(self._lookup_instance)(name)
        if instance is None:
            await self.send_json({'type': 'error', 'message': f'容器 {name} 不存在'})
            return
        try:
            client = await ChatFleet.get().get_or_create(instance)
        except NotPaired:
            await self.send_json({
                'type': 'error',
                'message': '容器未配对，请先在容器页完成设备配对',
            })
            return
        except Exception:  # pylint: disable=broad-exception-caught
            # 连接握手失败（ChatConnectError 等）发 error 帧，不传播导致 Channels 关闭 WS
            await self.send_json({
                'type': 'error', 'message': '连接容器失败，请稍后重试', 'retryable': True,
            })
            return
        # 切容器/重连：旧 client 的本 consumer 审批订阅退订，避免推已失效连接（codex P1 独立退订）。
        # codex #219 P2：经 pool 再解析旧容器的活 client 退订（自愈后 self._client 可能是死 client，
        # 退订落空会把回调泄漏到活的新 client）。self._instance 此刻仍是旧容器，_unsubscribe_targets 用之。
        # codex #219 三轮 P2-444：force-repair 换 token 后回调可能在旧 self._client——对所有目标幂等退订。
        for old_target in await self._unsubscribe_targets():
            if old_target is not client:
                old_target.remove_approval_subscriber(self._on_approval)
                # codex #236 P2-261：切容器前把旧 client 上的恢复回调一并注销（换 client 后旧 client
                # 重连不应再把本 consumer 的恢复投影投出）。新 client 的记住在下次 _handle_send 重建。
                for session_key in self._recovery_session_keys:
                    unregister = getattr(old_target, 'unregister_active_session', None)
                    if unregister is not None:
                        unregister(session_key, self._on_event)
        # 换 client：旧记住失效，下次 send 重记
        self._recovery_session_keys.clear()  # pylint: disable=attribute-defined-outside-init
        self._client = client  # pylint: disable=attribute-defined-outside-init
        self._instance = instance  # pylint: disable=attribute-defined-outside-init  # issue #214：供失效重取
        # codex #249 P1 (id 3690452668, ChatView.vue:511)：浏览器↔Channels 腿断线重连恢复活跃会话。
        # start 帧可带 sessionKey（前端 connect() 在重连时传入断线前选中的会话）——本 consumer 经
        # record_active_session 重新注册其恢复回调。缺它则：浏览器 socket 在**活跃 run 进行中**断开时，
        # disconnect() 已注销旧 consumer 的会话回调（对称清理），而重连的新 consumer 复用**同一存活池化
        # client**（不经 client.connect() 恢复），且 record_active_session 仅在 _handle_send 触发——新
        # consumer 既收不到当前 run 的剩余增量、也收不到它的终态帧（loadHistory 快照之后产生的内容缺失，
        # 直到手动刷新/切会话）。同族对称：上方 cleanup 循环 + _recovery_session_keys 已统一处理换 client/
        # disconnect 的注销，故此处只需注册 + 记 key，切换/断开由既有路径对称清。
        session_key = content.get('sessionKey')
        if session_key:
            resume = getattr(client, 'resume_active_session', None)
            if resume is not None:
                try:
                    await resume(session_key, self._on_event)
                except Exception:  # pylint: disable=broad-exception-caught
                    unregister = getattr(client, 'unregister_active_session', None)
                    if unregister is not None:
                        unregister(session_key, self._on_event)
                    await self.send_json({
                        'type': 'error', 'message': '恢复会话失败，请稍后重试', 'retryable': True,
                    })
                    return
            else:
                # Compatibility for lightweight client implementations; production wire clients
                # expose resume_active_session and rebuild the in-flight route above.
                client.record_active_session(session_key, self._on_event)
            self._recovery_session_keys.add(session_key)  # pylint: disable=attribute-defined-outside-init
        # T06：注册连接级审批订阅（codex P1 订阅者集合，多 consumer 共享 client 不互伤）
        client.add_approval_subscriber(self._on_approval)
        await self.send_json({'type': 'ready', 'container': name})
        # codex P2：断线期间积累的待审批补拉（agent 不再卡死）；best-effort，失败不影响 ready
        await self._push_pending_approvals(client)

    async def _handle_resolve(self, content):
        """T06 审批回覆（spec §8.2）：前端发 resolve{id,kind,decision} → client.resolve_approval。"""
        if self._client is None:
            await self.send_json({'type': 'error', 'message': '请先选择容器'})
            return
        approval_id = content.get('id')
        kind = content.get('kind')
        decision = content.get('decision')
        if not approval_id or not kind or not decision:
            await self.send_json({'type': 'error', 'message': '缺少 id/kind/decision'})
            return
        if kind not in ('exec', 'plugin'):
            await self.send_json({'type': 'error', 'message': f'非法 kind（{kind}），仅允许 exec/plugin'})
            return
        if decision not in ('allow-once', 'allow-always', 'deny'):
            await self.send_json({'type': 'error', 'message': f'非法 decision（{decision}），仅允许 allow-once/allow-always/deny'})
            return
        try:
            await self._client.resolve_approval(approval_id, kind, decision)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            # 网关拒绝（缺 operator.approvals 等）/连接已断。issue #214：dead 则复用自愈重取
            # 重试一次；codex #219 三轮 P2：原生 ConnectionClosed（ws.send 撞刚死 socket）即使
            # dead 未置位也重取（竞态，exc 作 evidence 传入）。业务拒绝（ChatSendError）非连接
            # 断不重取。重取失败 / 重试仍败 → error 帧带 approval id，前端仅复位该卡
            # （codex R2 P2，并发 resolve 不误复位其它在途卡）
            fresh = await self._reacquire_client(evidence=exc)
            if fresh is not None:
                try:
                    await fresh.resolve_approval(approval_id, kind, decision)
                except Exception as retry_exc:  # pylint: disable=broad-exception-caught
                    # codex #219 十三轮 P2-517：重试这条 replacement client 也撞连接异常（fresh 死）
                    # 时，迁移过去的全体审批订阅者还挂在死 fresh 上——对齐 _handle_send 六轮 P2-875，
                    # 对该连接异常也做连接级恢复（重取迁移订阅者 + 补拉待审批），但**不二次重试**
                    # resolve（有界一次）。业务拒绝（ChatSendError）经 evidence guard 不重取。
                    await self._reacquire_client(evidence=retry_exc)
                    await self.send_json({'type': 'error', 'message': '审批回覆失败，请稍后重试', 'id': approval_id})
                return
            await self.send_json({'type': 'error', 'message': '审批回覆失败，请稍后重试', 'id': approval_id})
            return
        # 不回送 approvalResolved——RPC ack payload 无 decision 字段（ADR 0003），
        # 且 resolved 事件可能在 ack 之前到达。权威 decision 仅由网关经
        # exec/plugin.approval.resolved 事件广播（codex P2 #163）。
        # 前端在 resolving 态等 resolved 事件落定。此处静默成功，不干扰权威结果。

    async def _reacquire_client(self, evidence: BaseException | None = None):
        """issue #214 T2 自愈：cached client 失效后经 pool 重取一次并刷新审批订阅。

        触发时机：_handle_send/_handle_resolve 的 RPC 已抛错（连接已断）。满足下列任一即重取：
        - `self._client.dead`（#213 T1 看门狗/CancelledError 置位）；或
        - `evidence` 是原生 `websockets.exceptions.ConnectionClosed`（codex #219 三轮 P2）：
          send_message/resolve_approval 在刚关闭的 socket 上 `ws.send()` 抛出它，而后台 recv
          task 尚未跑异常处理器置 `dead`——竞态窗口内 guard 只看 dead 会漏。ConnectionClosed
          与 ChatClientError/ChatSendError **均不相交**（websockets 16.x 层级），它本身就是
          连接已断的充分证据（帧未发出、网关未起 run，可安全重取）。业务拒绝（rate limit 的
          ChatSendError、网关 ack ok:false）不传 evidence → 不重取，边界不变；或
        - `evidence` 是 `ChatSendTransmittedError` **且其 cause 是 ConnectionClosed**（codex #219
          八轮 P1-224）：chat_client 在 recv loop 置 `dead` 前就把 send 刷帧中途的原生
          ConnectionClosed 归为 transmitted（chat_client.py:612-615）——此刻 `client.dead` 仍为
          False，guard 只看 dead/ConnectionClosed 会漏，不换连接 → 全体审批订阅者滞留死 client。
          此类 transmitted 是「帧或已部分到达、连接已物理断」的死证据：须重取连接（迁移订阅者 +
          补拉待审批），但仍**不重发** chat.send。判据须精确到 cause（九轮 P1-994）：仅 ack 超时
          的健康 socket 也抛 transmitted（cause 是 TimeoutError），不能当死证据误重取——见
          `_is_connection_dead_evidence`。
        重取前先查 pool 健康 client（codex #219 五轮 P1）：共享 client 时若别人已换好（pool
        健康项非 self._client）直接采纳、不 evict——避免误关别的 consumer 建好的健康连接并
        把订阅者迁空。否则（pool 健康项就是自己这个死/濒死 client）先经 pool.evict 驱逐缓存
        的濒死 client 再 get_or_create 重建（codex #219 四轮 P2-891）：否则 pool 快路径在
        dead 未置位时返回同一 client，identity check 放弃恢复。成功则切换 self._client 并把
        **所有**审批订阅者迁到新 client（codex #219 P2，见下）。
        重取本身失败（NotPaired/握手失败）也返回 None，由调用方发 error 帧。返回新 client 或 None。

        codex #219 P1：换 client 后补拉 list_pending_approvals——订阅只投递**未来**事件，
        旧 client 收循环死亡期间积累的待审批不会随新订阅到达，须显式补拉（同 _handle_start
        的断线恢复），否则 agent 卡死直到用户手动再 start。

        codex #219 P2：多 consumer 共享同一 pooled client 时，只迁移触发自愈的本 consumer
        会让其余被动 consumer 仍挂在死 client 上、错过新连接上的审批。故把旧 client 的**全部**
        订阅者迁到 fresh（本 consumer 的回调也在其中），补拉的待审批也 fan-out 到全部订阅者
        （不只推本 consumer），保住共享 fan-out 契约。

        codex #219 十四轮 P2-183：迁移源是 reacquire 带回的 **replaced**（pool 在锁内实际驱逐的
        缓存 client），而非本 consumer 持有的 self._client——后者可能是更早的空壳代际（订阅者早被
        peer 迁走），从它迁会把当前真实订阅者丢在被关掉的 replaced 上。
        """
        client = self._client
        if client is None or self._instance is None:
            return None
        if not (client.dead
                # 连接级证据（充分证明该重取连接）：原生 ConnectionClosed（连接已断，三轮 P2）；
                # 或 transmitted 且其 cause 是 ConnectionClosed（mid-send 刷帧中途关闭——帧或已
                # 部分到达、连接已物理断，但 recv loop 未置 dead 的竞态，八轮 P1-224）。
                or self._is_connection_dead_evidence(evidence)):
            return None
        try:
            # codex #219 六轮 P1-872：经 pool.reacquire 在 per-key 锁内原子完成「比较缓存项 →
            # 采纳（别的 consumer 已换好的健康连接，非 self._client）/ 驱逐（自己持有的死 client）
            # → 重建」——消除原 get_live→evict→get_or_create 三步的跨 consumer TOCTOU（两
            # consumer 并发自愈互踢对方建好的连接）。evidence（ConnectionClosed）证明已死但 dead
            # 未置位时，reacquire 也因缓存项==expected_client 而驱逐重建（对齐四轮 P2-891）。
            # codex #219 十四轮 P2-183：reacquire 返回 (fresh, replaced)——replaced 是它在锁内
            # **实际驱逐**的缓存 client（无驱逐/采纳则 None）。
            fresh, replaced = await ChatFleet.get().reacquire(self._instance, client)
        except Exception:  # pylint: disable=broad-exception-caught
            return None  # 重取失败：保持原错误路径，调用方发 error 帧
        if fresh is client:
            return None  # pool 未换 client（防御）：重试同一死 client 无意义，不重取
        # codex #219 P2：迁移全部订阅者（含本 consumer），被动 consumer 不滞留死 client。
        # codex #219 十四轮 P2-183：从 **replaced**（pool 实际驱逐的缓存 client）迁，而非
        # 本 consumer 持有的 client——被动 consumer 缓存的 self._client 可能是更早的空壳代际
        # （其订阅者早已被 peer 迁走），而 pool 缓存里实际被替换的那代才挂着当前全部订阅者；
        # 从 self._client 迁会把真实订阅者丢在被关掉的 replaced 上、全体审批回调失联。
        # 多数情况（本 consumer 持有的就是缓存项）replaced is client，行为与原来一致。
        # codex #219 十六轮 P2-219：迁移与 pool 驱逐死 client 共用同一实现（_migrate_subscribers）。
        source = replaced if replaced is not None else client
        ChatConnectionPool._migrate_subscribers(source, fresh)
        # codex #236 R4 P1：采纳 fresh 后把本 consumer 的**恢复注册**一并迁移——被动 consumer 持
        # 死 client（pool 主动重连已换掉）时，换会话 A→B 的 unregister+record 只作用在死对象上，
        # fresh 仍留 A、缺 B（下次重连把 A 投影投进显示 B 的 UI；disconnect 清不掉留存的 A 回调）。
        # 对齐上方 _migrate_subscribers 的「从 replaced（被驱逐代）迁」语义：从 source 读回本
        # consumer 记住的会话，退订 source 上的、重注册到 fresh——若 source 上无本 consumer 的
        # 会话（被动 consumer 从空壳代迁移），则保持 fresh 现状（peer 的注册不被扰动）。
        for session_key in list(self._recovery_session_keys):
            unregister = getattr(source, 'unregister_active_session', None)
            if unregister is not None:
                unregister(session_key, self._on_event)
            if getattr(fresh, 'record_active_session', None) is not None:
                fresh.record_active_session(session_key, self._on_event)
        self._client = fresh  # pylint: disable=attribute-defined-outside-init
        # codex #219 P1+P2：补拉换 client 前累积的待审批，并 fan-out 到全部迁移订阅者
        # （best-effort，不影响已建立的新订阅）；共享 client 的各 consumer 都恢复。
        await self._fanout_pending_approvals(fresh)
        return fresh

    async def _fanout_pending_approvals(self, client):
        """补拉待审批并 fan-out 到该 client 全部订阅者（best-effort，失败静默）。

        _reacquire_client 自愈换 client 后用：多 consumer 共享 client 时，补拉的卡须
        经各订阅者回调送达每个 consumer 的前端（codex #219 P2），不只推触发自愈的那个。
        """
        try:
            cards = await client.list_pending_approvals()
        except Exception:  # pylint: disable=broad-exception-caught
            return
        for card in cards:
            for cb in client.approval_subscribers():
                try:
                    await cb(card)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass

    async def _push_pending_approvals(self, client):
        """断线/换 client 后补拉待审批卡透传前端（best-effort，失败静默）。

        _handle_start（ready 后）与 _reacquire_client（自愈换 client 后）共用同一恢复
        语义（codex #219 P1：订阅只投未来事件，死循环期间积累的待审批须显式补拉）。
        """
        try:
            for card in await client.list_pending_approvals():
                await self.send_json(card)
        except Exception:  # pylint: disable=broad-exception-caught
            pass

    async def _handle_send(self, content):  # pylint: disable=too-many-return-statements
        if self._client is None:
            await self.send_json({'type': 'error', 'message': '请先选择容器'})
            return
        session_key = content.get('sessionKey')
        message = content.get('message')
        if not session_key or not message:
            await self.send_json({'type': 'error', 'message': '缺少 sessionKey 或 message'})
            return
        # #196 T4 / #217：记住当前活跃 sessionKey + 其恢复回调，供 pool 主动重连后恢复该会话投影
        # （messages.subscribe + chat.history + inFlightRun 路由重建）。换会话/换 client 再发时更新。
        # codex #236 R3 P1-275：同一 consumer **换会话**（A→B）时先注销先前记住的会话 A——否则
        # _recovery_session_keys 保留 A 直到切容器/断开，重连会把 A 的投影投到当前正显示的 B 会话
        # （恢复帧不带 sessionKey，前端按当前会话应用即错位）。
        # codex #236 R4 P1：换会话注销须落到**所有**持有本 consumer 回调的目标上——被动 consumer
        # 的 self._client 可能是死 client，但 A 注册可能在 pool 主动重连 propagate 时被带到**活**的
        # 替换 client 上（共享池化 client 场景）；只注销死 self._client 会让活 client 仍留 A，下次
        # 重连把 A 投影投进显示 B 的 UI（R4 P1 同族）。故对 [_live, self._client] 去重后的每个目标
        # 都 unregister A（幂等：未注册即 no-op）。
        old_keys = [k for k in list(self._recovery_session_keys) if k != session_key]
        if old_keys:
            for old_target in await self._unsubscribe_targets():
                unregister = getattr(old_target, 'unregister_active_session', None)
                if unregister is not None:
                    for old_key in old_keys:
                        unregister(old_key, self._on_event)
            for old_key in old_keys:
                self._recovery_session_keys.discard(old_key)  # pylint: disable=attribute-defined-outside-init
        self._client.record_active_session(session_key, self._on_event)
        # codex #236 P2-261：记 key 供 disconnect/switch 对称注销（集合，多会话共存）
        self._recovery_session_keys.add(session_key)  # pylint: disable=attribute-defined-outside-init
        # codex #219 P1：同一逻辑发送在初次与有界重试间复用同一 idempotencyKey——
        # 若网关已收下原 chat.send 但 ack 随死连接丢失，重试带同 key 让网关幂等去重，
        # 避免起两个 run、工具被执行两次。key 由本 consumer 按逻辑发送生成一次。
        idempotency_key = uuid.uuid4().hex
        try:
            run_id = await self._client.send_message(
                session_key, message, on_event=self._on_event,
                idempotency_key=idempotency_key,
            )
        except ChatPayloadTooLargeError as exc:
            # #196 T5 / #216：本地帧大小预检超限——透传明确文案「消息超过网关帧大小上限…请分段发送」，
            # 区别于真连接断开的笼统「发送失败」。其他 ChatSendError（网关 ack 拒绝/timeout）仍走
            # 下方通用错误（spec 只要求把超限这一种映射为可理解错误，不透传英文技术文案）。
            await self.send_json({'type': 'error', 'message': str(exc)})
            return
        except ChatSendTransmittedError as exc:
            # codex #219 P1：帧已发出但 ack 丢失——网关可能已起 run，其事件流绑在死连接上
            # （runId 是连接级的，重连不可恢复）。盲重试会被幂等去重到同一 runId，但新 client
            # 的 route 收不到任何事件 → 浏览器 pending 永久卡住。故**不重发** chat.send，发终态
            # error 帧解锁前端（用户可重发），不假设新 route 有完整事件流。不加入 _active_runids。
            # codex #219 P1 二轮：但**仍须重取连接**——旧 client 已死，全体审批订阅者还挂在死
            # client 上；被收下的 run 若起审批，不经新连接投递/补拉会一直阻塞。故重取（迁移全体
            # 订阅者 + fan-out 补拉待审批），只是不重发 chat.send。
            # codex #219 八轮 P1-224：exc 作 evidence 传入——transmitted 抛出时 dead 可能未置位
            # （mid-send 竞态），无 evidence 则 guard 不通过、不换连接，订阅者滞留死 client。
            await self._reacquire_client(evidence=exc)
            await self.send_json({
                'type': 'error',
                'message': '连接中断，发送结果未知：若已发出请稍后在历史确认，否则请重试',
            })
            return
        except Exception as exc:  # pylint: disable=broad-exception-caught
            # chat.send 未发出（client not connected / 网关显式拒绝 ack ok:false）/连接已断——
            # 确定未起 run，安全自愈。issue #214：dead 则重取一次并有界重试一次（防循环）；
            # codex #219 三轮 P2：原生 ConnectionClosed（ws.send 撞刚死 socket）即使 dead 未
            # 置位也重取（竞态，exc 作 evidence 传入）。业务拒绝（rate limit 的 ChatSendError）
            # 非连接断不重取。重取失败 / 重试仍败 → error 帧，不传播导致 WS 关闭。
            fresh = await self._reacquire_client(evidence=exc)
            if fresh is not None:
                try:
                    run_id = await fresh.send_message(
                        session_key, message, on_event=self._on_event,
                        idempotency_key=idempotency_key,  # codex #219 P1：复用同 key 幂等重试
                    )
                except ChatSendTransmittedError as retry_tx:
                    # 重试这条也撞上已发出 ack 丢失：不再嵌套重发，发终态 error。
                    # codex #219 四轮 P2-895：但仍须**再重取**——fresh 发出帧后已死，迁移过去的
                    # 全体审批订阅者还挂在死 fresh 上；被收下的 run 若起审批不经新连接补拉会阻塞。
                    # 故做与外层 transmitted 分支相同的连接/订阅者恢复（仍不重发 chat.send）。
                    # codex #219 八轮 P1-224：retry_tx 作 evidence——transmitted 时 dead 或未置位，
                    # 无 evidence 则 guard 不通过、不换连接，订阅者滞留死 fresh。
                    await self._reacquire_client(evidence=retry_tx)
                    await self.send_json({
                        'type': 'error',
                        'message': '连接中断，发送结果未知：若已发出请稍后在历史确认，否则请重试',
                    })
                    return
                except Exception as retry_exc:  # pylint: disable=broad-exception-caught
                    # codex #219 六轮 P2-875：重试的 send 也可能撞原生 ConnectionClosed（替换
                    # socket 在 recv loop 置 dead 前关闭，dead 未置位）——落到此宽 except 而非
                    # transmitted 分支。对该连接异常也做连接级恢复（迁移订阅者 + 补拉待审批，
                    # 仍不重发 chat.send）；业务拒绝（ChatSendError）经 evidence guard 不重取。
                    await self._reacquire_client(evidence=retry_exc)
                    await self.send_json({'type': 'error', 'message': '发送失败，请稍后重试'})
                    return
            else:
                await self.send_json({'type': 'error', 'message': '发送失败，请稍后重试'})
                return
        self._active_runids.add(run_id)

    async def _on_event(self, frame):
        # client recv 循环经此回调把翻译帧推给前端；send_json 可安全跨协程调用
        await self.send_json(frame)
        if frame.get('type') in ('done', 'error'):
            self._active_runids.discard(frame.get('runId'))

    async def _on_approval(self, frame):
        # T06 审批卡：client 收到 exec/plugin.approval.requested 后经此透传给前端
        await self.send_json(frame)

    async def disconnect(self, code):
        # codex #219 P2：从 pool 再解析活 client 退订/丢弃 runId——自愈换 client 后，
        # 缓存的 self._client 可能仍是死 client（被动 consumer 被迁移过），直接退订会把回调
        # 泄漏到存活的新 client（T06 独立退订契约）。best-effort，WS 关闭路径不抛错。
        # codex #219 三轮 P2-444：force-repair 换 device_token 后，pool 可同时有旧 token
        # client + 新 token live client；回调/路由可能还在旧 self._client 上。对 [live,
        # self._client] 去重后的每个目标都退订 + discard（幂等，cb in list 检查），覆盖
        # 持有回调的旧 client，避免泄漏后仍被旧 client fan-out。
        for target in await self._unsubscribe_targets():
            target.remove_approval_subscriber(self._on_approval)  # T06：独立退订（codex P1）
            for run_id in list(self._active_runids):
                target.discard(run_id)
            # codex #236 P2-261：对称注销 record_active_session 记住的恢复回调——否则池化 client 后续
            # 重连把恢复投影投到已关闭 consumer（输出丢失 + 回调异常连累 connect），并保留本 consumer。
            for session_key in self._recovery_session_keys:
                unregister = getattr(target, 'unregister_active_session', None)
                if unregister is not None:
                    unregister(session_key, self._on_event)
        self._active_runids.clear()
        self._recovery_session_keys.clear()  # pylint: disable=attribute-defined-outside-init

    async def _unsubscribe_targets(self):
        """退订/丢弃 runId 的目标 client 列表：pool 里的活 client + 缓存的 self._client，去重。

        codex #219 P2：自愈把本 consumer 的审批回调迁到新 client 后，self._client 可能仍是
        死 client；退订须落到持有回调的活 client 上，否则回调泄漏。
        codex #219 三轮 P2-444：force-repair 换 token 后 pool 的 live client 与持有回调的
        self._client 可能是**两个不同对象**——只退 live 会漏掉 self._client 上的回调/路由。
        故返回两者去重（保序：live 在前），调用方对每个做幂等清理。pool 查询失败/无 live
        时只回 self._client（保持原行为，best-effort）。
        """
        targets: list = []
        if self._instance is not None:
            try:
                live = await ChatFleet.get().get_live(self._instance)
            except Exception:  # pylint: disable=broad-exception-caught
                live = None
            if live is not None:
                targets.append(live)
        if self._client is not None and self._client not in targets:
            targets.append(self._client)
        return targets

    @staticmethod
    def _is_connection_dead_evidence(evidence: BaseException | None) -> bool:
        """evidence 是否充分证明「连接已死、该重取」——区别于「本次发送不可靠但连接仍活」。

        codex #219 九轮 P1-994：三类 ChatSendTransmittedError 连接死活不同，不能一律当死证据——
        - mid-send 原生 ConnectionClosed（chat_client.py:612-615，`from ConnectionClosed`）：socket
          物理关闭、recv loop 未置 dead 的竞态 → 连接已死，**是**死证据（cause 是 ConnectionClosed）；
        - 健康 socket 仅 ack 超时（chat_client.py:619-622，`from TimeoutError`）：socket **仍活**，
          重取会 aclose 健康 pooled client、向所有无关在途路由发终态 error（一次慢 ack abort 全部
          对话）→ **不是**死证据（cause 是 TimeoutError，排除）；
        - recv loop 死注入 ChatClientError（chat_client.py:628-633，cause 是 ChatClientError）：recv
          loop 已置 dead（chat_client.py:300），由 `client.dead` 分支覆盖，无需 evidence 判定。
        故 transmitted 仅当其 cause 是 ConnectionClosed 才算死证据。原生 ConnectionClosed（三轮 P2，
        resolve/未包装路径）也直接算。
        """
        if isinstance(evidence, ConnectionClosed):
            return True
        return (isinstance(evidence, ChatSendTransmittedError)
                and isinstance(evidence.__cause__, ConnectionClosed))

    @staticmethod
    def _lookup_instance(name):
        if not name:
            return None
        return Instance.objects.filter(name=name).first()
