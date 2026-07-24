"""chat 测试替身：FakeTransport（配对握手 TDD 用）。

构造三种网关应答脚本（hello-ok / PAIRING_REQUIRED / 连接错误），
记录 connect 调用次数（验证幂等不重握手）。支持：
- 回显 connect 请求 id（hello-ok res 的 id = 实际 connect req id，对齐协议 req/res 关联）。
- 注入乱序帧（challenge 前/ connect res 前的无关 event/stray res），验证握手容错。
无需真容器/真网关。
"""
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
    @classmethod
    def hello_ok(cls, scopes=None, device_token='dt-fake', **kwargs):
        return cls(
            result_frame={'type': 'res', 'ok': True,
                          'payload': {'auth': {'deviceToken': device_token, 'role': 'operator',
                                               'scopes': scopes or ['operator.read']}}},
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
