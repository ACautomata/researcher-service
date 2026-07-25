"""chat.consumers —— ChatConsumer：前端 WS ↔ 容器 pool client（issue #41 / spec §8.4）。

握手经 JwtAuthMiddleware（scope['user'] 已验 JWT；匿名被 4401 拒）。前端发 start{container} → 经
ChatFleet 连该容器已配对长连接 → ready；发 send{sessionKey,message} → client.chat.send，chat 事件
经 _on_event 回推前端（text/done/error）。断开时 discard 活跃 runId，避免推已关闭连接。
"""
from __future__ import annotations

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from chat.pool import ChatFleet, NotPaired
from containers.models import Instance


class ChatConsumer(AsyncJsonWebsocketConsumer):
    """前端对话 WS：把 start/send 适配到该容器已配对长连接 client（Adapter）。"""

    async def connect(self):
        self._client = None
        self._active_runids: set[str] = set()
        await self.accept()

    async def receive_json(self, content):
        msg_type = content.get('type')
        if msg_type == 'start':
            await self._handle_start(content)
        elif msg_type == 'send':
            await self._handle_send(content)

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
        except Exception:
            # 连接握手失败（ChatConnectError 等）发 error 帧，不传播导致 Channels 关闭 WS
            await self.send_json({'type': 'error', 'message': '连接容器失败，请稍后重试'})
            return
        self._client = client
        await self.send_json({'type': 'ready', 'container': name})

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
            run_id = await self._client.send_message(
                session_key, message, on_event=self._on_event,
            )
        except Exception:
            # chat.send 被拒/连接已断：发 error 帧，不传播导致 WS 关闭
            await self.send_json({'type': 'error', 'message': '发送失败，请稍后重试'})
            return
        self._active_runids.add(run_id)

    async def _on_event(self, frame):
        # client recv 循环经此回调把翻译帧推给前端；send_json 可安全跨协程调用
        await self.send_json(frame)
        if frame.get('type') in ('done', 'error'):
            self._active_runids.discard(frame.get('runId'))

    async def disconnect(self, code):
        if self._client is not None:
            for run_id in list(self._active_runids):
                self._client.discard(run_id)
            self._active_runids.clear()

    @staticmethod
    def _lookup_instance(name):
        if not name:
            return None
        return Instance.objects.filter(name=name).first()
