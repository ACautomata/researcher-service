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

    @classmethod
    def startup_pending(cls, message='gateway starting; retry shortly', **kwargs):
        """网关冷启动期 isStartupPending 分支：显式标 retryable 的瞬态恢复错误。

        对齐官方镜像 message-handler-*.js 的 errorShape（code=UNAVAILABLE, retryable:true,
        retryAfterMs:500）——调用方（ApprovalPairer）据此重试而非判定失败。
        """
        return cls(
            result_frame={'type': 'res', 'ok': False,
                          'error': {'code': 'UNAVAILABLE', 'message': message,
                                    'retryable': True, 'retryAfterMs': 500,
                                    'details': {'code': 'UNAVAILABLE'}}},
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

    **#217 恢复支持**：connect 恢复泵（client._run_until）在 connect res 后逐帧取恢复 RPC
    （sessions.subscribe / chat.history）的 res——通用 scripted RPC 分支按本连接（_sent_base 起）
    逐 method 应答；预设 events 须待恢复 RPC 全部 ack（泵退出交棒 recv-loop）后才弹，避免泵期
    误弹 events 首帧丢帧。泵用短超时轮询 recv（见 client），故无 send 侧唤醒。
    """

    def __init__(self, transport):
        self._t = transport
        self._extra = asyncio.Queue()

    async def send(self, data):
        # codex #220 P1：记录原始数据类型——websockets.send(str)→文本帧、send(bytes)→二进制帧。
        # 断言 chat.send 走文本帧（OpenClaw 协议全系 JSON 文本），防「为测大小误传 bytes 发二进制帧」回归。
        self._t.sent_types.append(type(data))
        self._t.sent.append(json.loads(data))

    async def recv(self):  # pylint: disable=too-many-return-statements,too-many-branches
        t = self._t
        # issue #140：脚本化 challenge 时，网关在 connect 前先下发 connect.challenge（payload.nonce），
        # client 提取 nonce 签名后才发 connect 帧。默认 None（不下发）→ 旧路径立即发帧。
        connect = next((f for f in t.sent[t._sent_base:] if f.get('method') == 'connect'), None)
        if connect is None and t.challenge_nonce is not None and not t._challenge_sent:
            t._challenge_sent = True
            return json.dumps({'type': 'event', 'event': 'connect.challenge',
                               'payload': {'nonce': t.challenge_nonce, 'ts': 1}})
        if connect is not None and not t._connect_acked and not t.suppress_connect_ack:
            t._connect_acked = True
            if t.connect_ok:
                # #213：hello-ok payload.policy（connect_policy 为 None 时不下发，测协议默认回退）。
                # 用三元 unpack 而非 if 语句，避免 recv 再增分支触发 too-many-branches。
                payload = {
                    'auth': {'deviceToken': 'dt-fake', 'role': 'operator',
                             'scopes': ['operator.read', 'operator.write',
                                        'operator.admin', 'operator.approvals']},
                    **({'policy': t.connect_policy} if t.connect_policy is not None else {}),
                }
                return json.dumps({'type': 'res', 'id': connect['id'], 'ok': True, 'payload': payload})
            return json.dumps({'type': 'res', 'id': connect['id'], 'ok': False,
                               'error': {'code': 'AUTH_FAILED', 'message': 'bad token'}})
        conn_frames = t.sent[t._sent_base:]  # 只应答本连接发出的帧（重连脚本边界，#217）
        chat_sends = [f for f in conn_frames if f.get('method') == 'chat.send']
        if not t.suppress_ack and len(chat_sends) > t._chat_ack_index:
            cs = chat_sends[t._chat_ack_index]
            t._chat_ack_index += 1
            if t.ack_error is not None:
                return json.dumps({'type': 'res', 'id': cs['id'], 'ok': False, 'error': t.ack_error})
            return json.dumps({'type': 'res', 'id': cs['id'], 'ok': True,
                               'payload': {'runId': t.ack_run_id}})
        resolves = [f for f in conn_frames if f.get('method', '').endswith('.approval.resolve')]
        if not t.suppress_ack and len(resolves) > t._resolve_ack_index:
            rs = resolves[t._resolve_ack_index]
            t._resolve_ack_index += 1
            if t.resolve_error is not None:
                return json.dumps({'type': 'res', 'id': rs['id'], 'ok': False, 'error': t.resolve_error})
            return json.dumps({'type': 'res', 'id': rs['id'], 'ok': True, 'payload': t.resolve_payload})
        lists = [f for f in conn_frames if f.get('method') == 'exec.approval.list']
        if not t.suppress_ack and len(lists) > t._list_ack_index:
            li = lists[t._list_ack_index]
            t._list_ack_index += 1
            return json.dumps({'type': 'res', 'id': li['id'], 'ok': True, 'payload': t.list_payload})
        cmds = [f for f in conn_frames if f.get('method') == 'commands.list']
        if not t.suppress_commands_ack and len(cmds) > t._commands_ack_index:
            cm = cmds[t._commands_ack_index]
            t._commands_ack_index += 1
            if t.commands_error is not None:
                return json.dumps({'type': 'res', 'id': cm['id'], 'ok': False, 'error': t.commands_error})
            return json.dumps({'type': 'res', 'id': cm['id'], 'ok': True, 'payload': t.commands_payload})
        # 通用 scripted RPC（issue #80 T1 / #217 sessions.subscribe+messages.subscribe）：遍历已注册
        # method，回显首个未 ack 的 req id。connect 泵逐帧取走每个待答 res。
        for method in set(t.rpc_payloads) | set(t.rpc_errors):
            if method in t.rpc_suppress:
                continue
            sent_for_method = [f for f in conn_frames if f.get('method') == method]
            idx = t._rpc_ack_index.get(method, 0)
            if len(sent_for_method) > idx:
                frame = sent_for_method[idx]
                t._rpc_ack_index[method] = idx + 1
                if method in t.rpc_errors:
                    return json.dumps({'type': 'res', 'id': frame['id'], 'ok': False, 'error': t.rpc_errors[method]})
                # codex #236 R4 P1：chat.history 支持按 sessionKey 区分 payload（多会话恢复各回各的
                # inFlightRun）。rpc_payloads_by_param[method][param_key]=payload——命中时用该 payload
                # （不 fallback 到 rpc_payloads 的默认值，保证每会话各自的历史/inFlightRun 归属）。
                key = frame.get('params', {}).get('sessionKey')
                param_payload = (t.rpc_payloads_by_param.get(method, {}) or {}).get(key)
                if param_payload is not None:
                    return json.dumps({'type': 'res', 'id': frame['id'], 'ok': True, 'payload': param_payload})
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
                 rpc_payloads_by_param=None,
                 challenge_nonce=_DEFAULT_CHALLENGE_NONCE, connect_policy=None):
        self.connect_ok = connect_ok
        self.ack_run_id = ack_run_id
        self.ack_error = ack_error
        self.suppress_ack = suppress_ack
        self.suppress_connect_ack = suppress_connect_ack
        # issue #140：脚本化 connect.challenge 的 nonce；None = 不下发（旧路径立即发帧）。
        self.challenge_nonce = challenge_nonce
        self._challenge_sent = False
        # #196 T1 / #213：hello-ok payload.policy 注入（None=不下发，测协议默认回退）。
        self.connect_policy = connect_policy
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
        self._connect_acked = False
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
        # codex #236 R4 P1：按请求参数区分的 RPC res（rpc_payloads_by_param[method][param_key]=payload）。
        # 目前仅 chat.history 用（按 sessionKey 区分各会话历史/inFlightRun）；对既有 rpc_payloads
        # 调用方零影响（该 dict 为空时走原默认路径）。
        self.rpc_payloads_by_param = dict(rpc_payloads_by_param or {})
        # #217 T4：connect() 现在发 sessions.subscribe（+有活跃会话时 sessions.messages.subscribe）
        # 并经 _rpc 等 res。给这两个方法默认 ok res（除非显式 suppress/error），否则握手会 ack 超时。
        self.rpc_payloads.setdefault('sessions.subscribe', {})
        self.rpc_payloads.setdefault('sessions.messages.subscribe', {})
        self._rpc_ack_index: dict[str, int] = {}
        self._closed = False
        self._ws: _FakeChatWs | None = None
        self._sent_base = 0  # 本连接帧在 sent 的起始下标（每连接 ack 边界，_reset_connection_state 重置）

    def _reset_connection_state(self) -> None:
        """每次新 connect 重置**每连接** ack/握手索引 + sent 基线（#217 T4 重连脚本支持）。

        重连恢复测试让同一 transport 出两个连接、各自握 + ack 各自的 RPC（subscribe / chat.history）。
        ack 索引若跨连接不清，第二连接的 recv 会把**第一连接**已 ack 的 chat.send/RPC 当成未 ack
        重新应答（t.sent 跨连接累积）。故记录 sent 基线：本连接只应答基线之后自己发出的帧。
        events / sent_types / challenge_nonce 不重置；sent 仍跨连接累积（断言脚本用）。
        """
        self._connect_acked = False
        self._challenge_sent = False
        self._chat_ack_index = 0
        self._resolve_ack_index = 0
        self._list_ack_index = 0
        self._commands_ack_index = 0
        self._rpc_ack_index = {}
        self._sent_base = len(self.sent)  # 本连接帧的起始下标（只 ack 这之后的）

    def __call__(self, url):
        self._reset_connection_state()
        self._ws = _FakeChatWs(self)
        return _CM(self._ws)

    def push(self, frame):
        if self._ws is not None:
            self._ws._extra.put_nowait(frame)
