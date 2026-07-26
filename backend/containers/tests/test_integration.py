"""integration: 真实 docker daemon 端到端 smoke —— issue #39 验收闭环。

默认 skip（CI 无 daemon / 无模板 / 无镜像）。手动验证 spec §5 真实链路：
  export RUN_INTEGRATION=1
  export OPENCLAW_TEMPLATE_DIR=/path/to/researcher   # git clone ACautomata/researcher
  export OPENCLAW_IMAGE=acautomata/openclaw-docker-cn-im:latest
  export LLM_API_KEY=sk-...
  uv run python -m pytest containers/tests/test_integration.py -v

覆盖：cp -a 预填充 home → 渲染 openclaw.json → docker run → list(running) → delete(连数据删)。
"""
import asyncio
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get('RUN_INTEGRATION'),
    reason='需真 docker daemon + researcher 模板 + 镜像；设 RUN_INTEGRATION=1 启用',
)

BASE_DIR = Path(__file__).resolve().parents[3]

# codex R8 F4：smoke 传给 create() 的模板来源。create() 用 Path(template_json).read_text()
# 读模板（orchestrator 惰性构造），故此处必须是**文件路径**，不能是 .read_text() 内容——
# 否则 Path(<json 文本>) 不存在，smoke 在触及 Docker 前即失败，无法验证真实 create/list/delete 链路。
_SMOKE_TEMPLATE_JSON = str(BASE_DIR / 'deploy' / 'openclaw.json')


@pytest.mark.django_db
def test_create_list_delete_real_container(tmp_path):
    pytest.importorskip('docker')
    from containers.docker_runtime import DockerRuntime
    from containers.orchestrator import FleetConfig, InstanceOrchestrator

    template_dir = os.environ.get('OPENCLAW_TEMPLATE_DIR')
    if not template_dir or not Path(template_dir).is_dir():
        pytest.skip('需 OPENCLAW_TEMPLATE_DIR 指向 researcher clone')
    image = os.environ.get('OPENCLAW_IMAGE', 'acautomata/openclaw-docker-cn-im:latest')
    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=Path(template_dir),
        template_json=_SMOKE_TEMPLATE_JSON,
        image=image,
        port_start=19000,
        port_end=19999,
        llm_api_key=os.environ.get('LLM_API_KEY', ''),
    )
    orch = InstanceOrchestrator(runtime=DockerRuntime(), config=config)

    from containers.orchestrator import InstanceCleanupError
    from containers.tests.integration_helpers import (
        dump_container_diagnostics,
        force_remove_tree,
    )

    inst = orch.create('smoke')
    try:
        try:
            items = {i['name']: i for i in orch.list()}
            assert inst.name in items
            assert items[inst.name]['status'] == 'running'
            assert items[inst.name]['port'] == inst.port
        except BaseException:
            # 失败自证根因（CI runner 上无从本地复现）：dump 容器 logs/inspect 供日志诊断
            print(dump_container_diagnostics('smoke'))
            raise
        try:
            assert orch.delete('smoke') is True
        except InstanceCleanupError:
            # CI 加固（issue #95）：容器以 0:0 运行在 bind-mount home 写 root 文件，runner 用户
            # rmtree EACCES——经 helper 容器以 root 强删后重试 delete（只清目录 + 删行）。
            print(dump_container_diagnostics('smoke'))
            force_remove_tree(tmp_path / 'fleet' / 'instances' / 'smoke')
            assert orch.delete('smoke') is True
    finally:
        # 兜底：确保容器/目录/行不残留（root 文件经 helper 强删）
        runtime = DockerRuntime()
        try:
            orch.delete('smoke')
        except Exception:  # pylint: disable=broad-exception-caught
            runtime.stop('smoke')
            runtime.remove('smoke')
            try:
                force_remove_tree(tmp_path / 'fleet' / 'instances' / 'smoke')
            except Exception:  # pylint: disable=broad-exception-caught
                pass

    # issue #39 验收：删除连数据删，instances/<name>/ 清除
    assert not (tmp_path / 'fleet' / 'instances' / 'smoke').exists()
    assert not __import__('containers.models', fromlist=['Instance']).Instance.objects.filter(
        name='smoke',
    ).exists()


# 配对 approve 轮询独立超时（issue #94：不等全程 pytest timeout）：approve 经容器内 exec
# detach=True fire-and-forget，网关侧生效需数秒；上限覆盖慢机/镜像冷启动，1s 轮询间隔。
_PAIRING_APPROVAL_TIMEOUT = 60.0
_PAIRING_POLL_INTERVAL = 1.0

# 网关冷启动就绪轮询（codex P2）：create() 在 docker start 后即返回，网关 WS server 仍需
# 数秒 boot；不等就绪直接配对会 connection refused → PairingError（ApprovalPairer 不重试），
# 链路在到达 approve 前即失败。上限覆盖慢机/镜像冷启动，1s 轮询间隔（与 approve 轮询对齐）。
_GATEWAY_READINESS_TIMEOUT = 60.0
_GATEWAY_POLL_INTERVAL = 1.0


@pytest.mark.django_db
def test_pair_chat_wiki_smoke_chain(tmp_path):  # pylint: disable=too-many-locals,too-many-statements
    """issue #94：创建→配对→chat→wiki→删除 全链路 smoke（RUN_INTEGRATION=1）。

    全程经控制面对象直调（InstanceOrchestrator/PairingService/OpenClawChatClient/WikiService），
    不走 HTTP、不 runserver。覆盖 spec §5/§8 真实链路：Ed25519 配对握手 + 容器内 approve 轮询
    取回 deviceToken、chat RPC 连通、wiki 直读 bind-mount + categories 聚合、删除连数据删。
    finally 兜底确保任何步骤失败均不残留容器。
    """
    pytest.importorskip('docker')
    from chat.chat_client import OpenClawChatClient
    from chat.models import Pairing
    from chat.pairing import PairingService
    from containers.docker_runtime import DockerRuntime
    from containers.models import Instance
    from containers.orchestrator import (
        FleetConfig,
        InstanceCleanupError,
        InstanceOrchestrator,
    )
    from containers.tests.integration_helpers import (
        ApprovalPairer,
        GatewayReadinessWaiter,
        dump_container_diagnostics,
        force_remove_tree,
    )
    from integration.openclaw.adapters import HttpHealthProbe
    from integration.openclaw.translation import format_device_approve_command
    from wiki.service import WikiService

    template_dir = os.environ.get('OPENCLAW_TEMPLATE_DIR')
    if not template_dir or not Path(template_dir).is_dir():
        pytest.skip('需 OPENCLAW_TEMPLATE_DIR 指向 researcher clone')
    image = os.environ.get('OPENCLAW_IMAGE', 'acautomata/openclaw-docker-cn-im:latest')
    config = FleetConfig(
        root=tmp_path / 'fleet',
        template_dir=Path(template_dir),
        template_json=_SMOKE_TEMPLATE_JSON,
        image=image,
        port_start=19000,
        port_end=19999,
        llm_api_key=os.environ.get('LLM_API_KEY', ''),
    )
    runtime = DockerRuntime()
    orch = InstanceOrchestrator(runtime=runtime, config=config)

    name = 'smoke-chain'
    inst = orch.create(name)
    try:
        # —— 1. 创建（issue #39 沿用）：running + 端口分配 + home 落盘 ——
        items = {i['name']: i for i in orch.list()}
        assert inst.name in items
        assert items[inst.name]['status'] == 'running'
        assert inst.port == items[inst.name]['port']
        home = Path(inst.home_dir)
        assert home.is_dir() and any(home.iterdir())      # cp -a 预填充 home 落盘

        # —— 2. 配对（spec §8.1）：先等网关 /health 就绪（冷启动 race，codex P2），再真 Ed25519
        #         握手；遇 PAIRING_REQUIRED 经容器内 approve，轮询 ensure_paired 至 paired
        #         （detach exec 不可同步等，须独立超时轮询）——
        try:
            GatewayReadinessWaiter(
                HttpHealthProbe(),
                timeout=_GATEWAY_READINESS_TIMEOUT,
                interval=_GATEWAY_POLL_INTERVAL,
            ).wait(inst.port)
        except BaseException:
            # 网关不就绪自证根因（CI runner 无从本地复现）：dump 容器 logs/inspect 供诊断
            print(dump_container_diagnostics(name))
            raise
        def approve(request_id):
            cmd = format_device_approve_command(request_id).split()
            orch.exec_in_container(inst.name, cmd)

        pairing = ApprovalPairer(
            PairingService(),
            approve,
            timeout=_PAIRING_APPROVAL_TIMEOUT,
            interval=_PAIRING_POLL_INTERVAL,
        ).pair(inst)
        assert pairing.status == Pairing.STATUS_PAIRED
        device_token = pairing.device_token
        assert device_token

        # —— 3. chat（spec #76）：经 client 建会话/拿历史，断言链路连通，不验内容质量 ——
        client = OpenClawChatClient(f'ws://127.0.0.1:{inst.port}/', device_token)
        session_key = f'smoke-{inst.name}-{inst.port}'

        async def chat_smoke():
            await client.connect()
            try:
                await client.create_session(session_key)   # 建会话不抛即连通
                sessions = await client.list_sessions()
                assert isinstance(sessions, dict)          # 网关响应到达
                history = await client.get_history(session_key)
                assert isinstance(history, dict)
            finally:
                await client.aclose()

        asyncio.run(chat_smoke())

        # —— 4. wiki（spec #75/#84）：直读 bind-mount；build_tree 非空 + categories 结构 ——
        # codex P2：pristine researcher clone 仅含 index.md 占位（build_tree 跳过 index.md，
        # 见 adapters._SKIP_FILES），tree['groups'] 恒空——先种子一页真实内容进 bind-mount，
        # 再断言 build_tree 浮现它，验证 wiki 直读链路（不依赖模板预填真实页）。
        seed_dir = home / 'wiki' / 'main' / 'concepts'
        seed_dir.mkdir(parents=True, exist_ok=True)
        (seed_dir / 'smoke-seed.md').write_text('# Smoke Seed\n\nissue #94 seed page.\n')
        wiki = WikiService(inst)
        tree = wiki.build_tree()
        assert tree['groups']                              # 种子页浮现 = 直读链路通
        categories = wiki.list_categories()
        assert isinstance(categories, dict)               # 开放词表，不要求非空
        for category, pages in categories.items():
            assert isinstance(category, str)
            assert isinstance(pages, list)
            for page in pages:
                assert {'path', 'title', 'category', 'excerpt'} <= set(page)

        # —— 5. 删除连数据删（issue #39）：instances/<name>/ 清除 + Instance 行清除 ——
        try:
            assert orch.delete(name) is True
        except InstanceCleanupError:
            # CI 加固（issue #95）：容器 0:0 写在 bind-mount home 的 root 文件，runner 用户 rmtree
            # EACCES——经 helper 容器以 root 强删后重试 delete（只清目录 + 删行）。
            print(dump_container_diagnostics(name))
            force_remove_tree(tmp_path / 'fleet' / 'instances' / name)
            assert orch.delete(name) is True
        assert not (tmp_path / 'fleet' / 'instances' / name).exists()
        assert not Instance.objects.filter(name=name).exists()
    finally:
        # 兜底：任一步骤失败时确保容器/目录/行不残留（root 文件经 helper 强删）
        try:
            orch.delete(name)
        except Exception:  # pylint: disable=broad-exception-caught
            runtime.stop(name)
            runtime.remove(name)
            try:
                force_remove_tree(tmp_path / 'fleet' / 'instances' / name)
            except Exception:  # pylint: disable=broad-exception-caught
                pass
