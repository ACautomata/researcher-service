# -*- coding: utf-8 -*-
"""#791 golden-file 采集器（入库版——testdata/golden/README.md 指向本脚本）。

用法：
    python3 plugins/autofigure/testdata/golden/dump-golden.py <输出 golden.json 路径> \
        [--upstream <AutoFigure-Edit clone 路径>（默认 /tmp/autofigure-edit-791）]

方法：monkeypatch 上游 LLM 调用面（capture prompt + 返回固定 fixture），真跑
ResearAI/AutoFigure-Edit 纯函数，把 prompt 文本与纯逻辑输出 dump 为 JSON——
TS 移植侧 server/test/autofigureGolden.test.ts 逐字节对照（文件存在即自动激活）。

需一次性运行外部上游代码（pip 依赖 pillow 即可，无网络调用）；差异豁免面见 README。
"""
import argparse
import json
import os
import sys

parser = argparse.ArgumentParser()
parser.add_argument('out', help='golden JSON 输出路径（提交入库）')
parser.add_argument('--upstream', default='/tmp/autofigure-edit-791', help='AutoFigure-Edit clone 路径')
args = parser.parse_args()

sys.path.insert(0, args.upstream)

# 上游顶层 import torchvision/transformers（:91-92）——二者仅服务于本地 RMBG 模型路径
#（BriaRMBG2Remover），采集路径（云 API + 纯函数）不触碰；torch 重依赖本机存在则用真身。
# 注入最小 stub 挡顶层 import（from X import Y 需模块属性存在）。
import types  # noqa: E402

for _name in ('torchvision', 'torchvision.transforms', 'transformers'):
    sys.modules[_name] = types.ModuleType(_name)
sys.modules['torchvision'].transforms = sys.modules['torchvision.transforms']
sys.modules['transformers'].AutoModelForImageSegmentation = object()

import autofigure2  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

METHOD_TEXT = """我们提出 FlowNet-3 用于多尺度特征聚合。首先，输入图像经骨干网络提取特征；
随后，SAM3 分割模块定位语义图标；最后，模板渲染器输出矢量图形。
The decoder iteratively refines the layout (max 3 fix rounds)."""

FIG_W, FIG_H = 200, 120
FIXTURE_SVG_RETURNED = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="1" y="2" width="30" height="20" fill="#808080" stroke="black"/></svg>'

captured = {'image_gen': [], 'multimodal': [], 'text': []}
# 调用上下文（fake LLM 消费——记录当前场景的尺寸/输入，capture 时并入 golden）
ctx: dict = {}


def fake_image_generation(prompt, api_key, model, base_url, provider, reference_image=None, image_size='4K'):
    captured['image_gen'].append({
        'prompt': prompt,
        'methodText': ctx.get('method_text'),
        'model': model,
        'provider': provider,
        'image_size': image_size,
        'has_reference': reference_image is not None,
    })
    img = Image.new('RGB', (FIG_W, FIG_H), (240, 240, 240))
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, 60, 50], fill=(128, 128, 128), outline=(0, 0, 0), width=2)
    return img


def fake_multimodal(contents, api_key, model, base_url, provider, max_tokens=16000, temperature=0.7):
    captured['multimodal'].append({
        'prompt': contents[0],
        'n_images': sum(1 for c in contents if not isinstance(c, str)),
        'model': model,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'figureWidth': ctx.get('figure_width'),
        'figureHeight': ctx.get('figure_height'),
        'boxlibJson': ctx.get('boxlib_json'),
        'noIconMode': ctx.get('no_icon_mode'),
        'currentSvg': ctx.get('current_svg'),
    })
    return FIXTURE_SVG_RETURNED


def fake_text(prompt, api_key, model, base_url, provider, max_tokens=16000, temperature=0.7):
    captured['text'].append({
        'prompt': prompt,
        'currentSvg': ctx.get('current_svg'),
        'errors': ctx.get('fix_errors'),
        'max_tokens': max_tokens,
        'temperature': temperature,
    })
    return '<svg><rect/></svg>'


autofigure2.call_llm_image_generation = fake_image_generation
autofigure2.call_llm_multimodal = fake_multimodal
autofigure2.call_llm_text = fake_text

work = os.path.join(os.path.dirname(args.out), '.golden-work')
os.makedirs(work, exist_ok=True)

# ---- fixtures ----
fig_path = os.path.join(work, 'figure.png')
Image.new('RGB', (FIG_W, FIG_H), (240, 240, 240)).save(fig_path)
ref_path = os.path.join(work, 'ref.png')
Image.new('RGB', (64, 64), (200, 100, 100)).save(ref_path)

# ---- 1. 生图 prompt（无参考图 / 有参考图） ----
ctx = {'method_text': METHOD_TEXT}
autofigure2.generate_figure_from_method(
    method_text=METHOD_TEXT, output_path=fig_path, api_key='sk-test', model='img-model-x',
    base_url='https://img.example/v1', provider='bianxie', enable_upscale=False,
)
ctx = {'method_text': METHOD_TEXT}
autofigure2.generate_figure_from_method(
    method_text=METHOD_TEXT, output_path=fig_path, api_key='sk-test', model='img-model-x',
    base_url='https://img.example/v1', provider='bianxie', use_reference_image=True,
    reference_image_path=ref_path, enable_upscale=False,
)

# ---- 2. boxlib fixture（两 box 场景） ----
boxes_fixture = {
    'image_size': {'width': FIG_W, 'height': FIG_H},
    'prompts_used': ['icon', 'robot'],
    'boxes': [
        {'id': 0, 'label': '<AF>01', 'x1': 10, 'y1': 5, 'x2': 70, 'y2': 45, 'score': 0.91, 'prompt': 'icon'},
        {'id': 1, 'label': '<AF>02', 'x1': 100, 'y1': 60, 'x2': 150, 'y2': 110, 'score': 0.77, 'prompt': 'robot'},
    ],
    'no_icon_mode': False,
}
boxlib_path = os.path.join(work, 'boxlib.json')
with open(boxlib_path, 'w', encoding='utf-8') as f:
    json.dump(boxes_fixture, f, indent=2, ensure_ascii=False)
boxlib_content = open(boxlib_path, encoding='utf-8').read()

samed_path = os.path.join(work, 'samed.png')
img = Image.new('RGB', (FIG_W, FIG_H), (240, 240, 240))
d = ImageDraw.Draw(img)
d.rectangle([10, 5, 70, 45], fill=(128, 128, 128), outline=(0, 0, 0), width=3)
d.rectangle([100, 60, 150, 110], fill=(128, 128, 128), outline=(0, 0, 0), width=3)
img.save(samed_path)

# ---- 3. 步骤 4 prompt 三变体 ----
ctx = {'figure_width': FIG_W, 'figure_height': FIG_H, 'no_icon_mode': False, 'boxlib_json': boxlib_content}
autofigure2.generate_svg_template(
    figure_path=fig_path, samed_path=samed_path, boxlib_path=boxlib_path,
    output_path=os.path.join(work, 'template.svg'), api_key='sk-test', model='svg-model-x',
    base_url='https://llm.example/v1', provider='bianxie', placeholder_mode='label', no_icon_mode=False,
)
ctx = {'figure_width': FIG_W, 'figure_height': FIG_H, 'no_icon_mode': False, 'boxlib_json': boxlib_content}
autofigure2.generate_svg_template(
    figure_path=fig_path, samed_path=samed_path, boxlib_path=boxlib_path,
    output_path=os.path.join(work, 'template_box.svg'), api_key='sk-test', model='svg-model-x',
    base_url='https://llm.example/v1', provider='bianxie', placeholder_mode='box', no_icon_mode=False,
)
ctx = {'figure_width': FIG_W, 'figure_height': FIG_H, 'no_icon_mode': True, 'boxlib_json': boxlib_content}
autofigure2.generate_svg_template(
    figure_path=fig_path, samed_path=samed_path, boxlib_path=boxlib_path,
    output_path=os.path.join(work, 'template_ni.svg'), api_key='sk-test', model='svg-model-x',
    base_url='https://llm.example/v1', provider='bianxie', placeholder_mode='label', no_icon_mode=True,
)

# ---- 4. fix prompt（注入固定 errors，规避 parser 差异） ----
BAD_SVG = '<svg width="10"><rect x="1"</svg>'
INJECTED_ERRORS = ['行 2, 列 15: attributes construct error', '行 2, 列 21: Expected >, but got: <']

real_validate = autofigure2.validate_svg_syntax


def staged_validate(svg_code):
    if svg_code == BAD_SVG:
        return False, list(INJECTED_ERRORS)
    return True, []


autofigure2.validate_svg_syntax = staged_validate
ctx = {'current_svg': BAD_SVG, 'fix_errors': INJECTED_ERRORS}
autofigure2.check_and_fix_svg(
    svg_code=BAD_SVG, api_key='sk-test', model='svg-model-x',
    base_url='https://llm.example/v1', provider='bianxie',
)
autofigure2.validate_svg_syntax = real_validate

# ---- 5. optimize prompt（monkeypatch svg_to_png；skip_base64_validation=True 同上游主编排） ----
template_path = os.path.join(work, 'template.svg')
with open(template_path, 'w', encoding='utf-8') as f:
    f.write(FIXTURE_SVG_RETURNED)
rendered_png = os.path.join(work, 'rendered.png')
Image.new('RGB', (FIG_W, FIG_H), (255, 255, 255)).save(rendered_png)
# 上游 optimize 内部直接 Image.open(svg_to_png 的 output_path 实参)——stub 须把 fixture 写到该路径
import shutil  # noqa: E402


def _fake_svg_to_png(svg_path, output_path, scale=1.0):
    shutil.copyfile(rendered_png, output_path)
    return output_path


autofigure2.svg_to_png = _fake_svg_to_png

ctx = {'current_svg': FIXTURE_SVG_RETURNED, 'no_icon_mode': False}
autofigure2.optimize_svg_with_llm(
    figure_path=fig_path, samed_path=samed_path, final_svg_path=template_path,
    output_path=os.path.join(work, 'optimized.svg'), api_key='sk-test', model='svg-model-x',
    base_url='https://llm.example/v1', provider='bianxie', max_iterations=2,
    skip_base64_validation=True, no_icon_mode=False,
)
ctx = {'current_svg': FIXTURE_SVG_RETURNED, 'no_icon_mode': True}
autofigure2.optimize_svg_with_llm(
    figure_path=fig_path, samed_path=samed_path, final_svg_path=template_path,
    output_path=os.path.join(work, 'optimized_ni.svg'), api_key='sk-test', model='svg-model-x',
    base_url='https://llm.example/v1', provider='bianxie', max_iterations=1,
    skip_base64_validation=True, no_icon_mode=True,
)

# ---- 6. 图标替换（五策略链一网打尽） ----
icon_paths = []
for c in [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]:
    p = os.path.join(work, 'icon_%d.png' % len(icon_paths))
    Image.new('RGBA', (12, 10), c + (255,)).save(p)
    icon_paths.append(p)

REPLACE_TEMPLATE = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">'
    '<g id="AF01" transform="translate(5, 5)"><rect x="5" y="0" width="60" height="40" fill="#808080" stroke="black" stroke-width="2"/><text x="35" y="20" fill="white">&lt;AF&gt;01</text></g>'
    '<rect x="100" y="60" width="50" height="50" fill="#808080" stroke="black"/>'
    '<text x="125" y="85" text-anchor="middle" fill="white">&lt;AF&gt;02</text>'
    '<rect x="20" y="70" width="40" height="30" fill="#808080" stroke="black" stroke-width="2"/>'
    '<rect x="0" y="0" width="199" height="119" fill="none"/>'
    '</svg>'
)
replace_template_path = os.path.join(work, 'replace_input.svg')
with open(replace_template_path, 'w', encoding='utf-8') as f:
    f.write(REPLACE_TEMPLATE)

import base64 as b64mod  # noqa: E402


def icon_png_b64(p):
    return b64mod.b64encode(open(p, 'rb').read()).decode('utf-8')


# 上游消费形状（nobg_path 文件路径 + x1/y1/x2/y2）；golden 记录 TS 消费形状（nobgPngB64 + width/height）
_replace_up = [
    {'id': 0, 'label': '<AF>01', 'label_clean': 'AF01', 'x1': 10, 'y1': 5, 'x2': 70, 'y2': 45, 'width': 60, 'height': 40, 'nobg_path': icon_paths[0]},
    {'id': 1, 'label': '<AF>02', 'label_clean': 'AF02', 'x1': 100, 'y1': 60, 'x2': 150, 'y2': 110, 'width': 50, 'height': 50, 'nobg_path': icon_paths[1]},
    {'id': 2, 'label': '<AF>03', 'label_clean': 'AF03', 'x1': 20, 'y1': 70, 'x2': 60, 'y2': 100, 'width': 40, 'height': 30, 'nobg_path': icon_paths[2]},
    {'id': 3, 'label': '<AF>04', 'label_clean': 'AF04', 'x1': 160, 'y1': 10, 'x2': 190, 'y2': 40, 'width': 30, 'height': 30, 'nobg_path': icon_paths[3]},
]
replace_icons = [
    {'label': '<AF>01', 'labelClean': 'AF01', 'x1': 10, 'y1': 5, 'width': 60, 'height': 40, 'nobgPngB64': icon_png_b64(icon_paths[0])},
    {'label': '<AF>02', 'labelClean': 'AF02', 'x1': 100, 'y1': 60, 'width': 50, 'height': 50, 'nobgPngB64': icon_png_b64(icon_paths[1])},
    {'label': '<AF>03', 'labelClean': 'AF03', 'x1': 20, 'y1': 70, 'width': 40, 'height': 30, 'nobgPngB64': icon_png_b64(icon_paths[2])},
    {'label': '<AF>04', 'labelClean': 'AF04', 'x1': 160, 'y1': 10, 'width': 30, 'height': 30, 'nobgPngB64': icon_png_b64(icon_paths[3])},
]
replace_final_path = os.path.join(work, 'final_golden.svg')
autofigure2.replace_icons_in_svg(
    template_svg_path=replace_template_path, icon_infos=_replace_up,
    output_path=replace_final_path, scale_factors=(1.0, 1.0), match_by_label=True,
)

# ---- 7. 保底 embedded SVG ----
embedded_path = os.path.join(work, 'embedded.svg')
autofigure2.create_embedded_figure_svg(figure_path=fig_path, output_path=embedded_path)

# ---- 8. SAM3 解析 / 合并 / parity cases ----
fal_metadata_resp = {
    'metadata': [
        {'box': [0.2, 0.25, 0.3, 0.5], 'score': 0.93},
        {'box': [0.7, 0.75, 0.2, 0.1], 'score': 0.55},
        {'box': [0.5, 0.5, 0.0, 0.5], 'score': 0.9},
    ]
}
fal_boxes_resp = {
    'boxes': [[0.25, 0.25, 0.5, 0.5], [0.75, 0.5, 0.1, 0.2]],
    'scores': [0.88, 0.42],
}
roboflow_resp = {
    'prompt_results': [
        {
            'predictions': [
                {'confidence': 0.81, 'masks': [[[10, 20], [80, 20], [80, 90], [10, 90]]]},
                {'confidence': 0.6, 'masks': [[[5, 5], [40, 5], [40, 40]]]},
            ]
        }
    ]
}

golden = {
    'image_prompt_no_ref': captured['image_gen'][0],
    'image_prompt_with_ref': captured['image_gen'][1],
    'template_prompt_label': captured['multimodal'][0],
    'template_prompt_box': captured['multimodal'][1],
    'template_prompt_no_icon': captured['multimodal'][2],
    'fix_prompt': captured['text'][0],
    'fix_prompt_injected_errors': INJECTED_ERRORS,
    'fix_prompt_bad_svg': BAD_SVG,
    # optimize：label 场景两轮迭代（轮 2 prompt 含轮 1 返回的 FIXTURE_SVG_RETURNED），no_icon 一轮
    'optimize_prompts_label': captured['multimodal'][3:5],
    'optimize_prompt_no_icon': captured['multimodal'][5:6],
    'sam3_fal_metadata': [
        {'box': [0.2, 0.25, 0.3, 0.5], 'imageW': FIG_W, 'imageH': FIG_H,
         'xyxy': list(autofigure2._cxcywh_norm_to_xyxy([0.2, 0.25, 0.3, 0.5], FIG_W, FIG_H))},
        {'box': [0.7, 0.75, 0.2, 0.1], 'imageW': FIG_W, 'imageH': FIG_H,
         'xyxy': list(autofigure2._cxcywh_norm_to_xyxy([0.7, 0.75, 0.2, 0.1], FIG_W, FIG_H))},
    ],
    'sam3_fal_resp': fal_metadata_resp,
    'sam3_fal_detections': autofigure2._extract_sam3_api_detections(fal_metadata_resp, (FIG_W, FIG_H)),
    'sam3_roboflow_resp': roboflow_resp,
    'sam3_roboflow_detections': autofigure2._extract_roboflow_detections(roboflow_resp, (FIG_W, FIG_H)),
    'replace': {
        'template': REPLACE_TEMPLATE,
        'icons': replace_icons,
        'scaleFactors': [1.0, 1.0],
        'matchByLabel': True,
        'finalSvg': open(replace_final_path, encoding='utf-8').read(),
    },
    'embedded': {
        'b64': b64mod.b64encode(open(fig_path, 'rb').read()).decode('utf-8'),
        'width': FIG_W,
        'height': FIG_H,
        'svg': open(embedded_path, encoding='utf-8').read(),
    },
    'merge_boxes': {
        'input': [
            {'id': 0, 'label': '<AF>01', 'x1': 0, 'y1': 0, 'x2': 100, 'y2': 100, 'score': 0.9, 'prompt': 'icon'},
            {'id': 1, 'label': '<AF>02', 'x1': 5, 'y1': 5, 'x2': 105, 'y2': 105, 'score': 0.7, 'prompt': 'robot'},
            {'id': 2, 'label': '<AF>03', 'x1': 200, 'y1': 200, 'x2': 260, 'y2': 260, 'score': 0.6, 'prompt': 'person'},
        ],
        'threshold': 0.9,
        'expected': autofigure2.merge_overlapping_boxes([
            {'id': 0, 'label': '<AF>01', 'x1': 0, 'y1': 0, 'x2': 100, 'y2': 100, 'score': 0.9, 'prompt': 'icon'},
            {'id': 1, 'label': '<AF>02', 'x1': 5, 'y1': 5, 'x2': 105, 'y2': 105, 'score': 0.7, 'prompt': 'robot'},
            {'id': 2, 'label': '<AF>03', 'x1': 200, 'y1': 200, 'x2': 260, 'y2': 260, 'score': 0.6, 'prompt': 'person'},
        ], 0.9),
    },
    'extract_svg': [
        {'input': 'before <svg A>1</svg> after', 'expected': autofigure2.extract_svg_code('before <svg A>1</svg> after')},
        {'input': '```svg\n<svg B>2</svg>\n```', 'expected': autofigure2.extract_svg_code('```svg\n<svg B>2</svg>\n```')},
        {'input': '  <svg C>3</svg>', 'expected': autofigure2.extract_svg_code('  <svg C>3</svg>')},
        {'input': 'no svg here', 'expected': autofigure2.extract_svg_code('no svg here')},
        {'input': '<SVG D>4</SVG>', 'expected': autofigure2.extract_svg_code('<SVG D>4</SVG>')},
    ],
    'parity_cases': [
        {'fn': 'overlap',
         'a': {'x1': 0, 'y1': 0, 'x2': 100, 'y2': 100, 'score': 0.9},
         'b': {'x1': 5, 'y1': 5, 'x2': 105, 'y2': 105, 'score': 0.7},
         'expected': autofigure2.calculate_overlap_ratio(
             {'x1': 0, 'y1': 0, 'x2': 100, 'y2': 100}, {'x1': 5, 'y1': 5, 'x2': 105, 'y2': 105})},
        {'fn': 'svgDims', 'svg': '<svg viewBox="0 0 200 120" width="400" height="240"><rect/></svg>',
         'expected': list(autofigure2.get_svg_dimensions('<svg viewBox="0 0 200 120" width="400" height="240"><rect/></svg>'))},
        {'fn': 'svgDims', 'svg': '<svg width="640.5px" height="480px"/>',
         'expected': list(autofigure2.get_svg_dimensions('<svg width="640.5px" height="480px"/>'))},
        {'fn': 'svgDims', 'svg': '<svg><rect/></svg>',
         'expected': list(autofigure2.get_svg_dimensions('<svg><rect/></svg>'))},
        {'fn': 'scale', 'args': [200, 120, 400.0, 240.0], 'expected': list(autofigure2.calculate_scale_factors(200, 120, 400.0, 240.0))},
        {'fn': 'countBase64',
         'svg': '<svg><image href="data:image/png;base64,' + 'QUJD' * 40 + '"/></svg>',
         'expected': autofigure2.count_base64_images('<svg><image href="data:image/png;base64,' + 'QUJD' * 40 + '"/></svg>')},
        {'fn': 'validateBase64',
         'svg': '<svg><image href="data:image/png;base64,' + 'QUJD' * 40 + '"/><image xlink:href="data:image/jpeg;base64,' + 'WQ==' * 50 + '"/></svg>',
         'n': 2,
         'expected': list(autofigure2.validate_base64_images(
             '<svg><image href="data:image/png;base64,' + 'QUJD' * 40 + '"/><image xlink:href="data:image/jpeg;base64,' + 'WQ==' * 50 + '"/></svg>', 2))},
        {'fn': 'polygonToBbox', 'points': [[10, 20], [80, 20], [80, 90], [10, 90]],
         'expected': autofigure2._polygon_to_bbox([[10, 20], [80, 20], [80, 90], [10, 90]], FIG_W, FIG_H)},
    ],
}

with open(args.out, 'w', encoding='utf-8') as f:
    json.dump(golden, f, indent=2, ensure_ascii=False)
print('golden written:', args.out)
for k in golden:
    v = golden[k]
    print(' -', k, type(v).__name__, len(v) if hasattr(v, '__len__') else '')
