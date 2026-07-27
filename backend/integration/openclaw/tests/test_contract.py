"""防腐层集成包契约测试（issue #98 / spec #97 / ADR 0002）。

沿用 #90 同源断言范式：断言 wire 域常量在集成包单一来源（chat 三处与
integration.openclaw.wire 同对象）、集成包暴露 4 Port、集成包不重复定义容器/编排域常量。

只断言**契约**（单一来源 / 依赖方向），不断言「哪个常量搬到哪」——那是测实现细节。
"""
import inspect

import pytest

from chat import chat_client, event_translate, pairing_ws
from integration.openclaw import wire


def _fake_identity():
    """Generate a DeviceIdentity for contract tests that need one."""
    from chat.device_crypto import DeviceCrypto
    return DeviceCrypto.generate_identity()


# issue #139 session device 块：长连握手测试注入用的共享假值（identity/nonce/已批准 scopes）。
_SESSION_IDENTITY = _fake_identity()
_SESSION_NONCE = 'nz-contract'
_SESSION_SCOPES = ['operator.read', 'operator.write', 'operator.approvals']


class TestWireConstantsSingleSource:
    """wire 域常量单一来源：chat 三处与 integration.openclaw.wire 同对象（#90 范式）。"""

    def test_protocol_is_single_sourced(self):
        # chat_client 经 ConnectFrameBuilder.session() 消费 PROTOCOL（间接单源）
        # pairing_ws 经 ConnectFrameBuilder.pairing() 消费 PROTOCOL（间接单源）
        assert chat_client._ConnectFrameBuilder is wire.ConnectFrameBuilder
        assert pairing_ws._ConnectFrameBuilder is wire.ConnectFrameBuilder

    def test_scopes_is_single_sourced(self):
        # chat_client/pairing_ws 不再直接 import SCOPES —— 由 ConnectFrameBuilder 单源消费。
        # pairing 仍单源 wire.SCOPES；session（#139）的 scopes 改由调用端传入（配对时已批准 scopes）。
        pairwise_frame = wire.ConnectFrameBuilder.pairing(
            req_id='r', identity=_fake_identity(), token='t', nonce='n',
        )
        approved = ['operator.read', 'operator.write']
        session_frame = wire.ConnectFrameBuilder.session(
            req_id='r', identity=_fake_identity(), device_token='dt', nonce='n', scopes=approved,
        )
        assert pairwise_frame['params']['scopes'] == wire.SCOPES
        assert session_frame['params']['scopes'] == approved

    def test_caps_is_single_sourced(self):
        # chat_client/pairing_ws 不再直接 import CAPS —— 由 ConnectFrameBuilder 单源消费
        pairwise_frame = wire.ConnectFrameBuilder.pairing(
            req_id='r', identity=_fake_identity(), token='t', nonce='n',
        )
        session_frame = wire.ConnectFrameBuilder.session(
            req_id='r', identity=_fake_identity(), device_token='dt', nonce='n',
            scopes=['operator.read'],
        )
        assert pairwise_frame['params']['caps'] == wire.CAPS
        assert session_frame['params']['caps'] == wire.CAPS

    def test_client_id_is_single_sourced(self):
        # chat_client/pairing_ws 不再直接 import CLIENT_ID —— 由 ConnectFrameBuilder 单源消费
        pairwise_frame = wire.ConnectFrameBuilder.pairing(
            req_id='r', identity=_fake_identity(), token='t', nonce='n',
        )
        session_frame = wire.ConnectFrameBuilder.session(
            req_id='r', identity=_fake_identity(), device_token='dt', nonce='n',
            scopes=['operator.read'],
        )
        assert pairwise_frame['params']['client']['id'] == wire.CLIENT_ID
        assert session_frame['params']['client']['id'] == wire.CLIENT_ID

    def test_agent_id_is_single_sourced(self):
        assert chat_client._AGENT_ID is wire.AGENT_ID

    def test_connect_frame_fields_single_sourced(self):
        # pairing_ws 不再直接 import CLIENT_MODE/ROLE —— 由 ConnectFrameBuilder 单源消费
        frame = wire.ConnectFrameBuilder.pairing(
            req_id='r', identity=_fake_identity(), token='t', nonce='n',
        )
        assert frame['params']['client']['mode'] == wire.CLIENT_MODE
        assert frame['params']['role'] == wire.ROLE

    def test_required_scopes_single_sourced(self):
        # pairing_ws 只在 await_connect_res 消费 REQUIRED_SCOPES（经 import alias）
        assert pairing_ws._REQUIRED_SCOPES is wire.REQUIRED_SCOPES

    def test_event_families_single_sourced(self):
        assert event_translate._APPROVAL_REQUESTED_EVENTS is wire.APPROVAL_REQUESTED_EVENTS
        assert event_translate._APPROVAL_RESOLVED_EVENTS is wire.APPROVAL_RESOLVED_EVENTS
        assert event_translate._TOOL_AGENT_EVENT is wire.TOOL_AGENT_EVENT
        assert event_translate._TOOL_STREAM is wire.TOOL_STREAM


class TestIntegrationExposesFourPorts:
    """集成包暴露 4 Port（Protocol 形态）—— issue #98 acceptance「集成包建立，含 4 Port 接口」。"""

    EXPECTED_PORTS = ('ContainerRuntime', 'OpenClawWire', 'WikiFileSystem', 'HealthProbe')

    def test_four_ports_defined_as_protocols(self):
        from integration.openclaw import ports

        for name in self.EXPECTED_PORTS:
            port = getattr(ports, name, None)
            assert port is not None, f'集成包缺 Port: {name}'
            assert getattr(port, '_is_protocol', False), f'{name} 应为 typing.Protocol'

    def test_four_ports_exported_from_package(self):
        import integration.openclaw as pkg

        for name in self.EXPECTED_PORTS:
            assert hasattr(pkg, name), f'{name} 未从 integration.openclaw 导出'


class TestIntegrationProvidesFakes:
    """每 Port 一个可注入 fake 骨架（issue #98 acceptance「每 Port 一个可注入 fake」）。"""

    def test_fake_container_runtime_satisfies_port(self):
        from integration.openclaw import ContainerRuntime
        from integration.openclaw.fakes import FakeContainerRuntime

        assert isinstance(FakeContainerRuntime(), ContainerRuntime)

    def test_fake_openclaw_wire_satisfies_port(self):
        from integration.openclaw import OpenClawWire
        from integration.openclaw.fakes import FakeOpenClawWire

        assert isinstance(FakeOpenClawWire(), OpenClawWire)

    def test_fake_wiki_filesystem_satisfies_port(self):
        from integration.openclaw import WikiFileSystem
        from integration.openclaw.fakes import FakeWikiFileSystem

        assert isinstance(FakeWikiFileSystem(), WikiFileSystem)

    def test_fake_health_probe_satisfies_port(self):
        from integration.openclaw import HealthProbe
        from integration.openclaw.fakes import FakeHealthProbe

        assert isinstance(FakeHealthProbe(), HealthProbe)


class TestAdaptersSatisfyPorts:
    """真实 Adapter 实现 Port（issue #99 acceptance「Path3 health 探测收口」）。"""

    def test_http_health_probe_satisfies_port(self):
        """issue #99：HttpHealthProbe 实现 HealthProbe Port（构造注入 http client 不变）。"""
        from integration.openclaw import HealthProbe
        from integration.openclaw.adapters import HttpHealthProbe

        assert isinstance(HttpHealthProbe(), HealthProbe)

    def test_http_health_probe_uses_http_get_on_localhost(self, monkeypatch):
        """issue #99 acceptance：HttpHealthProbe.is_reachable 发 HTTP GET 127.0.0.1:<port>/health。"""
        import io
        import urllib.request

        from integration.openclaw.adapters import HttpHealthProbe

        class _FakeResp(io.BytesIO):
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        resp = _FakeResp(b'{"status":"ok"}')
        monkeypatch.setattr(urllib.request, 'urlopen', lambda url, timeout: resp)
        probe = HttpHealthProbe(timeout=2.0)
        assert probe.is_reachable(19000) is True

    def test_http_health_probe_connection_refused_is_false(self, monkeypatch):
        """不可达返回 False（不抛异常）。"""
        import urllib.error
        import urllib.request

        from integration.openclaw.adapters import HttpHealthProbe

        def _boom(*a, **k):
            raise urllib.error.URLError('connection refused')

        monkeypatch.setattr(urllib.request, 'urlopen', _boom)
        assert HttpHealthProbe().is_reachable(19000) is False


class TestWikiFileSystemAdapterContract:
    """issue #100：BindMountWikiFileSystem 实现 WikiFileSystem Port + 路径约定/越权防护。

    契约级别——只测 Adapter 通过 Port 的行为。不做 API 层 HTTP 编码。
    """

    @staticmethod
    def _make_wiki_root(tmp_path):
        """准备 wiki/main 骨架：若干真实子目录（含五分类之外的未知目录）+ 私有目录/占位文件。"""
        from pathlib import Path

        root = Path(tmp_path) / 'wiki' / 'main'
        (root / 'concepts').mkdir(parents=True)
        (root / 'concepts' / 'attention.md').write_text(
            '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n',
            encoding='utf-8',
        )
        papers = root / 'domains' / 'cv' / 'papers'
        papers.mkdir(parents=True)
        (papers / 'resnet.md').write_text(
            '---\npaper:\n  title: ResNet\nrelated_pages: [attention]\n---\n# ResNet\n',
            encoding='utf-8',
        )
        # 五分类之外的未知目录（issue #83 物理化）：照实成组
        (root / 'experiments').mkdir(parents=True)
        (root / 'experiments' / 'trial-1.md').write_text(
            '---\ntitle: Trial 1\n---\n# Trial 1\n',
            encoding='utf-8',
        )
        (root / '.openclaw-wiki').mkdir()
        (root / '.openclaw-wiki' / 'cache.md').write_text('x', encoding='utf-8')
        (root / 'index.md').write_text('# INDEX', encoding='utf-8')
        return root

    # —— Port compliance ——

    def test_adapter_satisfies_port(self):
        from integration.openclaw import WikiFileSystem
        from integration.openclaw.adapters import BindMountWikiFileSystem

        assert isinstance(BindMountWikiFileSystem('/tmp'), WikiFileSystem)

    # —— build_tree ——

    def test_build_tree_mirrors_real_subdirs(self, tmp_path):
        """issue #83：分组 = 根目录真实子目录（开放词表），不写死五分类；未知目录也成组。"""
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        kinds = {g['kind'] for g in tree['groups']}
        assert {'concepts', 'domains', 'experiments'} <= kinds

    def test_build_tree_no_five_category_assumption(self, tmp_path):
        """五分类单数键（concept/entity/…）已废；物理不存在的目录不成组。"""
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        kinds = {g['kind'] for g in tree['groups']}
        assert 'concept' not in kinds
        assert 'entity' not in kinds
        # fixture 中物理不存在 syntheses/reports → 不成组
        assert 'syntheses' not in kinds
        assert 'reports' not in kinds

    def test_build_tree_lists_pages(self, tmp_path):
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        concepts = next(g for g in tree['groups'] if g['kind'] == 'concepts')
        paths = {p['path'] for p in concepts.get('pages', [])}
        assert 'concepts/attention.md' in paths

    def test_build_tree_unknown_dir_grouped(self, tmp_path):
        """未知目录照实成组（kind=name=目录名）。"""
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        experiments = next(g for g in tree['groups'] if g['kind'] == 'experiments')
        assert experiments['name'] == 'experiments'
        paths = {p['path'] for p in experiments.get('pages', [])}
        assert paths == {'experiments/trial-1.md'}

    def test_build_tree_skips_managed_dirs_and_files(self, tmp_path):
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        all_paths = {p['path'] for g in tree['groups'] for p in g.get('pages', [])}
        assert not any('.openclaw-wiki' in p for p in all_paths)
        assert 'index.md' not in all_paths
        # 插件私有目录本身也不成组
        assert '.openclaw-wiki' not in {g['kind'] for g in tree['groups']}

    # —— read_page ——

    def test_read_page_returns_content_and_title(self, tmp_path):
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        page = fs.read_page('concepts/attention.md')
        assert page['path'] == 'concepts/attention.md'
        assert page['title'] == 'Attention'
        assert '# Attention' in page['content']

    def test_read_page_missing_raises(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(FileNotFoundError):
            fs.read_page('concepts/nope.md')

    # —— write_page ——

    def test_write_page_overwrites_existing(self, tmp_path):
        from pathlib import Path

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        result = fs.write_page('concepts/attention.md', '# 已编辑\n')
        assert result == {'path': 'concepts/attention.md'}
        saved = (Path(root) / 'concepts' / 'attention.md').read_text(encoding='utf-8')
        assert saved == '# 已编辑\n'

    def test_write_page_missing_raises(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(FileNotFoundError):
            fs.write_page('concepts/nope.md', 'x')

    # —— create_page ——

    def test_create_page_writes(self, tmp_path):
        from pathlib import Path

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        result = fs.create_page('concepts/transformer.md', '---\ntitle: T\n---\n# T\n')
        assert result == {'path': 'concepts/transformer.md'}
        assert (Path(root) / 'concepts' / 'transformer.md').exists()

    def test_create_page_existing_raises(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(FileExistsError):
            fs.create_page('concepts/attention.md', 'x')

    def test_create_page_no_parent_dir_raises(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(NotADirectoryError):
            fs.create_page('nonexistent_category/page.md', 'x')

    # —— delete_page ——

    def test_delete_page_removes(self, tmp_path):
        from pathlib import Path

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        target = Path(root) / 'concepts' / 'attention.md'
        assert target.exists()
        fs.delete_page('concepts/attention.md')
        assert not target.exists()

    def test_delete_page_missing_raises(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(FileNotFoundError):
            fs.delete_page('concepts/nope.md')

    # —— path traversal protection ——

    def test_path_traversal_rejected(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(ValueError):
            fs.read_page('../../../etc/passwd.md')

    def test_managed_path_rejected(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(ValueError):
            fs.read_page('.openclaw-wiki/cache.md')

    def test_index_md_rejected(self, tmp_path):
        import pytest

        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(ValueError):
            fs.read_page('index.md')
    """集成包不重复定义容器/编排域常量（issue #98 acceptance / spec #97 user story 19）。

    容器/编排域常量单一来源在 containers app（#88-90 后续统一到 containers/constants.py），
    集成包 import 之、不重复定义。守护：wire 模块与 containers 域常量名无交集。
    """

    def test_wire_shares_no_constants_with_containers_domain(self):
        from containers import config_renderer, ports, runtime

        wire_const = {n for n in dir(wire) if not n.startswith('_') and n.isupper()}
        container_modules = (runtime, ports, config_renderer)
        container_const = {
            n
            for mod in container_modules
            for n in dir(mod)
            if not n.startswith('_') and n.isupper()
        }
        overlap = wire_const & container_const
        assert not overlap, f'wire 不应重复定义容器/编排域常量: {sorted(overlap)}'


# ═══════════════════════════════════════════════════════════════════════════════
# Issue #101: 路径1 ContainerRuntime 归属前移到集成包（strangler：接口先行、实现后迁）
# ═══════════════════════════════════════════════════════════════════════════════


class TestContainerRuntimePortSingleSourced:
    """ContainerRuntime Protocol 归属前移到集成包——issue #101 acceptance。

    4 条契约：
    - containers.runtime 不再定义 ContainerRuntime（单一来源）
    - DockerRuntime structurally satisfies 集成包 ContainerRuntime Port
    - FakeRuntime structurally satisfies 集成包 ContainerRuntime Port
    - docker SDK 仍只在 DockerRuntime import docker（不变量守护）
    """

    def test_container_runtime_not_defined_in_containers_runtime_module(self):
        """containers.runtime 不再定义 ContainerRuntime（接口已前移到集成包）。"""
        import containers.runtime as c_runtime

        names = {n for n in dir(c_runtime) if not n.startswith('_')}
        assert 'ContainerRuntime' not in names, (
            'containers.runtime 不应再定义 ContainerRuntime——'
            '归属已前移到 integration.openclaw.ports'
        )

    def test_docker_runtime_satisfies_integration_port(self):
        """DockerRuntime 结构子类型自动满足集成包 ContainerRuntime Port。"""
        from containers.docker_runtime import DockerRuntime
        from integration.openclaw import ContainerRuntime

        assert isinstance(DockerRuntime(), ContainerRuntime), (
            'DockerRuntime 应满足集成包 ContainerRuntime Port'
        )

    def test_fake_runtime_satisfies_integration_port(self):
        """FakeRuntime 结构子类型自动满足集成包 ContainerRuntime Port。"""
        from containers.tests.fakes import FakeRuntime
        from integration.openclaw import ContainerRuntime

        assert isinstance(FakeRuntime(), ContainerRuntime), (
            'FakeRuntime 应满足集成包 ContainerRuntime Port'
        )

    def test_only_docker_runtime_imports_docker_sdk(self):
        """docker SDK 仍只在 Adapter 处 import docker（不变量守护，spec §5.4）。"""
        import ast
        from pathlib import Path

        containers_dir = Path(__file__).resolve().parent.parent.parent.parent / 'containers'
        offenders: dict[str, list[str]] = {}
        # 排除 DockerRuntime 自身（唯一合法 import docker 处）
        exempt = {'docker_runtime.py'}

        for f in sorted(containers_dir.glob('*.py')):
            if f.name.startswith('test_') or f.name in exempt:
                continue
            tree = ast.parse(f.read_text(encoding='utf-8'), filename=f.name)
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    module = node.module if isinstance(node, ast.ImportFrom) else None
                    names = [
                        n.name if isinstance(node, ast.ImportFrom) else n.asname or n.name
                        for n in node.names
                    ]
                    for name in names:
                        # 检测 'import docker' 或 'from docker import ...'
                        if (
                            (isinstance(node, ast.Import) and name == 'docker')
                            or (isinstance(node, ast.ImportFrom) and module == 'docker')
                        ):
                            offenders.setdefault(f.name, []).append(
                                'import docker' if isinstance(node, ast.Import)
                                else f'from docker import {", ".join(n.name for n in node.names)}',
                            )

        assert not offenders, (
            f'docker SDK 仍应只在 DockerRuntime import docker：'
            f'{offenders}'
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Issue #102: 路径4a OpenClawWire 配对握手合并——单一 connect 帧构造器 + 配对 Adapter
# ═══════════════════════════════════════════════════════════════════════════════


class TestConnectFrameBuilderSingleSource:
    """wire.ConnectFrameBuilder 是单一 connect 帧构造器——issue #102 acceptance。

    消除 pairing_ws._build_connect_frame 与 chat_client._default_connect_frame 两套重复。
    """

    # —— Slice 1: ConnectFrameBuilder 存在 + pairing connect 帧契约 ——

    def test_connect_frame_builder_exists_in_wire(self):
        """wire 模块暴露 ConnectFrameBuilder（单一来源，替代两处私有构造器）。"""
        assert hasattr(wire, 'ConnectFrameBuilder'), (
            'wire 模块应暴露 ConnectFrameBuilder'
        )

    def test_pairing_connect_frame_minimum_fields(self):
        """配对手帧包含协议 v4 全部必填字段：type/req/method/params。"""
        from chat.device_crypto import DeviceCrypto

        identity = DeviceCrypto.generate_identity()
        frame = wire.ConnectFrameBuilder.pairing(
            req_id='req-1', identity=identity, token='gw-tok', nonce='nz-9',
        )
        assert frame['type'] == 'req'
        assert frame['method'] == 'connect'
        assert 'id' in frame
        params = frame['params']
        assert params['minProtocol'] == wire.PROTOCOL
        assert params['maxProtocol'] == wire.PROTOCOL
        assert params['role'] == wire.ROLE
        assert params['scopes'] == wire.SCOPES
        assert params['caps'] == wire.CAPS
        # client 块使用 wire 常量
        assert params['client']['id'] == wire.CLIENT_ID
        assert params['client']['mode'] == wire.CLIENT_MODE

    def test_pairing_connect_frame_device_signature(self):
        """配对手帧含 device 签名块（publicKey/signature/signedAt/nonce）。"""
        from chat.device_crypto import DeviceCrypto

        identity = DeviceCrypto.generate_identity()
        frame = wire.ConnectFrameBuilder.pairing(
            req_id='req-1', identity=identity, token='gw-tok', nonce='nz-9',
        )
        dev = frame['params']['device']
        assert dev['id'] == identity.device_id
        assert dev['publicKey'] == identity.public_key_raw_base64url()
        assert dev['nonce'] == 'nz-9'
        assert isinstance(dev['signedAt'], int)
        assert dev['signature']  # 非空签名

    def test_pairing_connect_frame_auth_token(self):
        """配对手帧 auth.token = bootstrap GATEWAY_TOKEN。"""
        from chat.device_crypto import DeviceCrypto

        identity = DeviceCrypto.generate_identity()
        frame = wire.ConnectFrameBuilder.pairing(
            req_id='req-1', identity=identity, token='gw-tok', nonce='nz-9',
        )
        assert frame['params']['auth']['token'] == 'gw-tok'

    def test_pairing_connect_frame_signature_payload(self):
        """配对手帧签名串 = DeviceCrypto.build_auth_payload_v3 产物（与网关逐字节比对）。"""
        from chat.device_crypto import DeviceCrypto

        identity = DeviceCrypto.generate_identity()
        frame = wire.ConnectFrameBuilder.pairing(
            req_id='req-1', identity=identity, token='gw-tok', nonce='nz-9',
        )
        # 用相同参数独立计算签名串 → 验证 Builder 产出的签名可被 DeviceIdentity.verify 复现
        signed_at = frame['params']['device']['signedAt']
        expected_payload = DeviceCrypto.build_auth_payload_v3(
            device_id=identity.device_id,
            client_id=wire.CLIENT_ID,
            client_mode=wire.CLIENT_MODE,
            role=wire.ROLE,
            scopes=wire.SCOPES,
            signed_at_ms=signed_at,
            token='gw-tok',
            nonce='nz-9',
            platform='linux',
            device_family='',
        )
        # 签名应对 expected_payload 有效（Ed25519 verify）
        import base64

        from cryptography.hazmat.primitives import serialization

        pub = serialization.load_pem_public_key(identity.public_key_pem.encode())
        sig = base64.urlsafe_b64decode(frame['params']['device']['signature'] + '==')
        pub.verify(sig, expected_payload.encode('utf-8'))

    # —— Slice 2: session connect 帧（已配对长连接）——

    def test_session_connect_frame_minimum_fields(self):
        """已配对长连接帧基本字段（device 块/scopes 语义见 #139 专项测试）。"""
        frame = wire.ConnectFrameBuilder.session(
            req_id='req-2', identity=_fake_identity(), device_token='dt-abc',
            nonce='nz-9', scopes=['operator.read', 'operator.write'],
        )
        assert frame['type'] == 'req'
        assert frame['method'] == 'connect'
        assert frame['params']['auth']['token'] == 'dt-abc'
        assert frame['params']['minProtocol'] == wire.PROTOCOL
        assert frame['params']['maxProtocol'] == wire.PROTOCOL
        assert frame['params']['role'] == wire.ROLE
        assert frame['params']['caps'] == wire.CAPS

    # —— Slice 2b: session connect 帧加 device 签名块（issue #139，与 pairing 同构）——

    def test_session_frame_has_device_block(self):
        """issue #139：session 帧含完整 device 签名块（与 pairing() 字段一致）。"""
        identity = _fake_identity()
        frame = wire.ConnectFrameBuilder.session(
            req_id='req-2', identity=identity, device_token='dt-abc',
            nonce='nz-9', scopes=['operator.read', 'operator.write'],
        )
        dev = frame['params']['device']
        assert dev['id'] == identity.device_id
        assert dev['publicKey'] == identity.public_key_raw_base64url()
        assert dev['nonce'] == 'nz-9'
        assert isinstance(dev['signedAt'], int)
        assert dev['signature']  # 非空签名

    def test_session_frame_uses_device_token_and_stored_scopes(self):
        """issue #139：session 帧 auth.token=device_token、scopes=传入的已批准 scopes（非 wire.SCOPES）。"""
        identity = _fake_identity()
        approved = ['operator.read', 'operator.write']  # 明显少于 wire.SCOPES 全量
        frame = wire.ConnectFrameBuilder.session(
            req_id='req-3', identity=identity, device_token='dt-9',
            nonce='nz-9', scopes=approved,
        )
        assert frame['params']['auth']['token'] == 'dt-9'  # device_token，非 gateway token
        assert frame['params']['scopes'] == approved
        assert frame['params']['scopes'] != wire.SCOPES


def test_wire_connect_signature_isomorphic_across_port_fake_adapter():
    """回归 (codex #149 P2)：OpenClawWire.connect 在 Port / Fake / Adapter 三处签名同构。

    isinstance(Protocol) 只验方法存在、不验签名——#139 改 Adapter.connect 加 keyword-only
    identity/nonce/scopes 时若漏改 Port/Fake 会静默分歧（Liskov 违反：按 Port 编程换真
    Adapter 即 TypeError）。用 inspect 锁三处 keyword-only 参数同构。
    """
    import inspect

    from integration.openclaw.adapters import OpenClawWireAdapter
    from integration.openclaw.fakes import FakeOpenClawWire
    from integration.openclaw.ports import OpenClawWire

    def kw_only(func):
        sig = inspect.signature(func)
        return [p.name for p in sig.parameters.values() if p.kind == inspect.Parameter.KEYWORD_ONLY]

    expected = ['identity', 'nonce', 'scopes']
    assert kw_only(OpenClawWire.connect) == expected
    assert kw_only(FakeOpenClawWire.connect) == expected
    assert kw_only(OpenClawWireAdapter.connect) == expected


class TestPairingAdapterImplementsWirePort:
    """OpenClawWireAdapter 实现 OpenClawWire Port——issue #102 acceptance。

    Adapter 封装 challenge/nonce/Ed25519/connect/PAIRING_REQUIRED 握手全流程。
    """

    def test_adapter_exists_and_satisfies_port(self):
        """adapters 模块暴露 OpenClawWireAdapter，结构子类型满足 OpenClawWire Port。"""
        from integration.openclaw import OpenClawWire
        from integration.openclaw.adapters import OpenClawWireAdapter

        adapter = OpenClawWireAdapter(transport=None)
        assert isinstance(adapter, OpenClawWire), (
            'OpenClawWireAdapter 应实现 OpenClawWire Port'
        )

    def test_adapter_pair_returns_pairing_result(self):
        """配对成功返回 deviceToken + scopes（PairingResult 语义）。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.tests.fakes import FakeTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        identity = DeviceCrypto.generate_identity()
        transport = FakeTransport.hello_ok(
            scopes=['operator.read', 'operator.write', 'operator.approvals'],
            device_token='dt-xyz',
        )
        adapter = OpenClawWireAdapter(transport=transport)

        async def _run():
            return await adapter.pair(
                url='ws://127.0.0.1:19000/',
                identity=identity,
                bootstrap_token='gw-tok',
            )

        result = asyncio.run(_run())
        assert result.device_token == 'dt-xyz'
        assert 'operator.approvals' in result.scopes

    def test_adapter_pair_uses_single_connect_frame_builder(self, monkeypatch):
        """OpenClawWireAdapter.pair() 经 ConnectFrameBuilder 构建 connect 帧（非自建）。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.tests.fakes import FakeTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        identity = DeviceCrypto.generate_identity()
        transport = FakeTransport.hello_ok()

        # 打桩 ConnectFrameBuilder.pairing 以验证调用
        calls = []
        original = wire.ConnectFrameBuilder.pairing

        def _spy(*args, **kwargs):
            calls.append(True)
            return original(*args, **kwargs)

        monkeypatch.setattr(wire.ConnectFrameBuilder, 'pairing', _spy)

        adapter = OpenClawWireAdapter(transport=transport)
        asyncio.run(adapter.pair(
            url='ws://127.0.0.1:19000/',
            identity=identity,
            bootstrap_token='gw-tok',
        ))
        assert len(calls) == 1, (
            'OpenClawWireAdapter 应经 ConnectFrameBuilder.pairing 构建 connect 帧'
        )

    def test_adapter_pair_pairing_required_raises(self):
        """网关返回 PAIRING_REQUIRED → 上抛 PairingRequired(requestId)。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.pairing_ws import PairingRequired
        from chat.tests.fakes import FakeTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        identity = DeviceCrypto.generate_identity()
        transport = FakeTransport.pairing_required(request_id='req-999')
        adapter = OpenClawWireAdapter(transport=transport)

        async def _run():
            return await adapter.pair(
                url='ws://127.0.0.1:19000/',
                identity=identity,
                bootstrap_token='gw-tok',
            )

        with pytest.raises(PairingRequired) as exc_info:
            asyncio.run(_run())
        assert exc_info.value.request_id == 'req-999'

    def test_adapter_pair_nested_not_paired_raises_pairing_required(self):
        """回归 (codex #164 P2)：网关返回嵌套 NOT_PAIRED/details.code=PAIRING_REQUIRED →
        上抛 PairingRequired(requestId)。ghcr 2026.6.34 官方镜像用嵌套码，旧
        adapters.py 只检外层 error.code 遗漏。
        """
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.pairing_ws import PairingRequired
        from chat.tests.fakes import _CM, _FakeWs
        from integration.openclaw.adapters import OpenClawWireAdapter

        identity = DeviceCrypto.generate_identity()

        class _NestedNotPairedTransport:
            """模拟 ghcr 2026.6.34 官方镜像的两段嵌套错误应答。"""
            connect_calls = 0

            def __call__(self, url):
                self.connect_calls += 1
                ws = _FakeWs(
                    pre_challenge_frames=[],
                    result_frame={'type': 'res', 'ok': False,
                                  'error': {'code': 'NOT_PAIRED',
                                            'details': {'code': 'PAIRING_REQUIRED',
                                                        'requestId': 'req-nested'}}},
                    pre_result_frames=[],
                )
                return _CM(ws)

        adapter = OpenClawWireAdapter(transport=_NestedNotPairedTransport())

        async def _run():
            return await adapter.pair(
                url='ws://127.0.0.1:19000/',
                identity=identity,
                bootstrap_token='gw-tok',
            )

        with pytest.raises(PairingRequired) as exc_info:
            asyncio.run(_run())
        assert exc_info.value.request_id == 'req-nested'

    def test_adapter_pair_error_raises_pairing_error(self):
        """网关返回其它错误 → 上抛 PairingError。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.pairing_ws import PairingError
        from chat.tests.fakes import FakeTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        identity = DeviceCrypto.generate_identity()
        transport = FakeTransport.connect_error('bad token')
        adapter = OpenClawWireAdapter(transport=transport)

        async def _run():
            return await adapter.pair(
                url='ws://127.0.0.1:19000/',
                identity=identity,
                bootstrap_token='gw-tok',
            )

        with pytest.raises(PairingError):
            asyncio.run(_run())

    # ── regression: codex P1 ──────────────────────────────────────────────

    def test_default_connect_is_sync_factory(self):
        """_default_connect 是同步工厂（非 coroutine），
        pair() 用 async with 打开连接时不 TypeError。"""
        from integration.openclaw.adapters import OpenClawWireAdapter

        assert not inspect.iscoroutinefunction(
            OpenClawWireAdapter._default_connect,
        ), '_default_connect 应是同步工厂，返回 async context manager 而非 coroutine'

    # ── regression: codex P2 ──────────────────────────────────────────────

    def test_pair_accepts_positional_args(self):
        """pair() 支持位置参数（与 OpenClawWire Port 和 FakeOpenClawWire 一致）。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.tests.fakes import FakeTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        identity = DeviceCrypto.generate_identity()
        transport = FakeTransport.hello_ok(device_token='dt-pos')
        adapter = OpenClawWireAdapter(transport=transport)

        async def _run():
            # 位置参数调用，非关键字
            return await adapter.pair(
                'ws://127.0.0.1:19000/', identity, 'gw-tok',
            )

        result = asyncio.run(_run())
        assert result.device_token == 'dt-pos'


# ═══════════════════════════════════════════════════════════════════════════════
# Issue #103: 路径4b OpenClawWire 长连接合并——Port 扩展 + Fake + Adapter
# ═══════════════════════════════════════════════════════════════════════════════


class TestOpenClawWireAdapterLongLived:
    """OpenClawWireAdapter 长连接方法契约测试——issue #103 acceptance。

    利用 FakeChatTransport 模拟 WS 应答，验证所有长连 RPC 方法：
    connect / send_message / resolve_approval / list_commands / sessions_rpc /
    list_pending_approvals + 审批订阅 + dead / discard / close。
    """

    # ── connect ───────────────────────────────────────────────────────────────

    def test_connect_uses_connect_frame_builder(self):
        """connect() 经 ConnectFrameBuilder.session() 构建握手帧（issue #139：含 device 签名块）。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport()
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt-xyz',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
        asyncio.run(_run())
        connect_frame = next(f for f in t.sent if f.get('method') == 'connect')
        assert connect_frame['params']['auth']['token'] == 'dt-xyz'
        assert connect_frame['params']['device']['id'] == _SESSION_IDENTITY.device_id
        assert connect_frame['params']['device']['signature']  # 非空签名

    def test_connect_failure_raises(self):
        """connect 握手失败上抛 ChatConnectError。"""
        import asyncio

        from chat.chat_client import ChatConnectError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(connect_ok=False)
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
        with pytest.raises(ChatConnectError):
            asyncio.run(_run())

    def test_connect_timeout_raises(self):
        """connect 握手超时抛 ChatConnectError。"""
        import asyncio

        from chat.chat_client import ChatConnectError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(suppress_connect_ack=True)
        adapter = OpenClawWireAdapter(transport=t, timeout=0.1)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
        with pytest.raises(ChatConnectError):
            asyncio.run(_run())

    # ── send_message ──────────────────────────────────────────────────────────

    def test_send_message_builds_chat_send_frame_and_returns_runid(self):
        """send_message 发 chat.send → ack(runId)，返回 runId。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(ack_run_id='run-9')
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await adapter.send_message('sess-1', 'hello', on_event=lambda f: None)
        run_id = asyncio.run(_run())
        assert run_id == 'run-9'
        cs = next(f for f in t.sent if f.get('method') == 'chat.send')
        assert cs['params']['sessionKey'] == 'sess-1'
        assert cs['params']['message'] == 'hello'
        assert cs['params']['agentId'] == 'main'

    def test_send_message_not_connected_raises(self):
        """未 connect 时 send_message 抛 ChatClientError。"""
        import asyncio

        from chat.chat_client import ChatClientError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        adapter = OpenClawWireAdapter(transport=FakeChatTransport())

        async def _run():
            await adapter.send_message('s', 'm', on_event=lambda f: None)
        with pytest.raises(ChatClientError):
            asyncio.run(_run())

    def test_send_message_ack_error_raises(self):
        """chat.send ack 被网关拒绝 → ChatSendError。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(ack_error={'code': 'RATE_LIMIT', 'message': 'too fast'})
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            await adapter.send_message('s', 'm', on_event=lambda f: None)
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'too fast' in str(exc.value)

    def test_recv_routes_events_to_on_event(self):
        """recv loop 把网关 chat 事件翻译后经 on_event 回传。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        events = [
            {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'delta', 'deltaText': '你好'}},
            {'type': 'event', 'event': 'chat', 'payload': {'runId': 'r1', 'state': 'final'}},
        ]
        t = FakeChatTransport(ack_run_id='r1', events=events)
        adapter = OpenClawWireAdapter(transport=t)
        received = []

        async def cb(frame):
            received.append(frame)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            await adapter.send_message('s', 'm', on_event=cb)
            await asyncio.sleep(0.1)
        asyncio.run(_run())
        assert received == [
            {'type': 'text', 'runId': 'r1', 'delta': '你好'},
            {'type': 'done', 'runId': 'r1'},
        ]

    # ── resolve_approval ──────────────────────────────────────────────────────

    def test_resolve_approval_returns_payload(self):
        """resolve_approval 发 {kind}.approval.resolve 帧并返回网关 payload。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(resolve_payload={'id': 'ap-1', 'decision': 'allow-once'})
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await adapter.resolve_approval('ap-1', 'exec', 'allow-once')
        result = asyncio.run(_run())
        assert result == {'id': 'ap-1', 'decision': 'allow-once'}
        rs = next(f for f in t.sent if f.get('method') == 'exec.approval.resolve')
        assert rs['params'] == {'id': 'ap-1', 'decision': 'allow-once'}

    def test_resolve_approval_gateway_reject_raises(self):
        """审批回覆被网关拒绝 → ChatSendError。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(resolve_error={'code': 'FORBIDDEN', 'message': 'missing scope'})
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            await adapter.resolve_approval('ap-1', 'exec', 'deny')
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'missing scope' in str(exc.value)

    # ── list_commands ─────────────────────────────────────────────────────────

    def test_list_commands_returns_payload(self):
        """list_commands 返回网关 payload。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        payload = {'commands': [{'name': '/wiki', 'description': 'Wiki tools'}]}
        t = FakeChatTransport(commands_payload=payload)
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await adapter.list_commands()
        result = asyncio.run(_run())
        assert result == payload
        req = next(f for f in t.sent if f.get('method') == 'commands.list')
        assert req['params']['agentId'] == 'main'

    # ── sessions_rpc ──────────────────────────────────────────────────────────

    def test_sessions_rpc_returns_payload(self):
        """sessions_rpc 发任意 method→params 帧并返回 payload（透传）。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(rpc_payloads={'sessions.list': {'sessions': []}})
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await adapter.sessions_rpc('sessions.list', {'agentId': 'main'})
        result = asyncio.run(_run())
        assert result == {'sessions': []}

    # ── ack timeout 异常链（issue #130 类别A W0707：raise ChatSendError from TimeoutError）──

    def test_send_message_ack_timeout_chains_timeout_error(self):
        """chat.send ack 超时 → ChatSendError 且 __cause__ 为 TimeoutError（W0707 raise-missing-from）。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(suppress_ack=True)  # 不回 chat.send ack → 超时
        adapter = OpenClawWireAdapter(transport=t, timeout=0.1)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            await adapter.send_message('s', 'm', on_event=lambda f: None)
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'chat.send ack timeout' in str(exc.value)
        assert isinstance(exc.value.__cause__, TimeoutError)

    def test_resolve_approval_ack_timeout_chains_timeout_error(self):
        """approval.resolve ack 超时 → ChatSendError 且 __cause__ 为 TimeoutError。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(suppress_ack=True)  # 不回 approval.resolve ack → 超时
        adapter = OpenClawWireAdapter(transport=t, timeout=0.1)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            await adapter.resolve_approval('ap-1', 'exec', 'approve')
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'approval.resolve ack timeout' in str(exc.value)
        assert isinstance(exc.value.__cause__, TimeoutError)

    def test_list_commands_ack_timeout_chains_timeout_error(self):
        """commands.list ack 超时 → ChatSendError 且 __cause__ 为 TimeoutError。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(suppress_commands_ack=True)  # 不回 commands.list ack → 超时
        adapter = OpenClawWireAdapter(transport=t, timeout=0.1)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            await adapter.list_commands()
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'commands.list ack timeout' in str(exc.value)
        assert isinstance(exc.value.__cause__, TimeoutError)

    def test_sessions_rpc_ack_timeout_chains_timeout_error(self):
        """sessions.* ack 超时 → ChatSendError 且 __cause__ 为 TimeoutError。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        # rpc_suppress 含该方法 → 不回 res → 超时（需先注册进 rpc_payloads 才会进分发循环）
        t = FakeChatTransport(
            rpc_payloads={'sessions.list': {'sessions': []}},
            rpc_suppress={'sessions.list'},
        )
        adapter = OpenClawWireAdapter(transport=t, timeout=0.1)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            await adapter.sessions_rpc('sessions.list', {'agentId': 'main'})
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'sessions.list ack timeout' in str(exc.value)
        assert isinstance(exc.value.__cause__, TimeoutError)

    # ── list_pending_approvals ────────────────────────────────────────────────

    def test_list_pending_approvals_translates_cards(self):
        """list_pending_approvals 补拉审批并翻译成卡帧。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(list_payload={
            'approvals': [{'id': 'ap-1', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'cmd1'}}],
        })
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await adapter.list_pending_approvals()
        cards = asyncio.run(_run())
        assert cards == [{'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'cmd1', 'sessionKey': None}]

    def test_list_pending_approvals_payload_list_translates_cards(self):
        """实测校准（spike ghcr 2026.6.34-browser, 2026-07-27）：exec.approval.list 的 payload
        直接是 list（非空 [{...}]），非 {approvals:[...]} dict。wire adapter 旧代码 list.get 会
        AttributeError（codex P2：与 OpenClawChatClient 同源 dispatch，两实现不可漂移）。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport(list_payload=[
            {'id': 'ap-1', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'cmd1'}},
        ])
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await adapter.list_pending_approvals()
        cards = asyncio.run(_run())
        assert cards == [{'type': 'approval', 'id': 'ap-1', 'kind': 'exec', 'command': 'cmd1', 'sessionKey': None}]

    # ── approval subscribers ──────────────────────────────────────────────────

    def test_approval_subscribers_fan_out(self):
        """add_approval_subscriber 注册后在 recv loop 中收到审批事件。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        events = [
            {'type': 'event', 'event': 'exec.approval.requested',
             'payload': {'id': 'ap-1', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'rm'}}},
        ]
        t = FakeChatTransport(events=events)
        adapter = OpenClawWireAdapter(transport=t)
        got = []

        async def sub(frame):
            got.append(frame)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            adapter.add_approval_subscriber(sub)
            await asyncio.sleep(0.1)
        asyncio.run(_run())
        assert len(got) == 1
        assert got[0]['type'] == 'approval'
        assert got[0]['id'] == 'ap-1'

    def test_remove_subscriber_stops_delivery(self):
        """退订后不再收审批事件。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport()
        adapter = OpenClawWireAdapter(transport=t)
        got_a, got_b = [], []

        async def sub_a(frame):
            got_a.append(frame)

        async def sub_b(frame):
            got_b.append(frame)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            adapter.add_approval_subscriber(sub_a)
            adapter.add_approval_subscriber(sub_b)
            adapter.remove_approval_subscriber(sub_a)
            t.push({'type': 'event', 'event': 'exec.approval.requested',
                    'payload': {'id': 'ap-2', 'kind': 'exec', 'systemRunPlan': {'rawCommand': 'cmd'}}})
            await asyncio.sleep(0.1)
        asyncio.run(_run())
        assert not got_a
        assert len(got_b) == 1

    # ── dead / discard / close ────────────────────────────────────────────────

    def test_adapter_dead_after_connect_disconnect(self):
        """connect 后 dead=False；close 后 dead=True。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport()
        adapter = OpenClawWireAdapter(transport=t)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            assert not adapter.dead
            await adapter.close()
            assert adapter.dead
        asyncio.run(_run())

    def test_discard_removes_runid(self):
        """discard 后后续事件不回调。"""
        import asyncio

        from chat.tests.fakes import FakeChatTransport
        from integration.openclaw.adapters import OpenClawWireAdapter

        t = FakeChatTransport()
        adapter = OpenClawWireAdapter(transport=t)
        received = []

        async def cb(frame):
            received.append(frame)

        async def _run():
            await adapter.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            rid = await adapter.send_message('s', 'm', on_event=cb)
            adapter.discard(rid)
            t.push({'type': 'event', 'event': 'chat', 'payload': {'runId': rid, 'state': 'delta', 'deltaText': 'lost'}})
            await asyncio.sleep(0.05)
        asyncio.run(_run())
        assert not received


class TestOpenClawWireLongLivedPort:
    """OpenClawWire Port 长连接方法完整性——issue #103 acceptance。

    合约：Port 包含配对后长连的完整生命周期（connect/send_message/resolve_approval/
    list_commands/sessions RPC + 审批订阅 + dead/disconnect/close）。
    """

    # ── 方法存在性 ──

    def test_port_has_long_lived_methods(self):
        """Port 暴露所有长连接方法签名（供 consumer/pool 依赖）。"""
        from integration.openclaw import OpenClawWire

        names = [n for n in dir(OpenClawWire) if not n.startswith('_')]
        required = {
            'pair',           # #102: 配对握手
            'connect',        # 建立已配对长连
            'send_message',   # chat.send → ack(runId)
            'resolve_approval',  # approve/deny
            'list_commands',  # commands.list（已配对长连可用）
            'list_pending_approvals',  # 补拉待审批
            'sessions_rpc',   # 通用会话 RPC（sessions.list/create/delete + chat.history）
            'close',          # 关闭长连
        }
        missing = required - set(names)
        assert not missing, f'OpenClawWire Port 缺长连接方法: {sorted(missing)}'

    def test_port_approval_subscriber_contract(self):
        """Port 暴露 add_approval_subscriber / remove_approval_subscriber。"""
        from integration.openclaw import OpenClawWire

        names = {n for n in dir(OpenClawWire) if not n.startswith('_')}
        assert 'add_approval_subscriber' in names
        assert 'remove_approval_subscriber' in names

    def test_port_dead_and_disconnect_contract(self):
        """Port 暴露 dead 属性 + discard 方法。"""
        from integration.openclaw import OpenClawWire

        names = {n for n in dir(OpenClawWire) if not n.startswith('_')}
        assert 'dead' in names
        assert 'discard' in names


class TestFakeOpenClawWireLongLived:
    """FakeOpenClawWire 完整模拟所有长连接方法——issue #103 acceptance。

    合约：Fake 实现扩展后的 Port，所有长连接方法可注入测试，不依赖真 gateway。
    """

    def test_fake_has_all_long_lived_methods(self):
        """Fake 暴露扩展后 Port 的所有方法（Port 合规性守护）。"""
        from integration.openclaw import OpenClawWire
        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        assert isinstance(fake, OpenClawWire), 'FakeOpenClawWire 应满足扩展后 OpenClawWire Port'

        # 验证所有方法可调用不抛 NotImplementedError
        import asyncio

        # send_message（需先 connect）
        async def _send():
            await fake.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            run_id = await fake.send_message('s1', 'hello', on_event=lambda f: None)
            assert run_id == 'fake-run-id'
        asyncio.run(_send())

        # resolve_approval
        fake.resolve_result = {'decision': 'approve'}
        async def _resolve():
            return await fake.resolve_approval('ap-1', 'exec', 'approve')
        assert asyncio.run(_resolve()) == {'decision': 'approve'}

        # list_commands
        fake.commands_payload = {'commands': []}
        async def _cmds():
            return await fake.list_commands()
        assert asyncio.run(_cmds()) == {'commands': []}

        # sessions_rpc
        fake.rpc_results = {'sessions.list': {'sessions': [{'key': 's1'}]}}
        async def _rpc():
            return await fake.sessions_rpc('sessions.list', {})
        assert asyncio.run(_rpc()) == {'sessions': [{'key': 's1'}]}

        # list_pending_approvals
        fake.pending_approvals = [{'type': 'approval', 'id': 'ap-1'}]
        async def _lpa():
            return await fake.list_pending_approvals()
        assert asyncio.run(_lpa()) == [{'type': 'approval', 'id': 'ap-1'}]

        # approval subscribers
        calls = []
        fake.add_approval_subscriber(calls.append)
        assert len(fake._approval_subscribers) == 1
        fake.remove_approval_subscriber(fake._approval_subscribers[0])
        assert len(fake._approval_subscribers) == 0

        # dead / discard
        assert not fake.dead
        fake.discard('run-1')
        assert 'run-1' in fake.discarded

    def test_fake_send_message_returns_preset_run_id(self):
        """Fake send_message 返回预设 run_id（测试可控）。"""
        import asyncio

        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        fake.run_id = 'custom-run-42'
        async def _run():
            await fake.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await fake.send_message('s', 'm', on_event=lambda f: None)
        assert asyncio.run(_run()) == 'custom-run-42'

    def test_fake_send_message_records_calls(self):
        """Fake send_message 记录调用参数供断言。"""
        import asyncio

        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        received = []

        async def cb(frame):
            received.append(frame)

        async def _run():
            await fake.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            return await fake.send_message('sess-1', '你好', on_event=cb)
        asyncio.run(_run())
        assert len(fake.sent) == 1
        assert fake.sent[0][0] == 'sess-1'
        assert fake.sent[0][1] == '你好'
        # on_event ref is stored for push
        assert fake.sent[0][2] is cb

    def test_fake_push_events_to_on_event(self):
        """Fake 可 push 事件到 send_message 注册的 on_event 回调。"""
        import asyncio

        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        received = []

        async def cb(frame):
            received.append(frame)

        async def _run():
            await fake.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            rid = await fake.send_message('s', 'm', on_event=cb)
            await fake.push_event(rid, {'type': 'text', 'runId': rid, 'delta': 'hello'})
            await fake.push_event(rid, {'type': 'done', 'runId': rid})
            return rid
        run_id = asyncio.run(_run())

        assert len(received) == 2
        assert received[0] == {'type': 'text', 'runId': run_id, 'delta': 'hello'}
        assert received[1] == {'type': 'done', 'runId': run_id}

    def test_fake_dead_flag_controllable(self):
        """Fake dead 标志可被测试注入控制（模拟连接断开/recv loop 死掉）。"""
        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        assert not fake.dead
        fake.dead = True
        assert fake.dead

    def test_fake_rpc_raises_when_preset(self):
        """Fake sessions_rpc 可模拟网关拒绝（测试注入错误）。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        fake.rpc_errors = {'sessions.delete': ChatSendError('forbidden')}
        async def _run():
            return await fake.sessions_rpc('sessions.delete', {'key': 'x'})
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'forbidden' in str(exc.value)

    def test_fake_commands_rpc_raises_when_preset(self):
        """Fake list_commands 可模拟网关拒绝。"""
        import asyncio

        from chat.chat_client import ChatSendError
        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        fake.commands_error = ChatSendError('no permission')
        async def _run():
            return await fake.list_commands()
        with pytest.raises(ChatSendError) as exc:
            asyncio.run(_run())
        assert 'no permission' in str(exc.value)

    def test_fake_discard_removes_route(self):
        """Fake discard 后事件不再回调。"""
        import asyncio

        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        received = []

        async def cb(frame):
            received.append(frame)

        async def _run():
            await fake.connect(
                'ws://x/', 'dt',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
            rid = await fake.send_message('s', 'm', on_event=cb)
            fake.discard(rid)
            await fake.push_event(rid, {'type': 'text', 'delta': 'lost'})
        asyncio.run(_run())
        assert not received  # discard 后事件丢弃

    def test_fake_not_connected_send_raises(self):
        """Fake 未 connect 时 send_message 抛 ChatClientError（与真 Adapter 一致）。"""
        import asyncio

        from chat.chat_client import ChatClientError
        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()  # 未 connect
        async def _run():
            return await fake.send_message('s', 'm', on_event=lambda f: None)
        with pytest.raises(ChatClientError):
            asyncio.run(_run())

    def test_fake_connect_marks_not_dead(self):
        """Fake connect 后 dead=False。"""
        import asyncio

        from integration.openclaw.fakes import FakeOpenClawWire

        fake = FakeOpenClawWire()
        async def _run():
            await fake.connect(
                'ws://x/', 'dt-1',
                identity=_SESSION_IDENTITY, nonce=_SESSION_NONCE, scopes=_SESSION_SCOPES,
            )
        asyncio.run(_run())
        assert not fake.dead
        assert fake.connected == [('ws://x/', 'dt-1')]


# ═══════════════════════════════════════════════════════════════════════════════
# Issue #105: 跨 app 泄漏收口——断言非翻译层不直接持有 wire 概念
# ═══════════════════════════════════════════════════════════════════════════════


class TestCrossAppLeakPrevention:
    """跨 app 泄漏收口契约测试——issue #105 acceptance。

    断言非集成包层（containers/chat app）不直接持有 wire 概念字符串字面量：
    - containers 不含 `device_id`/`scopes`/`pairing_request_id` 字面量
    - chat/views.py 不含 `openclaw devices approve` CLI 字面量
    - 翻译函数行为契约（build_pairing_status_default / format_device_approve_command）
    - approval 字段常量单一来源
    """

    # ── AST 扫描：containers 不含配对 wire 字段字符串字面量 ────────────────

    _PAIRING_WIRE_LITERALS = frozenset({'device_id', 'scopes', 'pairing_request_id'})

    def _collect_string_constants(self, filepath: str) -> set[str]:
        """AST 收集文件中所有字符串常量值（含 f-string 静态段）。"""
        import ast
        from pathlib import Path

        tree = ast.parse(Path(filepath).read_text(encoding='utf-8'), filename=filepath)
        strings = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                strings.add(node.value)
            elif isinstance(node, ast.JoinedStr):
                for value in node.values:
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        strings.add(value.value)
        return strings

    def _file_content_contains(self, filepath: str, needle: str) -> bool:
        """原始文本内容是否包含给定字符串（用于跨行的 f-string 片段）。"""
        from pathlib import Path
        return needle in Path(filepath).read_text(encoding='utf-8')

    def test_containers_views_no_pairing_wire_literals(self):
        """containers/views.py 不含 device_id / scopes / pairing_request_id 字面量。"""
        import os

        views_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
            'containers', 'views.py',
        )
        strings = self._collect_string_constants(views_path)
        overlap = strings & self._PAIRING_WIRE_LITERALS
        assert not overlap, (
            f'containers/views.py 不应直接持有 pairing wire 字段字面量: {sorted(overlap)}'
        )

    def test_containers_serializers_no_pairing_wire_literals(self):
        """containers/serializers.py 不含 device_id / scopes / pairing_request_id 字面量。"""
        import os

        serializers_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
            'containers', 'serializers.py',
        )
        strings = self._collect_string_constants(serializers_path)
        overlap = strings & self._PAIRING_WIRE_LITERALS
        assert not overlap, (
            f'containers/serializers.py 不应直接持有 pairing wire 字段字面量: {sorted(overlap)}'
        )

    # ── AST 扫描：chat/views.py 不含 CLI 字符串字面量 ─────────────────

    def test_chat_views_no_openclaw_devices_approve_literal(self):
        """chat/views.py 不含 `openclaw devices approve` CLI 字面量（原始文本扫描，含 f-string 片段）。"""
        import os

        views_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
            'chat', 'views.py',
        )
        assert not self._file_content_contains(views_path, 'openclaw devices approve'), (
            'chat/views.py 不应直接持有 `openclaw devices approve` CLI 字面量——'
            '应由集成包 translation.format_device_approve_command 生成'
        )

    # ── 翻译函数行为契约 ──────────────────────────────────────────────

    def test_build_pairing_status_default_returns_correct_shape(self):
        """build_pairing_status_default 返回 unpaired 状态 dict（status + 空字段）。"""
        from integration.openclaw.translation import build_pairing_status_default

        result = build_pairing_status_default()
        assert result == {
            'status': 'unpaired',
            'device_id': '',
            'scopes': [],
            'pairing_request_id': '',
        }, f'unpaired 默认状态 shape 不对: {result}'

    @pytest.mark.django_db
    def test_build_pairing_status_from_pairing_object(self):
        """build_pairing_status 从 Pairing 模型构建 dict（对齐 PairingStatusSerializer 输出）。"""
        from chat.models import Pairing
        from containers.models import Instance
        from integration.openclaw.translation import build_pairing_status

        inst = Instance.objects.create(name='test-leak', port=19000, image='test:1')
        pairing = Pairing.objects.create(
            instance=inst,
            device_id='dev-1',
            status=Pairing.STATUS_PAIRED,
            scopes_json='["operator.read", "operator.write"]',
            pairing_request_id='req-42',
        )
        result = build_pairing_status(pairing)
        assert result == {
            'status': 'paired',
            'device_id': 'dev-1',
            'scopes': ['operator.read', 'operator.write'],
            'pairing_request_id': 'req-42',
        }

        pairing.delete()
        inst.delete()

    def test_format_device_approve_command(self):
        """format_device_approve_command 生成 `openclaw devices approve <request_id>`。"""
        from integration.openclaw.translation import format_device_approve_command

        cmd = format_device_approve_command('req-abc123')
        assert cmd == 'openclaw devices approve req-abc123'
        assert 'openclaw' in cmd
        assert 'devices approve' in cmd
        assert 'req-abc123' in cmd

    # ── approval 字段常量单一来源 ──────────────────────────────────────

    def test_approval_field_constants_defined(self):
        """integration.openclaw.translation 暴露 APPROVAL_FIELD_{ID,KIND,DECISION} 常量。"""
        from integration.openclaw import translation

        assert hasattr(translation, 'APPROVAL_FIELD_ID'), '缺 APPROVAL_FIELD_ID 常量'
        assert hasattr(translation, 'APPROVAL_FIELD_KIND'), '缺 APPROVAL_FIELD_KIND 常量'
        assert hasattr(translation, 'APPROVAL_FIELD_DECISION'), '缺 APPROVAL_FIELD_DECISION 常量'
        assert translation.APPROVAL_FIELD_ID == 'id'
        assert translation.APPROVAL_FIELD_KIND == 'kind'
        assert translation.APPROVAL_FIELD_DECISION == 'decision'

    def test_approval_serializer_uses_integration_constants(self):
        """ApprovalResolveSerializer 字段名经集成包常量引用（单源）。"""
        from chat.serializers import ApprovalResolveSerializer
        from integration.openclaw import translation

        # 用 integration 常量访问 serializer fields
        ser = ApprovalResolveSerializer(data={
            translation.APPROVAL_FIELD_ID: 'ap-1',
            translation.APPROVAL_FIELD_KIND: 'exec',
            translation.APPROVAL_FIELD_DECISION: 'allow-once',
        })
        assert ser.is_valid(), f'serializer 应接受常量键入参: {ser.errors}'
        assert ser.validated_data[translation.APPROVAL_FIELD_ID] == 'ap-1'
        assert ser.validated_data[translation.APPROVAL_FIELD_KIND] == 'exec'
        assert ser.validated_data[translation.APPROVAL_FIELD_DECISION] == 'allow-once'

    @pytest.mark.django_db
    def test_pairing_status_serializer_uses_integration_constants(self):
        """chat PairingStatusSerializer 的字段键与 integration 常量一致（单源 contract）。"""
        import json

        from chat.models import Pairing
        from chat.serializers import PairingStatusSerializer
        from containers.models import Instance
        from integration.openclaw import translation

        inst = Instance.objects.create(name='test-single', port=19001, image='test:1')
        pairing = Pairing.objects.create(
            instance=inst,
            device_id='dev-x',
            scopes_json=json.dumps(['operator.read']),
            pairing_request_id='req-y',
        )
        data = PairingStatusSerializer(pairing).data
        assert data[translation.PAIRING_FIELD_DEVICE_ID] == 'dev-x'
        assert data[translation.PAIRING_FIELD_PAIRING_REQUEST_ID] == 'req-y'

        pairing.delete()
        inst.delete()


class TestFakeOpenClawWirePairing:
    """FakeOpenClawWire 支持完整配对状态模拟——issue #102 acceptance。

    PairingService 保留编排（状态机 + 持久化），把实际握手委托给 Wire Port；
    测试用 fake 注入，不依赖真容器网关。
    """

    def test_fake_pair_records_calls(self):
        """fake.pair() 记录调用参数，供断言。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from integration.openclaw.fakes import FakeOpenClawWire

        identity = DeviceCrypto.generate_identity()
        fake = FakeOpenClawWire()

        async def _run():
            return await fake.pair(
                url='ws://x/', identity=identity, bootstrap_token='tok',
            )

        asyncio.run(_run())
        assert len(fake.pair_calls) == 1
        assert fake.pair_calls[0][0] == 'ws://x/'
        assert fake.pair_calls[0][2] == 'tok'

    def test_fake_pair_returns_preset_result(self):
        """fake.pair() 返回预设 PairingResult，测试可控。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.pairing_ws import PairingResult
        from integration.openclaw.fakes import FakeOpenClawWire

        identity = DeviceCrypto.generate_identity()
        fake = FakeOpenClawWire()
        fake.pair_result = PairingResult(
            device_token='dt-preset',
            scopes=['operator.read', 'operator.write', 'operator.approvals'],
        )

        async def _run():
            return await fake.pair(url='ws://x/', identity=identity, bootstrap_token='tok')

        result = asyncio.run(_run())
        assert result.device_token == 'dt-preset'
        assert 'operator.approvals' in result.scopes

    def test_fake_pair_raises_when_preset(self):
        """fake 可预设异常以模拟 PairingRequired / PairingError 分支。"""
        import asyncio

        from chat.device_crypto import DeviceCrypto
        from chat.pairing_ws import PairingRequired
        from integration.openclaw.fakes import FakeOpenClawWire

        identity = DeviceCrypto.generate_identity()
        fake = FakeOpenClawWire()
        fake.pair_raise = PairingRequired('req-err')

        async def _run():
            return await fake.pair(url='ws://x/', identity=identity, bootstrap_token='tok')

        with pytest.raises(PairingRequired) as exc_info:
            asyncio.run(_run())
        assert exc_info.value.request_id == 'req-err'
