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
                 'payload': {'nonce': 'nz', 'ts': 1}},
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
                 error: Exception | None = None, result_frames=None):
        # result_frames：序列模式——每次 connect 按序取一帧（最后帧复用于超额调用）。
        # 单 result_frame 时退化为「每次同帧」（向后兼容既有构造器与脚本）。
        self._result_frames = result_frames
        self._result_frame = result_frame
        self._pre_challenge = pre_challenge_frames or []
        self._pre_result = pre_result_frames or []
        self._error = error
        self.connect_calls = 0

    # ---- 脚本构造器 ----
    # 默认返回验收所需的完整 operator scopes；测试可覆盖为部分/空以验证拒绝逻辑。
    _DEFAULT_SCOPES = ('operator.read', 'operator.write', 'operator.admin', 'operator.approvals')

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
    def sequence(cls, frames, **kwargs):
        """序列模式：每次 connect 按序产出 frames[i]（超额复用最后一帧）。

        供「同一次 ensure_paired 内两次握手」测试——如自动 approve：第 1 次 PAIRING_REQUIRED、
        approve 后第 2 次 hello-ok。frames 为完整 result 帧 dict 列表。
        """
        return cls(result_frame=frames[-1], result_frames=list(frames), **kwargs)

    @classmethod
    def connect_error(cls, message='connect failed', **kwargs):
        return cls(
            result_frame={'type': 'res', 'ok': False,
                          'error': {'code': 'AUTH_FAILED', 'message': message}},
            **kwargs,
        )

    def _current_frame(self):
        if self._result_frames:
            idx = min(self.connect_calls - 1, len(self._result_frames) - 1)
            return self._result_frames[idx]
        return self._result_frame

    # ---- transport 协议 ----
    def __call__(self, url):
        self.connect_calls += 1
        if self._error is not None:
            raise self._error
        return _CM(_FakeWs(self._pre_challenge, self._current_frame(), self._pre_result))


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
        # 本连接收到的 connect 帧 + 本连接的 challenge/connect-ack 下发标志（非全局 t.sent /
        # transport 级标志——那些跨连接累积，重试同一 client 时会误判旧连接状态为本连接的，
        # 跳过 challenge/ack 分支致握手超时）。issue #222 reentrant：每连接（_FakeChatWs 实例）独立。
        self._my_connect = None
        self._challenge_sent = False
        self._connect_acked = False

    async def send(self, data):
        # codex #220 P1：记录原始数据类型——websockets.send(str)→文本帧、send(bytes)→二进制帧。
        # 断言 chat.send 走文本帧（OpenClaw 协议全系 JSON 文本），防「为测大小误传 bytes 发二进制帧」回归。
        self._t.sent_types.append(type(data))
        frame = json.loads(data)
        self._t.sent.append(frame)
        if frame.get('method') == 'connect' and self._my_connect is None:
            self._my_connect = frame

    async def recv(self):  # pylint: disable=too-many-return-statements
        t = self._t
        # issue #140：脚本化 challenge 时，网关在 connect 前先下发 connect.challenge（payload.nonce），
        # client 提取 nonce 签名后才发 connect 帧。默认 None（不下发）→ 旧路径立即发帧。
        # connect 判定用本连接的 _my_connect（非全局 t.sent，见 __init__ 注释）。
        connect = self._my_connect
        if connect is None and t.challenge_nonce is not None and not self._challenge_sent:
            self._challenge_sent = True
            return json.dumps({'type': 'event', 'event': 'connect.challenge',
                               'payload': {'nonce': t.challenge_nonce, 'ts': 1}})
        if connect is not None and not self._connect_acked and not t.suppress_connect_ack:
            self._connect_acked = True
            if t.connect_ok:
                # #213：hello-ok payload.policy（connect_policy 为 None 时不下发，测协议默认回退）。
                # #222：connect_auth 覆盖 hello-ok payload.auth（测 deviceToken 轮换 / scopes 收窄）；
                # 缺省下发全量 4-scope（含 operator.admin，对齐 REQUIRED_SCOPES）。
                auth = t.connect_auth or {
                    'deviceToken': 'dt-fake', 'role': 'operator',
                    'scopes': ['operator.read', 'operator.write',
                               'operator.admin', 'operator.approvals'],
                }
                payload = {
                    'auth': auth,
                    **({'policy': t.connect_policy} if t.connect_policy is not None else {}),
                }
                return json.dumps({'type': 'res', 'id': connect['id'], 'ok': True, 'payload': payload})
            # #222：connect_error 脚本化结构化错误（code/details），供按码分流测试；
            # 缺省回退旧 AUTH_FAILED 文案（向后兼容既有 connect_ok=False 用法）。
            error = t.connect_error or {'code': 'AUTH_FAILED', 'message': 'bad token'}
            return json.dumps({'type': 'res', 'id': connect['id'], 'ok': False, 'error': error})
        chat_sends = [f for f in t.sent if f.get('method') == 'chat.send']
        if not t.suppress_ack and len(chat_sends) > t._chat_ack_index:
            cs = chat_sends[t._chat_ack_index]
            t._chat_ack_index += 1
            if t.ack_error is not None:
                return json.dumps({'type': 'res', 'id': cs['id'], 'ok': False, 'error': t.ack_error})
            return json.dumps({'type': 'res', 'id': cs['id'], 'ok': True,
                               'payload': {'runId': t.ack_run_id}})
        resolves = [f for f in t.sent if f.get('method', '').endswith('.approval.resolve')]
        if not t.suppress_ack and len(resolves) > t._resolve_ack_index:
            rs = resolves[t._resolve_ack_index]
            t._resolve_ack_index += 1
            if t.resolve_error is not None:
                return json.dumps({'type': 'res', 'id': rs['id'], 'ok': False, 'error': t.resolve_error})
            return json.dumps({'type': 'res', 'id': rs['id'], 'ok': True, 'payload': t.resolve_payload})
        lists = [f for f in t.sent if f.get('method') == 'exec.approval.list']
        if not t.suppress_ack and len(lists) > t._list_ack_index:
            li = lists[t._list_ack_index]
            t._list_ack_index += 1
            return json.dumps({'type': 'res', 'id': li['id'], 'ok': True, 'payload': t.list_payload})
        cmds = [f for f in t.sent if f.get('method') == 'commands.list']
        if not t.suppress_commands_ack and len(cmds) > t._commands_ack_index:
            cm = cmds[t._commands_ack_index]
            t._commands_ack_index += 1
            if t.commands_error is not None:
                return json.dumps({'type': 'res', 'id': cm['id'], 'ok': False, 'error': t.commands_error})
            return json.dumps({'type': 'res', 'id': cm['id'], 'ok': True, 'payload': t.commands_payload})
        # 通用 scripted RPC（issue #80 T1）：遍历已注册 method，回显首个未 ack 的 req id。
        for method in set(t.rpc_payloads) | set(t.rpc_errors):
            if method in t.rpc_suppress:
                continue
            sent_for_method = [f for f in t.sent if f.get('method') == method]
            idx = t._rpc_ack_index.get(method, 0)
            if len(sent_for_method) > idx:
                frame = sent_for_method[idx]
                t._rpc_ack_index[method] = idx + 1
                if method in t.rpc_errors:
                    return json.dumps({'type': 'res', 'id': frame['id'], 'ok': False, 'error': t.rpc_errors[method]})
                return json.dumps({'type': 'res', 'id': frame['id'], 'ok': True, 'payload': t.rpc_payloads.get(method, {})})
        if t.events:
            return json.dumps(t.events.pop(0))
        return json.dumps(await self._extra.get())

    async def close(self, *args, **kwargs):
        self._t._closed = True
        # #213：记录 close code（看门狗按契约 4000）；无参 close（aclose）为 None。
        self._t._close_code = args[0] if args else kwargs.get('code')


class FakeChatTransport:  # pylint: disable=too-many-instance-attributes  # pylint: disable=too-many-instance-attributes
    """对话长连接 fake transport（issue #41）：connect(url) → async CM 产 _FakeChatWs。

    构造参数：connect_ok / ack_run_id / ack_error / events（预设事件序列）。
    push(frame) 运行时追加事件（recv 挂起时唤醒）。sent 记录所有发送帧供断言。
    """

    # 默认下发 connect.challenge（issue #140：签名路径 client 先等 challenge 提取 nonce）；
    # 显式传 challenge_nonce=None 关闭（旧路径/不签名 client 用，网关不下发、client 立即发帧）。
    _DEFAULT_CHALLENGE_NONCE = 'nz-fake'

    def __init__(self, *, connect_ok=True, ack_run_id='r1', ack_error=None, events=None,  # pylint: disable=too-many-arguments
                 suppress_ack=False, suppress_connect_ack=False, resolve_error=None, resolve_payload=None,
                 list_payload=None, commands_payload=None, commands_error=None,
                 suppress_commands_ack=False,
                 rpc_payloads=None, rpc_errors=None, rpc_suppress=None,
                 challenge_nonce=_DEFAULT_CHALLENGE_NONCE, connect_policy=None,
                 connect_error=None, connect_auth=None):
        self.connect_ok = connect_ok
        self.ack_run_id = ack_run_id
        self.ack_error = ack_error
        self.suppress_ack = suppress_ack
        self.suppress_connect_ack = suppress_connect_ack
        # issue #140：脚本化 connect.challenge 的 nonce；None = 不下发（旧路径立即发帧）。
        # challenge/connect-ack 下发标志在每连接 _FakeChatWs 实例上（非本 transport 级），见 _FakeChatWs。
        self.challenge_nonce = challenge_nonce
        # #196 T1 / #213：hello-ok payload.policy 注入（None=不下发，测协议默认回退）。
        self.connect_policy = connect_policy
        # #222：connect res 结构化错误（error.code/details，connect_ok=False 时下发；
        # None=回退旧 AUTH_FAILED 文案）；hello-ok payload.auth 覆盖（None=默认全量 4-scope + dt-fake）。
        self.connect_error = connect_error
        self.connect_auth = connect_auth
        # #213：_FakeChatWs.close 记录的 close code（看门狗按契约 4000 关闭）；无参 close（aclose）为 None。
        self._close_code = None
        self.resolve_error = resolve_error
        self.resolve_payload = resolve_payload if resolve_payload is not None else {}
        self.list_payload = list_payload if list_payload is not None else {}
        self.commands_payload = commands_payload if commands_payload is not None else {}
        self.commands_error = commands_error
        self.suppress_commands_ack = suppress_commands_ack
        self.events = list(events or [])
        self.sent: list = []
        # codex #220 P1：与 sent 平行的原始发送数据类型（str=文本帧 / bytes=二进制帧），供 opcode 断言。
        self.sent_types: list = []
        self._chat_ack_index = 0
        self._resolve_ack_index = 0
        self._list_ack_index = 0
        self._commands_ack_index = 0
        # 通用 scripted RPC res（issue #80 T1）：sessions.list / chat.history / sessions.create /
        # sessions.delete 等任意 method 的 req→res 脚本。rpc_payloads[method]=res payload、
        # rpc_errors[method]=res error、rpc_suppress 含 method 则不回 res（测 ack timeout）。逐方法
        # 按已发 req 顺序消费（_rpc_ack_index[method]），与上面 per-method 分发同构。
        self.rpc_payloads = dict(rpc_payloads or {})
        self.rpc_errors = dict(rpc_errors or {})
        self.rpc_suppress = set(rpc_suppress or ())
        self._rpc_ack_index: dict[str, int] = {}
        self._closed = False
        self._ws: _FakeChatWs | None = None

    def __call__(self, url):
        # 每次新连接产新 _FakeChatWs（其 challenge/connect-ack 标志在实例上，随新连接自动复位）；
        # 真实网关对新 WS 重新 challenge + connect res，支撑 #222 pool 重试同一 client 重走完整握手。
        self._ws = _FakeChatWs(self)
        return _CM(self._ws)

    def push(self, frame):
        if self._ws is not None:
            self._ws._extra.put_nowait(frame)
