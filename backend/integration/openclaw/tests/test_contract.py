"""防腐层集成包契约测试（issue #98 / spec #97 / ADR 0002）。

沿用 #90 同源断言范式：断言 wire 域常量在集成包单一来源（chat 三处与
integration.openclaw.wire 同对象）、集成包暴露 4 Port、集成包不重复定义容器/编排域常量。

只断言**契约**（单一来源 / 依赖方向），不断言「哪个常量搬到哪」——那是测实现细节。
"""
from chat import chat_client, event_translate, pairing_ws
from integration.openclaw import wire


class TestWireConstantsSingleSource:
    """wire 域常量单一来源：chat 三处与 integration.openclaw.wire 同对象（#90 范式）。"""

    def test_protocol_is_single_sourced(self):
        assert chat_client._PROTOCOL is wire.PROTOCOL

    def test_scopes_is_single_sourced(self):
        assert chat_client._SCOPES is wire.SCOPES
        assert pairing_ws._SCOPES is wire.SCOPES

    def test_caps_is_single_sourced(self):
        assert chat_client._CAPS is wire.CAPS
        assert pairing_ws._CAPS is wire.CAPS

    def test_client_id_is_single_sourced(self):
        assert chat_client._CLIENT_ID is wire.CLIENT_ID
        assert pairing_ws._CLIENT_ID is wire.CLIENT_ID

    def test_agent_id_is_single_sourced(self):
        assert chat_client._AGENT_ID is wire.AGENT_ID

    def test_connect_frame_fields_single_sourced(self):
        assert pairing_ws._CLIENT_MODE is wire.CLIENT_MODE
        assert pairing_ws._ROLE is wire.ROLE

    def test_required_scopes_single_sourced(self):
        assert pairing_ws._REQUIRED_SCOPES is wire.REQUIRED_SCOPES

    def test_event_families_single_sourced(self):
        assert event_translate._APPROVAL_REQUESTED_EVENTS is wire.APPROVAL_REQUESTED_EVENTS
        assert event_translate._APPROVAL_RESOLVED_EVENTS is wire.APPROVAL_RESOLVED_EVENTS
        assert event_translate._TOOL_START_EVENTS is wire.TOOL_START_EVENTS
        assert event_translate._TOOL_END_EVENTS is wire.TOOL_END_EVENTS


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
        """准备 wiki/main 骨架：五核心分类 + domains 子树 + 私有目录/占位文件。"""
        from pathlib import Path

        root = Path(tmp_path) / 'wiki' / 'main'
        (root / 'concepts').mkdir(parents=True)
        (root / 'concepts' / 'attention.md').write_text(
            '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n',
            encoding='utf-8',
        )
        (root / 'entities').mkdir(parents=True)
        (root / 'sources').mkdir(parents=True)
        (root / 'syntheses').mkdir(parents=True)
        (root / 'reports').mkdir(parents=True)
        papers = root / 'domains' / 'cv' / 'papers'
        papers.mkdir(parents=True)
        (papers / 'resnet.md').write_text(
            '---\npaper:\n  title: ResNet\nrelated_pages: [attention]\n---\n# ResNet\n',
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

    def test_build_tree_five_core_kinds(self, tmp_path):
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        kinds = {g['kind'] for g in tree['groups']}
        assert {'concept', 'entity', 'source', 'synthesis', 'report', 'domain'} <= kinds

    def test_build_tree_lists_pages(self, tmp_path):
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        concept = next(g for g in tree['groups'] if g['kind'] == 'concept')
        paths = {p['path'] for p in concept.get('pages', [])}
        assert 'concepts/attention.md' in paths

    def test_build_tree_skips_managed_dirs_and_files(self, tmp_path):
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        tree = fs.build_tree()
        all_paths = {p['path'] for g in tree['groups'] for p in g.get('pages', [])}
        assert not any('.openclaw-wiki' in p for p in all_paths)
        assert 'index.md' not in all_paths

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
        with pytest.raises(Exception):
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
        with pytest.raises(Exception):
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
        with pytest.raises(Exception):
            fs.create_page('concepts/attention.md', 'x')

    def test_create_page_no_parent_dir_raises(self, tmp_path):
        import pytest
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(Exception):
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
        with pytest.raises(Exception):
            fs.delete_page('concepts/nope.md')

    # —— path traversal protection ——

    def test_path_traversal_rejected(self, tmp_path):
        import pytest
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(Exception):
            fs.read_page('../../../etc/passwd.md')

    def test_managed_path_rejected(self, tmp_path):
        import pytest
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(Exception):
            fs.read_page('.openclaw-wiki/cache.md')

    def test_index_md_rejected(self, tmp_path):
        import pytest
        from integration.openclaw.adapters import BindMountWikiFileSystem

        root = self._make_wiki_root(tmp_path)
        fs = BindMountWikiFileSystem(str(root))
        with pytest.raises(Exception):
            fs.read_page('index.md')
    """集成包不重复定义容器/编排域常量（issue #98 acceptance / spec #97 user story 19）。

    容器/编排域常量单一来源在 containers app（#88-90 后续统一到 containers/constants.py），
    集成包 import 之、不重复定义。守护：wire 模块与 containers 域常量名无交集。
    """

    def test_wire_shares_no_constants_with_containers_domain(self):
        import containers.config_renderer as config_renderer
        import containers.ports as ports
        import containers.runtime as runtime

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
        from integration.openclaw import ContainerRuntime

        from containers.docker_runtime import DockerRuntime

        assert isinstance(DockerRuntime(), ContainerRuntime), (
            'DockerRuntime 应满足集成包 ContainerRuntime Port'
        )

    def test_fake_runtime_satisfies_integration_port(self):
        """FakeRuntime 结构子类型自动满足集成包 ContainerRuntime Port。"""
        from integration.openclaw import ContainerRuntime

        from containers.tests.fakes import FakeRuntime

        assert isinstance(FakeRuntime(), ContainerRuntime), (
            'FakeRuntime 应满足集成包 ContainerRuntime Port'
        )

    def test_only_docker_runtime_imports_docker_sdk(self):
        """docker SDK 仍只在 Adapter 处 import docker（不变量守护，spec §5.4）。"""
        import ast
        import sys
        from pathlib import Path

        containers_dir = Path(__file__).resolve().parent.parent.parent.parent / 'containers'
        offenders: dict[str, list[str]] = {}
        # 排除 DockerRuntime 自身（唯一合法 import docker 处）
        exempt = {'docker_runtime.py'}
        excluded_stmts = {
            'noqa',  # noqa 注释允许的替代导出
        }

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
                                f'import docker' if isinstance(node, ast.Import)
                                else f'from docker import {", ".join(n.name for n in node.names)}'
                            )

        assert not offenders, (
            f'docker SDK 仍应只在 DockerRuntime import docker：'
            f'{offenders}'
        )
