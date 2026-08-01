"""回归测试：integration conftest 的 session 级 bootstrap 必须默认自动执行 setup。

契约：跑 ``tests/integration/`` 目录任何 case 前，``integration_bootstrap`` fixture
须**自动**补齐缺失的 bootstrap 依赖（playwright 客户端 / chromium / frontend vite）——
用户不应需要加 ``--integration-setup`` 之类参数才能触发（#261 后重构为默认自动）。
若有朝一日有人把 setup 改回「缺依赖即报错、不加参数不装」，本测试在 backend-unit job
（每次 push、无 playwright）即红，早于任何真 integration 运行。

源真相：``conftest.integration_bootstrap`` + ``conftest._prepare_bootstrap`` —— 经
importlib 按 path 加载 conftest（对齐 ``test_conftest_teardown.py`` 的既有 seam），
不触发 playwright 顶部 import，也无需真环境/浏览器。
"""
import importlib.util
import inspect
from pathlib import Path

# backend/tests/test_integration_bootstrap_auto.py -> backend/tests/ -> backend/
_CONFTEST = Path(__file__).resolve().parent / 'integration' / 'conftest.py'


def _load_module(name):
    """按 path 加载 conftest 模块（不执行其 fixture/子进程，仅取函数对象）。"""
    spec = importlib.util.spec_from_file_location(name, _CONFTEST)
    assert spec is not None and spec.loader is not None, f'无法加载 {_CONFTEST}'
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fixture_function_body(mod, fixture_name, func_name):
    """取 fixture 工厂函数的源码体（剥离 @pytest.fixture 装饰器后的 def 语句）。"""
    src = inspect.getsource(getattr(mod, fixture_name))
    lines = src.splitlines()
    # 跳过装饰器（@pytest.fixture(...)），定位 def <func_name>
    def_idx = next(i for i, line in enumerate(lines) if line.strip().startswith(f'def {func_name}'))
    return inspect.cleandoc('\n'.join(lines[def_idx + 1:]))


def test_bootstrap_fixture_calls_prepare_without_flag():
    """integration_bootstrap 必须无条件调用 _prepare_bootstrap（默认自动 setup）。"""
    mod = _load_module('integration_conftest_bootstrap_under_test')
    assert hasattr(mod, '_prepare_bootstrap'), '_prepare_bootstrap 已不存在于 conftest'
    body = _fixture_function_body(mod, 'integration_bootstrap', 'integration_bootstrap')
    # fixture 工厂体直接调用 _prepare_bootstrap —— 不依赖 --integration-setup 选项
    assert '_prepare_bootstrap()' in body
    # 工厂签名不得再依赖 request（旧实现经 request.config.getoption('--integration-setup')）
    sig = inspect.signature(mod.integration_bootstrap)
    assert not any(p.name == 'request' for p in sig.parameters.values()), (
        'integration_bootstrap 依赖 request 参数（旧 opt-in 实现残留），应无条件 _prepare_bootstrap'
    )


def test_no_integration_setup_flag_registered():
    """``--integration-setup`` 选项必须已删除（默认自动 setup，无需 opt-in 参数）。

    断言 pytest_addoption 不再注册该 flag：残留它会给用户留下「不传就不装」的误导信号。
    """
    mod = _load_module('integration_conftest_flag_under_test')
    assert not hasattr(mod, 'pytest_addoption'), (
        'pytest_addoption 仍存在——若仍注册 --integration-setup，应删除'
    )


def test_prepare_bootstrap_docstring_says_auto():
    """_prepare_bootstrap 文档应说明默认自动补齐（反映新契约）。"""
    mod = _load_module('integration_conftest_prepare_under_test')
    doc = inspect.getdoc(mod._prepare_bootstrap) or ''
    assert '自动补齐' in doc, '_prepare_bootstrap 文档未反映「默认自动补齐」契约'
