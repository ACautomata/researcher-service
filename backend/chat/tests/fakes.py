"""chat 测试替身：FakeTransport（配对握手 TDD 用）。

构造三种网关应答脚本（hello-ok / PAIRING_REQUIRED / 连接错误），
记录 connect 调用次数（验证幂等不重握手）。支持：
- 回显 connect 请求 id（hello-ok res 的 id = 实际 connect req id，对齐协议 req/res 关联）。
- 注入乱序帧（challenge 前/ connect res 前的无关 event/stray res），验证握手容错。
无需真容器/真网关。
"""
import asyncio
import json


class _FakeWs:
    """按脚本应答的 fake websocket。challenge 帧先发；connect res 回显实际请求 id。"""

    def __init__(self, pre_challenge_frames, result_frame, pre_result_frames):
        self._pre_challenge = list(pre_challenge_frames)
        self._result_frame = result_frame
        self._pre_result = list(pre_result_frames)
        self.sent = []

    async def send(self, data):
        self.sent.append(json.loads(data))

    async def recv(self):
        # 1. challenge 前的乱序帧
        if self._pre_challenge:
            return json.dumps(self._pre_challenge.pop(0))
        # 2. connect res 前的乱序帧（须在已收到 connect 后才发出）
        if self.sent and self._pre_result:
            return json.dumps(self._pre_result.pop(0))
        # 3. 正式应答：challenge（未发 connect 时）或 result（回显 connect id）
        if not self.sent:
            return json.dumps(
                {'type': 'event', 'event': 'connect.challenge',
                 'payload': {'nonce': 'nz', 'ts': 1}}
            )
        frame = dict(self._result_frame)
        if frame.get('type') == 'res':
            frame['id'] = self.sent[0].get('id')  # 回显 connect 请求 id
        return json.dumps(frame)

    async def close(self):
        pass


class FakeTransport:
    """connect(url) → async CM 产出按脚本应答的 fake ws。"""

    def __init__(self, result_frame, pre_challenge_frames=None, pre_result_frames=None,
                 error: Exception | None = None):
        self._result_frame = result_frame
        self._pre_challenge = pre_challenge_frames or []
        self._pre_result = pre_result_frames or []
        self._error = error
        self.connect_calls = 0

    # ---- 脚本构造器 ----
    # 默认返回验收所需的完整 operator scopes；测试可覆盖为部分/空以验证拒绝逻辑。
    _DEFAULT_SCOPES = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals']

    @classmethod
    def hello_ok(cls, scopes=None, device_token='dt-fake', **kwargs):
        return cls(
            result_frame={'type': 'res', 'ok': True,
                          'payload': {'auth': {'deviceToken': device_token, 'role': 'operator',
                                               'scopes': scopes if scopes is not None else cls._DEFAULT_SCOPES}}},
            **kwargs,
        )

    @classmethod
    def pairing_required(cls, request_id='req-1', **kwargs):
        return cls(
            result_frame={'type': 'res', 'ok': False,
                          'error': {'code': 'PAIRING_REQUIRED',
                                    'details': {'requestId': request_id,
                                                'recommendedNextStep': 'wait_then_retry',
                                                'retryable': True}}},
            **kwargs,
        )

    @classmethod
    def connect_error(cls, message='connect failed', **kwargs):
        return cls(
            result_frame={'type': 'res', 'ok': False,
                          'error': {'code': 'AUTH_FAILED', 'message': message}},
            **kwargs,
        )

    # ---- transport 协议 ----
    def __call__(self, url):
        self.connect_calls += 1
        if self._error is not None:
            raise self._error
        return _CM(_FakeWs(self._pre_challenge, self._result_frame, self._pre_result))


class _CM:
    def __init__(self, ws):
        self._ws = ws

    async def __aenter__(self):
        return self._ws

    async def __aexit__(self, *a):
        return False


class _FakeChatWs:
    """对话长连接 fake ws（issue #41 TDD）。

    recv 按阶段应答（回显 req id）：① connect 握手 res ② chat.send ack res
    ③ 预设 events ④ push 队列。events 与 push 都空时 recv 挂起在 asyncio.Queue（待 push 唤醒）。
    """

    def __init__(self, transport):
        self._t = transport
        self._extra = asyncio.Queue()

    async def send(self, data):
        self._t.sent.append(json.loads(data))

    async def recv(self):
        t = self._t
        connect = next((f for f in t.sent if f.get('method') == 'connect'), None)
        if connect is not None and not t._connect_acked and not t.suppress_connect_ack:
            t._connect_acked = True
            if t.connect_ok:
                return json.dumps({'type': 'res', 'id': connect['id'], 'ok': True,
                                   'payload': {'auth': {'deviceToken': 'dt-fake', 'role': 'operator',
                                                        'scopes': ['operator.read', 'operator.write',
                                                                   'operator.admin', 'operator.approvals']}}})
            return json.dumps({'type': 'res', 'id': connect['id'], 'ok': False,
                               'error': {'code': 'AUTH_FAILED', 'message': 'bad token'}})
        chat_sends = [f for f in t.sent if f.get('method') == 'chat.send']
        if not t.suppress_ack and len(chat_sends) > t._chat_ack_index:
            cs = chat_sends[t._chat_ack_index]
            t._chat_ack_index += 1
            if t.ack_error is not None:
                return json.dumps({'type': 'res', 'id': cs['id'], 'ok': False, 'error': t.ack_error})
            return json.dumps({'type': 'res', 'id': cs['id'], 'ok': True,
                               'payload': {'runId': t.ack_run_id}})
        resolves = [f for f in t.sent if f.get('method') == 'approval.resolve']
        if not t.suppress_ack and len(resolves) > t._resolve_ack_index:
            rs = resolves[t._resolve_ack_index]
            t._resolve_ack_index += 1
            if t.resolve_error is not None:
                return json.dumps({'type': 'res', 'id': rs['id'], 'ok': False, 'error': t.resolve_error})
            return json.dumps({'type': 'res', 'id': rs['id'], 'ok': True, 'payload': {}})
        if t.events:
            return json.dumps(t.events.pop(0))
        return json.dumps(await self._extra.get())

    async def close(self):
        self._t._closed = True


class FakeChatTransport:
    """对话长连接 fake transport（issue #41）：connect(url) → async CM 产 _FakeChatWs。

    构造参数：connect_ok / ack_run_id / ack_error / events（预设事件序列）。
    push(frame) 运行时追加事件（recv 挂起时唤醒）。sent 记录所有发送帧供断言。
    """

    def __init__(self, *, connect_ok=True, ack_run_id='r1', ack_error=None, events=None,
                 suppress_ack=False, suppress_connect_ack=False, resolve_error=None):
        self.connect_ok = connect_ok
        self.ack_run_id = ack_run_id
        self.ack_error = ack_error
        self.suppress_ack = suppress_ack
        self.suppress_connect_ack = suppress_connect_ack
        self.resolve_error = resolve_error
        self.events = list(events or [])
        self.sent: list = []
        self._connect_acked = False
        self._chat_ack_index = 0
        self._resolve_ack_index = 0
        self._closed = False
        self._ws: _FakeChatWs | None = None

    def __call__(self, url):
        self._ws = _FakeChatWs(self)
        return _CM(self._ws)

    def push(self, frame):
        if self._ws is not None:
            self._ws._extra.put_nowait(frame)
