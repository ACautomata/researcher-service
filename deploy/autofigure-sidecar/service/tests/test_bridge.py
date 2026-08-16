# T08 契约接缝（docs/autofigure/tickets/T08-python-sidecar.md · Testing seams；预商定接缝见 T08
# 实施前报告 #17）：给定输入 → 断言 {xml, png_base64, evaluation} 形状 + PNG magic + 跨调用隔离
# 行为——纯逻辑，无真 LLM / 网络 / 浏览器。上游 pipeline 三函数由 conftest._pipeline_stub 桩化。
import base64
import json

import pytest

import autofigure.generator as gen
from bridge import PNG_SIGNATURE, generate
from conftest import CANNED_EVAL, CANNED_XML, KNOWN_PNG


def _assert_success_shape(result):
    assert result['ok'] is True
    assert isinstance(result['xml'], str)
    assert result['xml'] == CANNED_XML
    assert isinstance(result['png_base64'], str)
    png = base64.b64decode(result['png_base64'])
    assert png.startswith(PNG_SIGNATURE)  # PNG 8 字节签名（T07 契约 §5）
    assert isinstance(result['evaluation'], str)
    assert json.loads(result['evaluation']) == CANNED_EVAL


def test_success_shape_matches_t07_contract():
    """契约自测：成功响应形状与 T07 冻结契约一致（ok/xml/png_base64/evaluation）。"""
    result = generate('draw a pipeline', provider='openrouter', api_key='sk-test-1234')
    _assert_success_shape(result)


def test_failure_returns_ok_false_opaque_code(monkeypatch):
    """失败契约：pipeline 失败 → 2xx 内 {ok:false, error=<短不透明代码>}，绝不泄漏 raw 文本。"""
    def broken_png(code, output_path, attempt_repair=False, output_format=None):
        return False, 'export exploded: cairo internal error 0xDEAD'

    monkeypatch.setattr(gen, 'code_to_png', broken_png)
    result = generate('draw a pipeline', provider='openrouter', api_key='sk-test-1234')
    assert result['ok'] is False
    assert result['error'] == 'png_export_failed'
    assert 'export exploded' not in json.dumps(result)
    assert '0xDEAD' not in json.dumps(result)


def test_config_restored_to_baseline_after_generation():
    """跨调用隔离：生成后 CONFIG 恢复基线（OUTPUT_FORMAT 非 mxgraphxml、无凭证残留）。"""
    baseline = dict(gen.CONFIG)
    assert gen.CONFIG['OUTPUT_FORMAT'] == baseline['OUTPUT_FORMAT'] != 'mxgraphxml'

    result = generate('draw a pipeline', provider='openrouter', api_key='sk-test-1234')
    assert result['ok'] is True
    assert gen.CONFIG == baseline
    assert gen.CONFIG['OUTPUT_FORMAT'] == baseline['OUTPUT_FORMAT']
    assert gen.CONFIG.get('OPENROUTER_API_KEY') == baseline.get('OPENROUTER_API_KEY')


def test_cross_call_isolation_prompts_and_results(monkeypatch):
    """两次连续生成互不污染：各自 prompt 进各自 pipeline、各自产物独立、CONFIG 两次都还原。"""
    baseline = dict(gen.CONFIG)
    seen = []

    def recording_initial(paper_content, reference_figures, topic='paper', output_format=None):
        seen.append(paper_content)
        return f'<mxfile><diagram>for-{paper_content}</diagram></mxfile>'

    monkeypatch.setattr(gen, 'generate_initial_code', recording_initial)

    first = generate('prompt-A', provider='openrouter', api_key='key-A')
    second = generate('prompt-B', provider='openrouter', api_key='key-B')

    assert seen == ['prompt-A', 'prompt-B']
    assert first['xml'] == '<mxfile><diagram>for-prompt-A</diagram></mxfile>'
    assert second['xml'] == '<mxfile><diagram>for-prompt-B</diagram></mxfile>'
    assert gen.CONFIG == baseline
    assert gen.CONFIG.get('OPENROUTER_API_KEY') == baseline.get('OPENROUTER_API_KEY')


def test_stdout_suppression_prevents_credential_leak(capsys, monkeypatch):
    """凭证卫生：即使上游 pipeline 把 api_key suffix 打到 stdout，进程 stdout 也绝不含凭证
    （contextlib.redirect_stdout 抑制整个生成过程）。"""
    secret = 'sk-test-1234-abcd'

    def leaky_initial(paper_content, reference_figures, topic='paper', output_format=None):
        key = gen.CONFIG.get('OPENROUTER_API_KEY', '')
        print(f'[leaky upstream] api_key suffix: ...{key[-4:] if len(key) > 4 else "N/A"}')
        return CANNED_XML

    monkeypatch.setattr(gen, 'generate_initial_code', leaky_initial)
    result = generate('draw a pipeline', provider='openrouter', api_key=secret)

    assert result['ok'] is True
    out = capsys.readouterr().out
    assert 'abcd' not in out
    assert secret not in out
    # wire 响应也绝不含凭证
    assert secret not in json.dumps(result)


def test_invalid_prompt_and_missing_credential_fail_fast():
    """输入校验：空/超长 prompt、缺凭证 → 短不透明失败码，且不触碰 CONFIG（fail-fast）。"""
    baseline = dict(gen.CONFIG)
    assert generate('', provider='openrouter', api_key='k')['error'] == 'invalid_prompt'
    assert generate('x' * 4001, provider='openrouter', api_key='k')['error'] == 'invalid_prompt'
    assert generate('ok prompt', provider='openrouter', api_key='')['error'] == 'missing_credential'
    assert generate('ok prompt', provider='openrouter', api_key=None)['error'] == 'missing_credential'
    assert gen.CONFIG == baseline


def test_utf16_length_matches_zod_max_4000(monkeypatch):
    """契约精确等价（Spec review #1）：zod z.string().max(4000) 计 UTF-16 code units，非码点。
    emoji（增补平面，1 码点 = 2 UTF-16 单元）下必须与 T07 契约边界一致。"""
    # 2000 个 emoji = 4000 UTF-16 units（正好过 zod max(4000) 边界）→ 契约合法，应进入生成。
    seen = []

    def recording_initial(paper_content, reference_figures, topic='paper', output_format=None):
        seen.append(paper_content)
        return CANNED_XML

    monkeypatch.setattr(gen, 'generate_initial_code', recording_initial)
    boundary_ok = '😀' * 2000  # 4000 UTF-16 units
    result = generate(boundary_ok, provider='openrouter', api_key='k')
    assert result['ok'] is True
    assert seen == [boundary_ok]

    # 2001 个 emoji = 4002 UTF-16 units → 超过 zod max(4000) → invalid_prompt。
    over = generate('😀' * 2001, provider='openrouter', api_key='k')
    assert over['error'] == 'invalid_prompt'


def test_unsupported_provider_is_opaque_failure():
    """provider 配置错误 → 短不透明失败码（绝不把配置错误当成功、绝不含异常文本）。"""
    result = generate('draw a pipeline', provider='nonsense-provider', api_key='sk-test')
    assert result['ok'] is False
    assert result['error'] == 'unsupported_provider'


def test_reference_load_failure_is_opaque_failure(monkeypatch):
    """reference 加载失败 → 短不透明失败码（非敏感）。"""
    def broken_refs(paths):
        raise RuntimeError('cannot read bundled reference figure: permission denied')

    monkeypatch.setattr(gen, 'load_reference_figures', broken_refs)
    result = generate('draw a pipeline', provider='openrouter', api_key='sk-test')
    assert result['ok'] is False
    assert result['error'] == 'reference_load_failed'
