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


class TestWireDoesNotRedefineContainerConstants:
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
