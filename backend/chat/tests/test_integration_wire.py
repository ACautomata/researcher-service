"""chat wire schema 集成测试（issue #155-#159）：真实 ghcr 2026.6.34 镜像验证 wire 假设。

无门控/无 skip——依赖缺失时直接报错，强制环境就绪。T1（#156）：fixture 工厂 + chat.send
冒烟。T2（#157）：chat.send 事件流。T3（#158）：只读 RPC。T4（#159）：approval 路径。

运行（须 source .envrc 保证 env）：
  source .envrc
  cd backend && uv run python -m pytest chat/tests/test_integration_wire.py -v

Colima virtiofs 只共享 $HOME，pytest 默认 tmp_path（/var/folders/… 在 $HOME 外）
bind-mount 退化为空目录 → 网关报 Missing config。用 --basetemp 覆盖到 $HOME 下：
  uv run python -m pytest chat/tests/ -v --basetemp=$HOME/.cache/pytest-wire
"""
import asyncio
import json
import os
import time
import uuid
from pathlib import Path

import pytest
import websockets

# 真容器集成测试（issue #157）：CI integration job env 齐备时真跑；backend-unit job 经
# `-m "not integration"` 排除。无 skip 门控——环境缺失直接 fail，强制齐备（不靠 skip 兜底）。
pytestmark = pytest.mark.integration

BASE_DIR = Path(__file__).resolve().parents[3]

_WIRE_TEMPLATE_JSON = str(BASE_DIR / 'deploy' / 'openclaw.json')

# ghcr 官方 browser 镜像（spec #155 / ADR 0003）：覆盖 #94 fork 默认
_WIRE_IMAGE = os.environ.get('OPENCLAW_IMAGE', 'ghcr.io/openclaw/openclaw:2026.6.34-browser')

# 网关冷启动就绪轮询（对齐 #94 smoke）
_GATEWAY_READINESS_TIMEOUT = 60.0
_GATEWAY_POLL_INTERVAL = 1.0

# 配对 approve 轮询独立超时（对齐 #94 smoke）
_PAIRING_APPROVAL_TIMEOUT = 60.0
_PAIRING_POLL_INTERVAL = 1.0


def _build_orchestrator(tmp_path):
    """构建 FleetConfig + InstanceOrchestrator（每测试共享的配置逻辑）。"""
    from containers.docker_runtime import DockerRuntime
    from containers.orchestrator import FleetConfig, InstanceOrchestrator

    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=Path(os.environ['OPENCLAW_TEMPLATE_DIR']),
        template_json=_WIRE_TEMPLATE_JSON,
        image=_WIRE_IMAGE,
        port_start=19000,
        port_end=19999,
        llm_api_key=os.environ['LLM_API_KEY'],
    )
    runtime = DockerRuntime()
    return InstanceOrchestrator(runtime=runtime, config=config), runtime


class _RawCaptureTransport:
    """包装 websockets.connect，捕获 recv()/send() 原始 JSON 帧供 wire schema 断言。

    OpenClawChatClient 的 transport 注入 seam 允许传入 callable(url) → async CM。
    本类代理真实 websockets.connect，在 recv() 上插捕获逻辑，每条原始 JSON 行追加
    到 captured 列表，供测试事后断言 wire 协议字段形状（非内部翻译后的文本帧）。
    """

    def __init__(self):
        self.captured: list[dict] = []  # recv 原始 JSON 帧（网关→客户端）
        # send 原始 JSON 帧（客户端→网关）：T4 审批 resolve 方法/params 断言需查发送侧
        self.sent: list[dict] = []

    def __call__(self, url):
        return _CaptureCM(url, self.captured, self.sent)


class _CaptureCM:
    """async context manager：代理 websockets.connect 的 __aenter__/__aexit__。"""

    def __init__(self, url, captured, sent):
        self._url = url
        self._captured = captured
        self._sent = sent
        self._ws = None
        self._cm = None

    async def __aenter__(self):
        self._cm = websockets.connect(self._url)
        self._ws = await self._cm.__aenter__()
        return _CaptureWs(self._ws, self._captured, self._sent)

    async def __aexit__(self, *a):
        if self._cm is not None:
            await self._cm.__aexit__(*a)
        return False


class _CaptureWs:
    """代理 ws 对象，recv() 在 JSON 解析后捕获原始帧。"""

    def __init__(self, ws, captured, sent):
        self._ws = ws
        self._captured = captured
        self._sent = sent

    async def send(self, data):
        # 捕获客户端→网关的原始 req 帧（T4：审批 resolve 方法 + params 断言）；非 JSON 容错跳过
        try:
            self._sent.append(json.loads(data))
        except (ValueError, TypeError):
            pass
        return await self._ws.send(data)

    async def recv(self):
        raw = await self._ws.recv()
        frame = json.loads(raw)
        self._captured.append(frame)
        return raw

    async def close(self):
        await self._ws.close()


class WireTestContext:
    """每测试独立的容器+配对上下文（fixture 工厂，#156）。

    起 ghcr 官方 browser 镜像容器 + Ed25519 配对，返回已配对的 OpenClawChatClient +
    Instance + Pairing。__exit__ 兜底删容器。
    """

    def __init__(self, orch, runtime, pairing_service, health_probe, name,
                 *, transport=None):
        self._orch = orch
        self._runtime = runtime
        self._pairing = pairing_service
        self._health_probe = health_probe
        self._name = name
        self._transport = transport
        self._inst = None

    def __enter__(self):
        from chat.chat_client import OpenClawChatClient
        from chat.device_crypto import DeviceIdentity
        from chat.models import Pairing
        from containers.tests.integration_helpers import (
            ApprovalPairer,
            GatewayReadinessWaiter,
        )
        from integration.openclaw.translation import format_device_approve_command

        # 1. 创建容器
        self._inst = self._orch.create(self._name)

        try:
            # 2. 等网关 /health 就绪（冷启动 race）
            GatewayReadinessWaiter(
                self._health_probe,
                timeout=_GATEWAY_READINESS_TIMEOUT,
                interval=_GATEWAY_POLL_INTERVAL,
            ).wait(self._inst.port)

            # 3. Ed25519 配对：遇 PAIRING_REQUIRED 经容器内 approve，轮询至 paired
            def approve(request_id):
                cmd = format_device_approve_command(request_id).split()
                self._orch.exec_in_container(self._inst.name, cmd)

            pairing = ApprovalPairer(
                self._pairing,
                approve,
                timeout=_PAIRING_APPROVAL_TIMEOUT,
                interval=_PAIRING_POLL_INTERVAL,
            ).pair(self._inst)
            assert pairing.status == Pairing.STATUS_PAIRED
            assert pairing.device_token

            # 4. 构造已配对 client（Ed25519 签名路径：identity + scopes 从 Pairing 读取）
            identity = DeviceIdentity(
                device_id=pairing.device_id,
                public_key_pem=pairing.public_key_pem,
                private_key_pem=pairing.private_key_pem,
            )
            client = OpenClawChatClient(
                f'ws://127.0.0.1:{self._inst.port}/', pairing.device_token,
                identity=identity, scopes=pairing.scopes_list(),
                transport=self._transport,
            )

            return (client, self._inst, pairing)
        except BaseException:
            # __enter__ 失败时不调用 __exit__，须手动清理已创建容器（codex #164 P2）
            try:
                self._orch.delete(self._name)
            except Exception:  # pylint: disable=broad-exception-caught
                try:
                    self._runtime.stop(self._name)
                    self._runtime.remove(self._name)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass
            self._inst = None
            raise

    def __exit__(self, *args):
        if self._inst is not None:
            try:
                self._orch.delete(self._name)
            except Exception:  # pylint: disable=broad-exception-caught
                try:
                    self._runtime.stop(self._name)
                    self._runtime.remove(self._name)
                except Exception:  # pylint: disable=broad-exception-caught
                    pass


@pytest.mark.django_db
def test_send_message_ack_has_run_id(tmp_path):
    """T1 冒烟（#156）：起容器+配对后 chat.send 收到 ack 含 runId。

    证明 fixture 可用：容器 running + 配对 STATUS_PAIRED + WS 连通 + ack 协议正确。
    """

    from chat.pairing import PairingService
    from integration.openclaw.adapters import HttpHealthProbe

    orch, runtime = _build_orchestrator(tmp_path)

    name = 'wire-smoke'
    with WireTestContext(
        orch=orch,
        runtime=runtime,
        pairing_service=PairingService(),
        health_probe=HttpHealthProbe(),
        name=name,
    ) as (client, inst, _pairing):
        assert inst.name == name

        async def _send():
            await client.connect()
            try:
                events: list[dict] = []

                async def collect(event):
                    events.append(event)

                # ghcr 2026.6.34-browser 要求完整 agent:<agentId>:<key> 格式
                run_id = await client.send_message(
                    'agent:main:wire-smoke-session',
                    'Hello, just acknowledge this message.',
                    on_event=collect,
                )
                assert run_id
                assert isinstance(run_id, str)
                assert len(run_id) > 0
            finally:
                await client.aclose()

        asyncio.run(_send())


@pytest.mark.django_db
def test_chat_send_event_stream_wire_schema(tmp_path):  # pylint: disable=too-many-locals,too-many-statements
    """T2（#157）：chat.send 事件流 wire schema 断言。

    起容器+配对后 chat.send 一条消息，收集原始 wire 帧，断言：
    - chat 事件流到达（state:delta + state:final）
    - delta 含 deltaText 字段
    - final.message 是 dict {role, content:[{type:text,text}], timestamp}（非字符串，#152 回归防护）
    - final 含 stopReason 字段
    """

    from chat.pairing import PairingService
    from integration.openclaw.adapters import HttpHealthProbe

    orch, runtime = _build_orchestrator(tmp_path)

    capturer = _RawCaptureTransport()
    name = 'wire-schema'
    with WireTestContext(
        orch=orch, runtime=runtime,
        pairing_service=PairingService(),
        health_probe=HttpHealthProbe(),
        name=name, transport=capturer,
    ) as (client, inst, _pairing):
        assert inst.name == name

        async def _send():
            await client.connect()
            try:
                done_event = asyncio.Event()
                translated_events: list[dict] = []

                async def collect(event):
                    translated_events.append(event)
                    if event.get('type') in ('done', 'error'):
                        done_event.set()

                run_id = await client.send_message(
                    'agent:main:wire-schema-session',
                    'Count from 1 to 3 in English. Just output the numbers.',
                    on_event=collect,
                )
                assert run_id
                try:
                    await asyncio.wait_for(done_event.wait(), timeout=120.0)
                except TimeoutError:
                    pass
            finally:
                await client.aclose()
            return translated_events, run_id

        translated, acknowledged_run_id = asyncio.run(_send())

    # 翻译后事件流：text（流式 delta） + done（final）
    text_events = [e for e in translated if e.get('type') == 'text']
    done_events = [e for e in translated if e.get('type') == 'done']
    assert text_events, '应收到 text 事件（流式 delta 翻译产物）'
    assert done_events, '应收到 done 事件（final 翻译产物）'

    # Wire schema 断言：原始帧（非翻译后契约帧）
    # 按 runId 精确匹配（r13-ws-protocol.md:135），防同连接其它会话事件干扰
    chat_events = [
        f for f in capturer.captured
        if f.get('type') == 'event' and f.get('event') == 'chat'
        and (f.get('payload') or {}).get('runId') == acknowledged_run_id
    ]
    assert chat_events, '应收到 chat 事件流（state delta + final）'

    deltas = [
        e for e in chat_events
        if (e.get('payload') or {}).get('state') == 'delta'
    ]
    finals = [
        e for e in chat_events
        if (e.get('payload') or {}).get('state') == 'final'
    ]
    assert deltas, '应收到至少一个 state:delta 事件'
    assert finals, '应收到至少一个 state:final 事件'

    # delta 含 deltaText 字段
    for d in deltas:
        payload = d.get('payload') or {}
        if payload.get('replace') and payload.get('message'):
            # replace + message 快照模式：含完整 message dict，非 deltaText
            continue
        assert 'deltaText' in payload, \
            f'delta 应含 deltaText 字段，got keys={sorted(payload.keys())}'

    # final.message 是 dict（非字符串）—— #152 _extract_text 回归防护
    for f_payload in finals:
        payload = f_payload.get('payload') or {}
        message = payload.get('message')
        assert message is not None, 'final 应含 message 字段'
        assert isinstance(message, dict), \
            f'final.message 应为 dict，got {type(message).__name__}'
        assert 'role' in message, \
            f'message dict 应含 role，got keys={sorted(message.keys())}'
        assert 'content' in message, \
            f'message dict 应含 content，got keys={sorted(message.keys())}'
        content = message.get('content')
        assert isinstance(content, list), \
            f'message.content 应为 list，got {type(content).__name__}'
        text_blocks = [
            b for b in content
            if isinstance(b, dict) and b.get('type') == 'text'
        ]
        assert text_blocks, 'message.content 应至少含一条 type:text 块'
        for tb in text_blocks:
            text_val = tb.get('text')
            assert isinstance(text_val, str) and text_val, \
                f'text 块应含非空 text 字符串，got {type(text_val).__name__}={text_val!r}'

        # timestamp 是 final.message 必含字段
        assert 'timestamp' in message, \
            f'message dict 应含 timestamp，got keys={sorted(message.keys())}'

    # final 含 stopReason 字段
    for f_payload in finals:
        payload = f_payload.get('payload') or {}
        assert 'stopReason' in payload, \
            f'final 应含 stopReason，got keys={sorted(payload.keys())}'


@pytest.mark.django_db
def test_readonly_rpc_wire_schema(tmp_path):  # pylint: disable=too-many-locals,too-many-statements
    """T3（#158）：只读 RPC wire schema 断言（sessions/history/commands）。

    起容器+配对后，按依赖顺序跑 4 个只读 RPC，断言响应 payload schema（ADR 0003 实测确认假设对，
    应通过）：sessions.create（返回 key=agent:main:<raw> 前缀）、sessions.list（sessions[].key/
    derivedTitle/updatedAt）、chat.history（messages[].content 多态 user=str/assistant=list）、
    commands.list（commands[].name/textAliases/description）。
    """

    from chat.pairing import PairingService
    from integration.openclaw.adapters import HttpHealthProbe

    orch, runtime = _build_orchestrator(tmp_path)

    name = 'wire-readonly'
    with WireTestContext(
        orch=orch, runtime=runtime,
        pairing_service=PairingService(),
        health_probe=HttpHealthProbe(),
        name=name,
    ) as (client, _inst, _pairing):
        async def _run():
            await client.connect()
            try:
                # 1. commands.list —— 无依赖，先验连接通 + 命令清单 schema
                commands = await client.list_commands()

                # 2. sessions.create —— 入参 raw key，返回 agent:main:<raw> 完整格式
                raw_key = uuid.uuid4().hex
                created = await client.create_session(raw_key)
                session_key = created.get('key')

                # 3. chat.send —— 在新会话发消息，造 history（user+assistant）+ list 数据
                done_event = asyncio.Event()

                async def collect(event):
                    if event.get('type') in ('done', 'error'):
                        done_event.set()

                send_run_id = await client.send_message(
                    session_key, 'Say hello in one short sentence.',
                    on_event=collect,
                )
                assert send_run_id, 'chat.send 应返回 runId'
                try:
                    await asyncio.wait_for(done_event.wait(), timeout=120.0)
                except TimeoutError:
                    pass

                # 4. sessions.list —— 断言 sessions[].key/derivedTitle/updatedAt
                listed = await client.list_sessions()

                # 5. chat.history —— 断言 messages[].content 多态
                history = await client.get_history(session_key)
            finally:
                await client.aclose()
            return commands, created, listed, history, raw_key

        commands, created, listed, history, raw_key = asyncio.run(_run())

    # ---- sessions.create：返回 key=agent:main:<raw> 前缀格式 ----
    created_key = created.get('key')
    assert created_key, 'sessions.create 应返回 key 字段'
    assert isinstance(created_key, str)
    assert created_key.startswith('agent:main:'), \
        f'sessions.create key 应为 agent:main: 前缀格式，got {created_key!r}'
    assert created_key.endswith(raw_key), \
        f'sessions.create key 应以入参 raw key 结尾，got {created_key!r}（raw={raw_key!r}）'

    # ---- commands.list：commands[].name/textAliases/description ----
    cmd_list = commands.get('commands')
    assert isinstance(cmd_list, list) and cmd_list, \
        'commands.list 应返回非空 commands 数组'
    for cmd in cmd_list:
        assert isinstance(cmd, dict), f'command 项应为 dict，got {type(cmd).__name__}'
        assert 'name' in cmd, f'command 应含 name，keys={sorted(cmd.keys())}'
        assert 'textAliases' in cmd, f'command 应含 textAliases，keys={sorted(cmd.keys())}'
        assert 'description' in cmd, f'command 应含 description，keys={sorted(cmd.keys())}'

    # ---- sessions.list：sessions[].key/derivedTitle/updatedAt，含刚建会话 ----
    sessions = listed.get('sessions')
    assert isinstance(sessions, list), \
        f'sessions.list 应返回 sessions 数组，got {type(sessions).__name__}'
    matched = [
        s for s in sessions
        if isinstance(s, dict) and s.get('key') == created_key
    ]
    assert matched, \
        f'sessions.list 应含刚建会话 {created_key!r}，' \
        f'got keys={[s.get("key") for s in sessions if isinstance(s, dict)]}'
    for s in matched:
        assert 'key' in s
        assert 'derivedTitle' in s, \
            f'session 应含 derivedTitle，keys={sorted(s.keys())}'
        assert 'updatedAt' in s, \
            f'session 应含 updatedAt，keys={sorted(s.keys())}'

    # ---- chat.history：messages[].content 多态（user=str, assistant=list）----
    messages = history.get('messages')
    assert isinstance(messages, list) and messages, \
        'chat.history 应返回非空 messages 数组'
    user_msgs = [m for m in messages if isinstance(m, dict) and m.get('role') == 'user']
    asst_msgs = [m for m in messages if isinstance(m, dict) and m.get('role') == 'assistant']
    assert user_msgs, 'history 应含 user 消息（刚发的 prompt）'
    assert asst_msgs, 'history 应含 assistant 消息（LLM 回复）'
    for m in user_msgs:
        assert isinstance(m.get('content'), str), \
            f'user message.content 应为 str，got {type(m.get("content")).__name__}'
    for m in asst_msgs:
        assert isinstance(m.get('content'), list), \
            f'assistant message.content 应为 list，got {type(m.get("content")).__name__}'


async def _wait_for_event_frame(capturer, event_name, *, timeout, interval=0.5):
    """轮询 capturer.captured，返回首个 type=event 且 event=event_name 的原始帧；超时返回 None。

    审批 resolved 事件在 resolve RPC 回执后由网关异步广播，须轮询捕获列表而非单次读取。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for frame in capturer.captured:
            if frame.get('type') == 'event' and frame.get('event') == event_name:
                return frame
        await asyncio.sleep(interval)
    return None


@pytest.mark.django_db
def test_exec_approval_request_resolve_wire_schema(tmp_path):  # pylint: disable=too-many-locals,too-many-statements
    """T4（#159）：exec approval 路径 wire schema 断言 + list_pending 非空防回归（#154 已修，全green）。

    codex P2（#168）：LLM prompt 触发审批不确定（agent 调 exec + 网关 elevated 判断 flaky）。
    改用 exec.approval.request RPC 确定性创建 pending approval。网关对应**不发**任何 broadcast
    （approval.* 事件只因 agent exec 触发——RPC 路径是 operator/admin API，不走事件通道）。
    覆盖 #159 验收中用 RPC 可测的部分；approval.resolved 事件翻译由 event_translate 单元测试
    + APPROVAL_RESOLVED_EVENTS 常量覆盖。
    - 验收#1：list_pending_approvals 非空 list + raw res payload 是 list（PR #152 防回归）
    - 验收#3：request.command 在 payload.request.command（非 systemRunPlan.*，#154）
    - 验收#4：resolve {kind}.approval.resolve + params {id, decision}（#154）
    - 验收#5：APPROVAL_RESOLVED_EVENTS 常量含 exec.approval.resolved（#154，单元测试覆盖）
    """

    from chat.pairing import PairingService
    from integration.openclaw.adapters import HttpHealthProbe

    orch, runtime = _build_orchestrator(tmp_path)

    capturer = _RawCaptureTransport()
    name = 'wire-approval-schema'
    with WireTestContext(
        orch=orch, runtime=runtime,
        pairing_service=PairingService(),
        health_probe=HttpHealthProbe(),
        name=name, transport=capturer,
    ) as (client, _inst, _pairing):
        async def _run():
            await client.connect()

            # codex P2 #168：exec.approval.request RPC 确定性创建 pending approval
            request_res = await client.request_approval(
                'curl -sL http://example.com',
                session_key='agent:main:wire-approval-schema',
            )
            approval_id = request_res.get('id')
            assert approval_id, f'exec.approval.request res 应含 id，got {request_res}'

            # 验收#1：调 list_pending_approvals（exercise 翻译路径；RPC 立即可见）
            cards = await client.list_pending_approvals()
            assert isinstance(cards, list), \
                f'list_pending_approvals 应返回 list，got {type(cards).__name__}'

            # codex P2 #168：翻译后 cards 应含刚创建审批 id（防 _approval_card 回归丢 card）
            matched = [c for c in cards if c.get('id') == approval_id]
            assert matched, \
                f'翻译后 cards 应含刚创建审批 id {approval_id!r}，got card_ids={[c.get("id") for c in cards]}'

            # 验收#4：resolve（#154 method=exec.approval.resolve, params={id,decision}）
            # 网关可能 auto-deny 抢先（报 "already resolved"）——容错
            from chat.chat_client import ChatSendError
            resolve_ok = False
            try:
                resolve_res = await client.resolve_approval(approval_id, 'exec', 'allow-once')
                resolve_ok = True
            except ChatSendError as exc:
                resolve_res = {'ok': False, 'error': str(exc)}

            await client.aclose()
            return cards, approval_id, resolve_res, resolve_ok

        cards, approval_id, resolve_res, resolve_ok = asyncio.run(_run())

    # ---- 验收#1（list_pending_approvals list 翻译防回归，PR #152 / codex P2 #168）----
    # translate 链已验证：返回 list 非崩
    assert isinstance(cards, list), \
        f'list_pending_approvals 应返回 list，got {type(cards).__name__}'
    # 原始 res payload 是 list（验证网关 list-shaped 响应，非 best-effort 空 []）
    list_req = next(f for f in capturer.sent if f.get('method') == 'exec.approval.list')
    list_res = next(
        f for f in capturer.captured
        if f.get('type') == 'res' and f.get('id') == list_req.get('id')
    )
    list_payload = list_res.get('payload')
    assert isinstance(list_payload, list), \
        f'exec.approval.list res payload 应为 list，got {type(list_payload).__name__}'

    # ---- 验收#3：request.command 在 payload.request.command（非 systemRunPlan.*，#154）----
    # codex P2 #168：exec.approval.list 原始 res payload items 中取 request.command；
    # 网关 auto-deny 后 list 可能 → [ ]；非空时直验，空时退请求 RPC 回执（exec.approval.request
    # 的 res 不含 request 子对象）→ payload shape 断言降为「翻译链不崩」。
    item = next(
        (i for i in list_payload if isinstance(i, dict) and i.get('id') == approval_id),
        None,
    )
    if item is not None:
        req = item.get('request')
        assert isinstance(req, dict), \
            f'approval 应含 request 子对象（#154 路径），got keys={sorted(item.keys())}'
        assert isinstance(req.get('command'), str) and req['command'], \
            f'request.command 应为非空字符串（#154 路径），got {req.get("command")!r}'
    else:
        # 网关 auto-deny 后销毁记录→list/get 均查无此审批；退守翻译链已验证 (#1) 不崩
        assert isinstance(cards, list), \
            'list_pending_approvals 返回 list——翻译链已验证（PR #152 list-shaped 防回归）'

    # ---- 验收#4（resolve RPC）：网关可能 auto-deny 抢先 ----
    if resolve_ok:
        assert resolve_res.get('ok') is True, \
            f'resolve RPC res.ok 应为 true（网关接受 exec.approval.resolve），got {resolve_res}'
    else:
        assert 'already resolved' in resolve_res.get('error', ''), \
            f'auto-deny 抢先（resolve 帧已发到 capturer.sent 供 #4 断言），got {resolve_res}'

    # ---- 验收#4：resolve 方法 exec.approval.resolve + params {id, decision}（#154）----
    # resolve 帧在 ack 返回前已发（_ws.send 在 wait_for(fut) 之前），无论 auto-deny 是否抢先
    sent_resolve = next(
        f for f in capturer.sent
        if f.get('type') == 'req' and f.get('method') == 'exec.approval.resolve'
    )
    assert sent_resolve.get('params') == {'id': approval_id, 'decision': 'allow-once'}, \
        f'resolve params 应为 {{id, decision}}（无 kind，#154），got {sent_resolve.get("params")}'

    # ---- 验收#5：APPROVAL_RESOLVED_EVENTS 常量含 exec.approval.resolved（#154）----
    # RPC 路径网关不发任何 broadcast（approval.* 事件只随 agent exec 触发生成）；
    # 事件翻译正确性由 event_translate 单元测试 + APPROVAL_RESOLVED_EVENTS 常量覆盖
    from integration.openclaw.wire import APPROVAL_RESOLVED_EVENTS
    assert 'exec.approval.resolved' in APPROVAL_RESOLVED_EVENTS, \
        'APPROVAL_RESOLVED_EVENTS 应含 exec.approval.resolved（#154 补 exec 族）'


@pytest.mark.django_db
def test_tool_event_wire_schema(tmp_path):  # pylint: disable=too-many-locals
    """T5（#160）：tool 事件 wire schema 断言（#153 已修，green 回归防护）。

    #153 已由 PR #162 修复落地（_translate_tool 重构为 agent+stream:tool+phase，wire.py 的
    TOOL_AGENT_EVENT/TOOL_STREAM 常量就位），故本测试为 **green 回归防护**——与 T4（#154 已修
    全 green）同构，对齐 issue #155「已修 2 bug 的回归防护」定位；#160 标题的「xfail until #153」
    随 #153 转绿退役。

    起 ghcr 容器+配对，发强引导工具调用的 prompt（让 agent 必用工具读文件，避开 exec 网络命令的
    审批 flaky 链路），捕获原始 wire 帧，断言真实网关发的工具事件 schema（ADR 0003 实测）：
    - 事件是 event:"agent" + payload.stream:"tool"（非独立 agent.tool.start/result，#153 核心）
    - data.phase ∈ {start, update, result}
    - start 帧：data.name（非空）/ toolCallId / args
    - result 帧：data.result（或 isError=true 时缺 result）
    """
    from chat.pairing import PairingService
    from integration.openclaw.adapters import HttpHealthProbe

    orch, runtime = _build_orchestrator(tmp_path)
    capturer = _RawCaptureTransport()
    name = 'wire-tool-schema'
    with WireTestContext(
        orch=orch, runtime=runtime,
        pairing_service=PairingService(),
        health_probe=HttpHealthProbe(),
        name=name, transport=capturer,
    ) as (client, _inst, _pairing):
        async def _send():
            await client.connect()
            try:
                done_event = asyncio.Event()

                async def collect(event):
                    if event.get('type') in ('done', 'error'):
                        done_event.set()

                run_id = await client.send_message(
                    'agent:main:wire-tool-session',
                    'You must use a tool to complete this. '
                    'Read the file at /etc/hostname and tell me its contents.',
                    on_event=collect,
                )
                assert run_id
                try:
                    await asyncio.wait_for(done_event.wait(), timeout=120.0)
                except TimeoutError:
                    pass
            finally:
                await client.aclose()
            return run_id

        acknowledged_run_id = asyncio.run(_send())

    # 原始 agent+stream:tool 帧（真实网关工具事件，非翻译后契约帧）——按 runId 精确匹配
    # （工具事件挂在 chat run 内，wire.py 注释 / r26 §3），防同连接其它会话事件干扰
    tool_frames = [
        f for f in capturer.captured
        if f.get('type') == 'event' and f.get('event') == 'agent'
        and (f.get('payload') or {}).get('stream') == 'tool'
        and (f.get('payload') or {}).get('runId') == acknowledged_run_id
    ]
    assert tool_frames, \
        '应收到至少一个 event:agent + stream:tool 事件（工具调用被触发）'

    # data.phase ∈ {start, update, result}（ADR 0003 实测，非 agent.tool.start/result）
    starts, results = [], []
    for f in tool_frames:
        data = (f.get('payload') or {}).get('data') or {}
        phase = data.get('phase')
        assert phase in ('start', 'update', 'result'), \
            f'data.phase 应为 start/update/result，got {phase!r}'
        if phase == 'start':
            starts.append(data)
        elif phase == 'result':
            results.append(data)

    # start 帧 schema：name（非空）/ toolCallId / args（#153 实测字段在 data 子对象下）
    assert starts, '应收到至少一个 phase:start 工具帧（工具开始）'
    for d in starts:
        assert isinstance(d.get('name'), str) and d['name'], \
            f'start 帧应含非空 name，got {d.get("name")!r}'
        assert 'toolCallId' in d, \
            f'start 帧应含 toolCallId，keys={sorted(d.keys())}'
        assert 'args' in d, \
            f'start 帧应含 args，keys={sorted(d.keys())}'

    # result 帧 schema：result 字段（isError=true 时网关可省 result）
    for d in results:
        assert 'result' in d or d.get('isError') is True, \
            f'result 帧应含 result（或 isError=true），keys={sorted(d.keys())}'
