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

from chat.pool import ChatFleet, NotPaired
from containers.models import Instance


class ChatConsumer(AsyncJsonWebsocketConsumer):
    """前端对话 WS：把 start/send 适配到该容器已配对长连接 client（Adapter）。"""

    async def connect(self):
        self._client = None  # pylint: disable=attribute-defined-outside-init
        # issue #214 T2：缓存 start 成功的 instance，供 client 失效后经 get_or_create 重取。
        self._instance = None  # pylint: disable=attribute-defined-outside-init
        self._active_runids: set[str] = set()  # pylint: disable=attribute-defined-outside-init
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
            await self.send_json({'type': 'error', 'message': '连接容器失败，请稍后重试'})
            return
        # 切容器/重连：旧 client 的本 consumer 审批订阅退订，避免推已失效连接（codex P1 独立退订）
        if self._client is not None and self._client is not client:
            self._client.remove_approval_subscriber(self._on_approval)
        self._client = client  # pylint: disable=attribute-defined-outside-init
        self._instance = instance  # pylint: disable=attribute-defined-outside-init  # issue #214：供失效重取
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
        except Exception:  # pylint: disable=broad-exception-caught
            # 网关拒绝（缺 operator.approvals 等）/连接已断。issue #214：dead 则复用自愈重取
            # 重试一次；非 dead / 重取失败 / 重试仍败 → error 帧带 approval id，前端仅复位该卡
            # （codex R2 P2，并发 resolve 不误复位其它在途卡）
            fresh = await self._reacquire_client()
            if fresh is not None:
                try:
                    await fresh.resolve_approval(approval_id, kind, decision)
                except Exception:  # pylint: disable=broad-exception-caught
                    await self.send_json({'type': 'error', 'message': '审批回覆失败，请稍后重试', 'id': approval_id})
                return
            await self.send_json({'type': 'error', 'message': '审批回覆失败，请稍后重试', 'id': approval_id})
            return
        # 不回送 approvalResolved——RPC ack payload 无 decision 字段（ADR 0003），
        # 且 resolved 事件可能在 ack 之前到达。权威 decision 仅由网关经
        # exec/plugin.approval.resolved 事件广播（codex P2 #163）。
        # 前端在 resolving 态等 resolved 事件落定。此处静默成功，不干扰权威结果。

    async def _reacquire_client(self):
        """issue #214 T2 自愈：cached client 失效（dead）后经 pool 重取一次并刷新审批订阅。

        触发时机：_handle_send/_handle_resolve 的 RPC 已抛错（连接已断）。仅当
        `self._client.dead`（#213 T1 看门狗/CancelledError 置位）才重取——非 dead 的失败
        （如 rate limit）返回 None，调用方直接发 error 帧，不做无谓重连。
        成功则切换 self._client：旧 client 退订本 consumer 审批回调、新 client 订阅
        （对齐 _handle_start 切换逻辑，codex P1 独立退订）。重取本身失败（NotPaired/握手失败）
        也返回 None，由调用方发 error 帧。返回新 client 或 None。

        codex #219 P1：换 client 后补拉 list_pending_approvals——订阅只投递**未来**事件，
        旧 client 收循环死亡期间积累的待审批不会随新订阅到达，须显式补拉（同 _handle_start
        的断线恢复），否则 agent 卡死直到用户手动再 start。
        """
        client = self._client
        if client is None or self._instance is None or not client.dead:
            return None
        try:
            fresh = await ChatFleet.get().get_or_create(self._instance)
        except Exception:  # pylint: disable=broad-exception-caught
            return None  # 重取失败：保持原错误路径，调用方发 error 帧
        if fresh is client:
            return None  # pool 未换 client（防御）：重试同一死 client 无意义，不重取
        client.remove_approval_subscriber(self._on_approval)
        fresh.add_approval_subscriber(self._on_approval)
        self._client = fresh  # pylint: disable=attribute-defined-outside-init
        # codex #219 P1：补拉换 client 前累积的待审批（best-effort，不影响已建立的新订阅）
        await self._push_pending_approvals(fresh)
        return fresh

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

    async def _handle_send(self, content):
        if self._client is None:
            await self.send_json({'type': 'error', 'message': '请先选择容器'})
            return
        session_key = content.get('sessionKey')
        message = content.get('message')
        if not session_key or not message:
            await self.send_json({'type': 'error', 'message': '缺少 sessionKey 或 message'})
            return
        try:
            # codex #219 P1：同一逻辑发送在初次与有界重试间复用同一 idempotencyKey——
            # 若网关已收下原 chat.send 但 ack 随死连接丢失，重试带同 key 让网关幂等去重，
            # 避免起两个 run、工具被执行两次。key 由本 consumer 按逻辑发送生成一次。
            idempotency_key = uuid.uuid4().hex
            run_id = await self._client.send_message(
                session_key, message, on_event=self._on_event,
                idempotency_key=idempotency_key,
            )
        except Exception:  # pylint: disable=broad-exception-caught
            # chat.send 被拒/连接已断。issue #214：dead 则自愈重取一次并有界重试一次（防循环）；
            # 非 dead / 重取失败 / 重试仍败 → error 帧，不传播导致 WS 关闭。
            fresh = await self._reacquire_client()
            if fresh is not None:
                try:
                    run_id = await fresh.send_message(
                        session_key, message, on_event=self._on_event,
                        idempotency_key=idempotency_key,  # codex #219 P1：复用同 key 幂等重试
                    )
                except Exception:  # pylint: disable=broad-exception-caught
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
        if self._client is not None:
            self._client.remove_approval_subscriber(self._on_approval)  # T06：独立退订（codex P1）
            for run_id in list(self._active_runids):
                self._client.discard(run_id)
            self._active_runids.clear()

    @staticmethod
    def _lookup_instance(name):
        if not name:
            return None
        return Instance.objects.filter(name=name).first()
