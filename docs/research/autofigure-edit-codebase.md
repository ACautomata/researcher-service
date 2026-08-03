# P0 — AutoFigure-Edit 代码深读（issue #348）

> 目标：为「P3 契约设计」和「T4 iframe 改写」提供**事实基础**——精确端点、模型调用点、数据流、改动面。
> 信源：primary-source 深读 `ResearAI/AutoFigure-Edit`（HEAD `16f3749`，tag `v1.1`），clone 于 `/tmp/autofigure-edit-348`。所有行号均指该 clone 的源码，非臆测。
> 与 ticket 描述的差异先在此说明：ticket 所说「生图 Gemini→MiniMax image-01、SVG 重建→Deepseek-v4-flash」是**整合方案要做的替换**，仓库现状生图默认是 `gemini-3.1-flash-image-preview` / `gpt-image-2`，SVG 重建默认是 `gemini-3.1-pro-preview` / `gpt-5.5`（见 §5）。仓库里**没有** MiniMax / Deepseek 的任何引用。

---

## 0. 结论速览（一句话）

AutoFigure-Edit 是一个**单体 FastAPI（server.py，738 行）+ 纯函数流水线（autofigure2.py，3747 行）**：`/api/run` 起子进程跑 `autofigure2.py`，靠 **SSE 事件流 + 磁盘 outputs 目录扫描** 回传进度与产物；模型调用有**统一三入口分发层**（text/multimodal/image），换模型只需改 provider 表与默认模型名，无需重构 adapter；前端 `web/` 是纯静态多页 JS（`app.js` 2406 行），**7 处裸 fetch 散落各页、无集中封装、无 postMessage 桥**，画布 iframe（svg-edit）靠同源直接函数调用注入 SVG。

---

## 1. 概览：仓库结构与职责

```
AutoFigure-Edit (16f3749, v1.1)
├── server.py                  FastAPI 控制面：端点、子进程任务管理(Job/SSE)、产物/历史扫描、静态托管 web/
├── autofigure2.py             纯函数流水线（CLI 入口）：步骤1-5 + LLM provider 适配 + SAM3/RMBG
├── requirements.txt           fastapi/uvicorn/openai/google-genai/torch/transformers/cairosvg/lxml 等
├── Dockerfile                 python:3.11-slim，pip 装依赖，uvicorn 起 server:app（8000）
├── docker-compose.yml         单服务，挂 outputs/uploads + hf_cache，注入 HF_TOKEN/ROBOFLOW_API_KEY/FAL_KEY 等
├── .env.example               SAM/OpenAI/HF/自定义 base_url/镜像源 环境变量样例
├── web/                       静态前端（由 server.py:703 StaticFiles 托管）
│   ├── index.html             配置页（主流程：method text → provider/模型/SAM/参考图）
│   ├── import.html            导入页（跳过步骤1，上传 stage-1 图片直接 SAM+SVG）
│   ├── canvas.html            画布页（iframe 嵌 svg-edit + 产物抽屉 + 日志面板）
│   ├── history.html           历史页（浏览 outputs/ 下的历史 job）
│   ├── guide.html             静态配置指南页（纯 i18n 文案）
│   ├── app.js                 全部前端逻辑（每页 initXxxPage()，含全部后端调用）
│   ├── styles.css             样式
│   └── vendor/svg-edit/       vendored SVG-Edit 编辑器（18MB，editor/index.html 是 iframe 加载入口）
├── outputs/                   运行产物（运行时创建；figure.png/samed.png/template.svg/final.svg/icons/...）
├── uploads/                   上传的参考图 / stage-1 图（运行时创建）
├── img/                       文档插图
└── releases/v1.1.md           v1.1 发布说明（导入工作流 + OpenAI 官方支持 + 便携AI/custom 路由）
```

核心分层：**server.py 只做「进程编排 + 文件观察 + HTTP/SSE」**，业务全在 autofigure2.py（子进程内运行）。两边通过 **CLI 参数**（server.py:193-256）和 **磁盘文件**（outputs/{job_id}/）通信。

---

## 2. FastAPI 端点清单（server.py）

> `app.mount("/", StaticFiles(web, html=True))` 在 server.py:703，挂在所有路由之后——API 路由优先匹配，未命中再落到静态文件。**无 CORS 中间件、无鉴权**（全仓库无 CORSMiddleware/登录）。

| 方法 | 路径 | 请求 | 响应 | 后端函数 / 备注 |
|---|---|---|---|---|
| GET | `/healthz` | – | `{"status":"ok"}` | `server.py:139-141`；compose healthcheck 用 |
| GET | `/api/config` | – | `{"svgEditAvailable":bool, "svgEditPath":"/vendor/svg-edit/editor/index.html"或null}` | `server.py:144-147`；`_resolve_svg_edit_path()` 47-51 探测 vendor 是否在 |
| GET | `/api/history` | query `limit`(默认200, 上限1000) | `{"items":[...], "count":N}` | `server.py:150-160`；扫 `outputs/*` 目录，按最新 mtime 倒序；每项由 `_build_history_item` 生成 |
| GET | `/api/history/{job_id}` | – | 单条 history item 或 404 | `server.py:163-168` |
| GET | `/api/history/{job_id}/artifacts/{path:path}` | – | FileResponse | `server.py:171-176`；`_artifact_file_response` 372-380（防目录穿越） |
| POST | `/api/run` | `RunRequest` JSON（见下） | `{"job_id":"YYYYmmdd_HHMMSS_<8hex>"}` | `server.py:179-288`；**同步返回 job_id，异步执行**（起子进程） |
| POST | `/api/upload` | multipart `file`（图片，≤20MB） | `{"path":"uploads/<uuid>.png", "url":"/api/uploads/<name>", "name":orig}` | `server.py:291-313`；校验 content_type 以 `image/` 开头 |
| GET | `/api/events/{job_id}` | – | **SSE 流**（`text/event-stream`） | `server.py:316-334`；只对 in-memory `JOBS`（:113）里的活任务有效，历史任务报 404 |
| GET | `/api/artifacts/{job_id}/{path:path}` | – | FileResponse | `server.py:337-343`；活任务取 job.output_dir，否则回退 `_resolve_output_dir` 扫磁盘 |
| GET | `/api/uploads/{filename}` | – | FileResponse | `server.py:346-353`；限定 uploads/ 内 |
| GET | `/`(静态) | – | web/ 下 html | `server.py:703` |

### `RunRequest` 字段（server.py:88-108）→ CLI 参数映射

| 字段 | 默认 | 映射 |
|---|---|---|
| `method_text` | null | `--method_text`（与 input_figure_path 二选一，server.py:181-187） |
| `input_figure_path` | null | `--input_figure_path`（相对路径以 BASE_DIR 解析，:203-209） |
| `provider` | "bianxie" | `--provider` |
| `api_key` / `base_url` | null | `--api_key` / `--base_url` |
| `image_provider` / `image_api_key` / `image_base_url` | null | 对应 CLI 参数 |
| `image_model` / `image_size` | null / null | `--image_model` / `--image_size` |
| `enable_upscale` | null | `false` → `--disable_auto_upscale`（:225-226） |
| `svg_model` | null | `--svg_model` |
| `sam_prompt` | 默认 `"icon,person,robot,animal"`(server.py:34) | `--sam_prompt`（:236） |
| `sam_backend` | null | `--sam_backend`（:239-240） |
| `sam_api_key` / `sam_max_masks` | null | `--sam_api_key` / `--sam_max_masks` |
| `placeholder_mode` | `"label"` | `--placeholder_mode`（:237） |
| `merge_threshold` | 0.01 (server.py:36) | `--merge_threshold`（:238） |
| `optimize_iterations` | null | `--optimize_iterations`（:245-246） |
| `reference_image_path` | null | `--reference_image_path`（:248-255） |

注意两个默认值不一致：**server.py:34-36 的默认 SAM prompt/merge 与前端 index.html:207 的默认（`icon,person,robot,animal`）一致，但 autofigure2.py CLI 默认是 `icon,robot,animal,person` / `0.001` / `0.9`**（见 §6）。server 侧总是显式传值（`sam_prompt = req.sam_prompt or DEFAULT_SAM_PROMPT`，:230-234），所以实际以 server 默认与前端为准。

### 任务执行与 SSE 事件（关键机制）

- **提交**：`/api/run` 生成 job_id、建 `outputs/{job_id}/`、写 `run.log` 首行 meta（python + **脱敏 cmd**，`_redact_cmd_args` :54-65 隐藏 `--api_key/--image_api_key/--sam_api_key` 值），`subprocess.Popen(autofigure2.py ..., stdout/stderr=PIPE, cwd=BASE_DIR)`（:257-274），启 monitor 线程后立即返回 job_id。
- **SSE 事件类型**（`_monitor_job` :480-517 + `_pipe_output` :520-528 + `_scan_artifacts` :531-554）：
  - `status`：`{state:"started"}`（:481）→ `{state:"finished", code:<exit_code>}`（:506）；`code!=0` 即失败。
  - `artifact`：磁盘上**新出现**的产物文件（:553），payload 见 `_artifact_payload`（:468-477）：`{kind,name,path,url,updated_at,size}`，url 形如 `/api/artifacts/{job_id}/{rel_path}`。扫描轮询 0.5s（:492-503），进程结束后再扫一轮（:505）。
  - `log`：`{stream:"stdout"|"stderr", line}`（:526-527），逐行转发子进程输出。
  - `close`：流结束（:517）。
- **产物清单**（`_scan_artifacts` :533-539 + history 的 `HISTORY_ARTIFACT_ORDER` :114-122）：`figure.png`、`samed.png`、`template.svg`、`optimized_template.svg`、`final.svg`、`icons/icon_*.png`、`run.log`、`boxlib.json`。
- **artifact kind 分类**（`_classify_artifact` :556-575）：`figure` / `samed` / `icon_raw`(`icons/…_nobg.png` 之外) / `icon_nobg` / `template_svg` / `optimized_template_svg` / `final_svg` / `boxlib` / `log` / `artifact`。
- **history item 结构**（`_build_history_item` :404-443）：`{job_id, created_at, updated_at, status:"complete"|"partial"(看有没有 final_svg), artifact_count, thumbnail_url, thumbnail_kind, primary_artifact, open_url:"/canvas.html?job=…&source=history", artifacts[]}`。
- **端口自管理**（:578-701）：启动时从 8000 起找空闲端口；若占用则用 lsof/ss/netstat 找出占用进程，**只杀 uvicorn 进程**（`_is_uvicorn_process` :645-651），再 SIGTERM→SIGKILL。单实例部署，没有多 worker。

---

## 3. 流水线 4 阶段（autofigure2.py）

入口 `method_to_svg()`（autofigure2.py:3191-3544）按序调用各阶段；**阶段间全部通过 `outputs/{job_id}/` 磁盘文件传参**，函数间只传路径字符串。`stop_after=1..5` 可在每阶段后停（:3345/:3377/:3404/:3459）。

```
method_text / input_figure_path
   │
   ▼
[步骤1] generate_figure_from_method (1291-1409) 或 prepare_imported_figure (1258-1289)
   │  产物: figure.png  (3326)   4K 长边放大(1231-1245, 默认开)
   ▼
[步骤2] segment_with_sam3 (1891-2145)
   │  产物: samed.png (2129) + boxlib.json (2140, {image_size, prompts_used, boxes[], no_icon_mode})
   │  后端: local(1942-1990) / fal(1992-2024) / roboflow(2025-2056)，多 prompt 各自检测合并
   ▼
[步骤3] crop_and_remove_background (2266-2328)
   │  产物: icons/icon_AF01.png(裁切,2307) + icon_AF01_nobg.png(去背景,2261)   → icon_infos[] (2312-2320)
   │  (no_icon_mode 即 SAM 无命中时跳过本步，3393-3394)
   ▼
[步骤4] generate_svg_template (2335-2481)
   │  产物: template.svg (2419-2420)   多模态 LLM 复刻图 + 占位符
   │   ├─ 4.5 check_and_fix_svg (2619-2646): lxml 校验(2508-2533) + fix_svg_with_llm(2536-2616, 最多3次)
   │   └─ 4.6 optimize_svg_with_llm (2972-3184, 迭代=optimize_iterations, 0 则直接复制 3013-3019)
   │       产物: optimized_template.svg (3420); 每次迭代经 svg_to_png(2947-2969,cairosvg) 渲染当前 SVG 作多模态输入
   ▼
[步骤5] replace_icons_in_svg (2707-2915)
   │  产物: final.svg (3421)
   │  4.7 坐标系对齐 get_svg_dimensions(2653-2688)/calculate_scale_factors(2691-2700): SVG 尺寸 vs figure.png 算 scale
   │  替换策略: label模式按 <g id="AF01"> 序号匹配(2749-2810) → <text>邻近rect(2813-2855) → 坐标精确/近似(2858-2893) → 追加末尾(2895-2906)
   │
   └─(no_icon_mode 且 SVG 重建失败) create_embedded_figure_svg (3547-3571): 内嵌 figure.png 的保底 SVG
```

### 3.1 各阶段函数签名与输入输出

| 阶段 | 函数 | 签名要点 | 输入 → 输出 |
|---|---|---|---|
| 1 | `generate_figure_from_method` (1291-1409) | `(method_text, output_path, api_key, model, base_url, provider, use_reference_image, reference_image_path, image_size="4K", enable_upscale=True)` | method_text → figure.png 路径；失败 raise（img None，:1388-1389） |
| 1' | `prepare_imported_figure` (1258-1289) | `(input_figure_path, output_path, enable_upscale=True)` | 导入图 exif 归一 + 可选 4K 放大 → figure.png |
| 2 | `segment_with_sam3` (1891-2145) | `(image_path, output_dir, text_prompts="icon", min_score=0.5, merge_threshold=0.9, sam_backend="local", sam_api_key, sam_max_masks=32)` | figure.png → `(samed_path, boxlib_path, valid_boxes[])`；box 字段 `{id,label:<AF>xx,x1,y1,x2,y2,score,prompt}` |
| 3 | `crop_and_remove_background` (2266-2328) | `(image_path, boxlib_path, output_dir, rmbg_model_path)` | figure.png+boxlib.json → `icon_infos[]`（含 crop_path/nobg_path/坐标/尺寸）；无 box 时返回 [] |
| 4 | `generate_svg_template` (2335-2481) | `(figure_path, samed_path, boxlib_path, output_path, api_key, model, base_url, provider, placeholder_mode="label", no_icon_mode=False)` | 双图多模态 → template.svg 路径；空响应/无 SVG 均 raise（:2454-2463） |
| 4.6 | `optimize_svg_with_llm` (2972-3184) | `(figure_path, samed_path, final_svg_path, output_path, api_key, model, base_url, provider, max_iterations=2, skip_base64_validation, no_icon_mode)` | 3 图(原图+samed+当前SVG渲染PNG)多模态 → optimized_template.svg |
| 5 | `replace_icons_in_svg` (2707-2915) | `(template_svg_path, icon_infos, output_path, scale_factors=(1.0,1.0), match_by_label=True)` | template/optimized + icons → final.svg（图标 base64 内嵌 `<image href="data:image/png;base64,…">`） |

### 3.2 阶段间数据传递与失败行为

- **全部文件传递**：每阶段读磁盘产物、写下一阶段输入；内存中只有本阶段内加载的 PIL Image / SVG 字符串（如 generate_svg_template 内 `contents=[prompt_text, figure_img, samed_img]`，:2441）。
- **no_icon_mode 回退链**：SAM 无命中(`len(valid_boxes)==0`，:3371) → 步骤3跳过 → 步骤4 用「像素级复现、禁止占位符」prompt（:2371-2392）→ 若步骤4+4.6 抛异常且是 no_icon_mode，则**不向上抛**，改 `create_embedded_figure_svg` 保底（:3450-3457）；非 no_icon_mode 异常直接向上抛 → 子进程非零退出。
- **步骤 4.6 优化失败不致命**：单次迭代异常 `continue`（:3163-3165）；base64 图片数校验不过则**拒绝该次优化、保留上一版本**（:3152-3157）。
- **子进程级失败**：异常 traceback 走 stderr → server `_pipe_output` 转成 `log` SSE 事件 + run.log；`status finished code≠0`。**没有重试**（除 OpenRouter 多模态与 Roboflow 自带重试，见 §4）。

---

## 4. 模型调用点（**契约设计要代理的对象，需非常精确**）

### 4.0 统一分发层（换模型的入口）

所有 LLM 调用都经过 **3 个统一函数**，按 provider 字符串分发：

- `call_llm_text(prompt, api_key, model, base_url, provider, max_tokens=16000, temperature=0.7)` — autofigure2.py:196-228。bianxie/custom→OpenAI-compatible；gemini→Gemini；openai_response→Responses；否则 OpenRouter。
- `call_llm_multimodal(contents, api_key, model, base_url, provider, max_tokens=16000, temperature=0.7)` — :231-264。`contents` 是 str 与 PIL Image 的混合列表。
- `call_llm_image_generation(prompt, api_key, model, base_url, provider, reference_image=None, image_size="4K")` — :267-318。**bianxie→`_call_openai_image_generation`（OpenAI Images SDK），custom→`_call_openai_compatible_image_generation`（chat.completions+data URI）**，openai→Images SDK，gemini→Gemini，其余→OpenRouter。

**provider 配置表** `PROVIDER_CONFIGS` / `IMAGE_PROVIDER_CONFIGS`（:133-167）集中存放 base_url 与默认模型名：

| provider | base_url | default_image_model | default_svg_model |
|---|---|---|---|
| openrouter | `https://openrouter.ai/api/v1` | `google/gemini-3.1-flash-image-preview` | `google/gemini-3.1-pro-preview` |
| bianxie | `https://api.bianxie.ai/v1` (:100) | `gpt-image-2` | `gemini-3.1-pro-preview` |
| custom | `AUTOFIGURE_CUSTOM_BASE_URL` env 或 CLI | `gemini-3.1-flash-image-preview` | `gemini-3.1-pro-preview` |
| gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.1-flash-image-preview` | `gemini-3.1-pro-preview` |
| openai_response | `https://api.openai.com/v1` | `gpt-image-2`（步骤1落 openai） | `gpt-5.5` |

默认模型解析在 `method_to_svg`：:3280-3283（`image_gen_model = image_config["default_image_model"]`，`svg_gen_model = config["default_svg_model"]`）。

### 4.1 生图（步骤 1）—— 3 条实现路径

调用链：`generate_figure_from_method`(:1378-1386) → `call_llm_image_generation` → 按 provider 分支。

**(a) OpenAI Images API**（`_call_openai_image_generation`，:585-624）—— provider=bianxie/openai 走此路径：
- SDK：`from openai import OpenAI`，`OpenAI(base_url=base_url, api_key=api_key, timeout=300)`（:595-597）。
- 无参考图：`client.images.generate(model, prompt, size, quality="high", output_format="png")`（:601-607）。
- 有参考图：`client.images.edit(model, image=(PNG bytes), prompt, size, quality="high", output_format="png")`（:612-619）。
- size 映射 `_resolve_openai_image_size`（:540-561）：`1K→1024x1024`、`2K→1536x1024`、默认按参考图纵横比选 `1536x1024 / 1024x1536 / 1024x1024`，无参考默认 `1536x1024`。
- 返回解析 `_extract_openai_image_response`（:564-582）：`data[].b64_json` 解码 或 `data[].url` 用 requests 拉取。

**(b) OpenAI-compatible chat**（`_call_openai_compatible_image_generation`，:392-439）—— provider=custom：
- 同样 openai SDK `chat.completions.create(model, messages)`（**不带 max_tokens/temperature**，:417-420）。
- 无参考图：`messages=[{"role":"user","content":prompt}]`；有参考图：`content=[{text},{image_url: data:image/png;base64,…}]`（:405-415）。
- 返回解析：在响应文本里正则 `data:image/(png|jpeg|jpg|webp);base64,…`（:428-434），没有就返回 None（→ generate_figure_from_method 抛「API 响应中没有找到图片」）。

**(c) Gemini**（`_call_gemini_image_generation`，:1187-1217）：`genai.Client(api_key)` + `models.generate_content(model, contents, config=GenerateContentConfig(image_config=ImageConfig(image_size=image_size)))`；contents = `[prompt]` 或 `[reference_image, prompt]`（:1203-1207）。提取 `_extract_gemini_image`（:1113-1142）：`part.as_image()` / `inline_data`。

**(d) OpenRouter**（`_call_openrouter_image_generation`，:874-1056）：requests POST `{base_url}/chat/completions`，payload 带 `modalities:["image"]`（:897-903）；响应解析最复杂——`message.images` / `content`(list/str) / 顶层 `images` 多候选，支持 data URI、纯 base64、http URL（:918-996）；全失败 raise RuntimeError 带 message_keys 摘要（:1051-1056）。

**参考图模式**：`generate_figure_from_method` :1345-1368 用英文 prompt「imitate the visual style of the reference figure…」；无参考图模式 :1369-1374 用「professional academic journal style … cute characters」。

### 4.2 SVG 重建（步骤 4 / 4.5 / 4.6）—— 3 条实现路径

调用链：`generate_svg_template`(:2445-2452) → `call_llm_multimodal`；`fix_svg_with_llm`(:2577-2585) → `call_llm_text`；`optimize_svg_with_llm`(:3119-3127) → `call_llm_multimodal`。

- **OpenAI-compatible 多模态**（`_call_openai_compatible_multimodal`，:352-389）：openai SDK `chat.completions.create(model, messages=[{role:"user", content:[{type:"text",text}, {type:"image_url", image_url:{url:"data:image/png;base64,…"}}]}], max_tokens, temperature)`。**图像一律 PNG data URI 内联**（:366-377）。
- **OpenAI Responses 多模态**（`_call_openai_response_multimodal`，:515-537）：`client.responses.create(model, input=_build_openai_response_input(contents), max_output_tokens, temperature)`；input 用 `{type:"input_text"}` / `{type:"input_image", image_url: dataURI, detail:"high"}`（:472-487）；文本提取 `_extract_openai_response_text`（:450-469）。
- **Gemini 多模态**（`_call_gemini_multimodal`，:1166-1184）：`generate_content(model, contents=[str|PIL], config=GenerateContentConfig(max_output_tokens=16000, temperature))`。
- **OpenRouter 多模态**（`_call_openrouter_multimodal`，:783-871）：requests POST，**自带重试**（`OPENROUTER_MULTIMODAL_RETRIES` 默认3、`RETRY_DELAY` 1.5s，指数退避 :816-867）；空文本 raise 带 choice 摘要。

**参数差异（契约设计要注意）**：步骤4 生成 `max_tokens=50000`、temperature 默认 0.7（:2445-2452）；步骤4.6 优化 `max_tokens=50000, temperature=0.3`（:3119-3127）；步骤4.5 修复 `max_tokens=16000, temperature=0.3`（:2577-2585）。

**prompt 全部硬编码在代码里**（不是模板文件）：
- 步骤4：`generate_svg_template` :2371-2439 —— no_icon_mode 用「像素级复现、禁止占位符」（中文）；box 模式附 boxlib.json 坐标（:2405-2416）；label 模式要求 `#808080` 灰底+黑框+居中 `<AF>01` 文本 + `<g id="AF01">`（:2418-2435）；none 模式无附加（:2437-2439）。**所有模式都强约束 `viewBox/width/height` = 原图像素尺寸**（:2397-2403）。
- 步骤4.5：`fix_svg_with_llm` :2559-2574（英文，「fix XML errors, return ONLY svg」）。
- 步骤4.6：`optimize_svg_with_llm` :3054-3113（英文，8 要点位置/样式检查）。

### 4.3 SAM3（不变，作为对比基线）

- **本地**：`from sam3.model_builder import build_sam3_image_model`（:1942-1956），依赖独立安装的 sam3 包（requirements.txt 注释），CPU/CUDA 自适应；逐 prompt `processor.set_text_prompt`（:1959-1986）。
- **fal.ai**：`_call_sam3_api`（:1772-1797）POST `https://fal.run/fal-ai/sam-3/image`（:180），header `Authorization: Key <key>`，payload `{image_url: dataURI, prompt, apply_mask:false, return_multiple_masks:true, max_masks, include_scores, include_boxes}`；key 用 `FAL_KEY` env 或 `--sam_api_key`（:1589-1593）。
- **Roboflow**：`_call_sam3_roboflow_api`（:1800-1888）POST `https://serverless.roboflow.com/sam3/concept_segment`（:181-184，可 env 覆盖），`{image:{base64}, prompts:[{text}], format:"polygon", output_prob_thresh}`，**自带 endpoint 切换 + 指数退避重试**（`ROBOFLOW_API_FALLBACK_URLS`、`SAM3_API_RETRIES`）；DNS 失败有专门报错提示 docker dns 配置（:1876-1883）。
- 坐标解析：fal 用 cxcywh 归一化（:1618-1643），roboflow 用 polygon→bbox（:1646-1676）。

### 4.4 RMBG-2.0（不变）

`BriaRMBG2Remover`（:2189-2263）：`AutoModelForImageSegmentation.from_pretrained("briaai/RMBG-2.0", trust_remote_code=True, token=HF_TOKEN)`（:2214-2219），预处理 1024×1024 + ImageNet 归一化（:2240-2245），`pred.sigmoid()` 做 alpha（:2251-2259），输出 `icons/{name}_nobg.png`。gated 模型需 `HF_TOKEN`（`_ensure_rmbg2_access_ready` :2173-2186 有 preflight 报错）。

---

## 5. /web 前端：结构、数据流与后端依赖图

### 5.1 前端结构

- 纯静态多页，每页一个 `<body data-page="…">`，`app.js` 按页分发 `initXxxPage()`（app.js:747-759）。
- **配置页 index.html**（244 行）：左 method text；右 provider 卡片（bianxie/gemini/openai_response/openrouter/custom）、image provider pills（same/openai/bianxie/gemini/openrouter/custom）、可编辑 SVG/Image 模型输入、API key、base_url、优化轮数、图片尺寸(1K/2K/4K)、自动放大、SAM 后端(Roboflow/fal/local)、SAM prompt、参考图上传。
- **导入页 import.html**：上传 stage-1 图 + SVG provider/模型/key + SAM 设置，无生图配置。
- **画布页 canvas.html**：`<iframe id="svgEditorFrame">` 嵌 svg-edit + 产物抽屉 + 日志面板 + 状态栏。
- **历史页 history.html**：卡片网格。

### 5.2 配置状态存储与运行 payload

- **sessionStorage** 持久化配置：`autofigure_input_state_v2`（app.js:2, 842-868）、`autofigure_import_state_v1`（:3, 1439-1457）；locale 在 localStorage（:4）。
- **input 页提交 payload**（app.js:1341-1364）：`{method_text, provider, api_key, base_url(custom 才有), image_provider(≠same 才有), image_api_key, image_base_url, image_model, svg_model, optimize_iterations, enable_upscale, reference_image_path, sam_backend, sam_prompt, sam_api_key}`；`image_size` 仅当有效 image provider 是 gemini 时加入（:1359-1361）；sam_backend=local 时 sam_api_key 置 null（:1362-1364）。
- **import 页提交 payload**（app.js:1695-1707）：`{input_figure_path, provider, api_key, base_url, svg_model, sam_backend, sam_prompt, sam_api_key}`。
- 前端默认模型名：input 页 `getDefaultSvgModel`(:975-983) / `getDefaultImageModel`(:985-996)，import 页 :1523-1532 —— 与 Python 侧 PROVIDER_CONFIGS 的默认值一致（openai_response→gpt-5.5，其余→gemini-3.1-pro-preview；openai/bianxie→gpt-image-2，其余→gemini-3.1-flash-image-preview）。

### 5.3 后端调用点（**前端改写指向的外部后端时全在这**）

**全部是相对路径裸 fetch，无 axios/集中封装，无 BASE_URL 常量。** 7 处直接调用 + 2 处间接：

| # | 位置 | 调用 | 用途 |
|---|---|---|---|
| 1 | app.js:1368-1372（input 页 confirm） | `POST /api/run` | 提交主流程任务 → 跳 `canvas.html?job=…&source=input`（:1380） |
| 2 | app.js:1711-1715（import 页 confirm） | `POST /api/run` | 提交导入任务 → 跳 `canvas.html?job=…&source=import`（:1723） |
| 3 | app.js:1866（history 页） | `GET /api/history` | 拉历史列表 |
| 4 | app.js:1982-1985（uploadReference） | `POST /api/upload` | 参考图/stage-1 上传（multipart FormData）；返回 path/url 存入 sessionStorage |
| 5 | app.js:2106（canvas 页） | `GET /api/config` | 探测 svg-edit 是否可用、得到 iframe src 路径 |
| 6 | app.js:2150（canvas 页） | `EventSource /api/events/${jobId}` | SSE：artifact/status/log 事件 |
| 7 | app.js:2221（canvas 页，历史回退） | `GET /api/history/${jobId}` | 活任务 SSE 失败时加载历史产物 |
| 8 | app.js:2264-2269（loadSvgAsset） | `fetch(artifact.url)` | 拉 SVG 文本注入编辑器 |
| 9 | 间接 | `<img src=artifact.url>` | 产物卡片/历史缩略图直接吃服务端返回的 `/api/artifacts/…` URL |

**画布 → svg-edit 的注入机制**（canvas 页）：
- iframe `src = /vendor/svg-edit/editor/index.html`（app.js:2116-2117，路径来自 `/api/config`）。
- 收到 `template_svg/optimized_template_svg/final_svg` 事件后 `loadSvgAsset(url)` → `fetch` SVG 文本 → **同源直接调用** `iframe.contentWindow.svgEditor.loadFromString(svgText)`，回退 `win.svgCanvas.setSvgString(svgText)`（app.js:2299-2314）。svg-edit 侧 `Editor.js` 有 `window.svgEditor = this`，故同源跨 frame 可调用。
- 若两者都不可用，改 `iframe.src = svgEditPath + "?url=" + encodeURIComponent(url)` 重载（app.js:2284）——**svg-edit 的 editor/index.html 是否真读 `?url` 参数未在源码中确认**（index.html 是 ES module 引导，无该逻辑），此路径是弱回退。
- **无 postMessage 桥**（grep `postMessage` 全仓库无结果）。iframe 同源时才可能函数直调；若面板跨源嵌入 /web，T4 需新增 postMessage 桥。

### 5.4 页面间跳转与 job 传递

配置页/导入页 → `canvas.html?job={job_id}&source=input|import`；历史页卡片 → `canvas.html?job={job_id}&source=history`（item.open_url，server.py:441）。canvas 页按 source 分支：history 直接 `loadHistoricalJob`（app.js:2145-2148），否则开 EventSource。

---

## 6. config / provider 模型

- **配置来源**：仅 **HTTP payload + CLI 参数 + 环境变量** 三种；**没有配置文件、没有数据库**。运行配置在 `method_to_svg` 内聚合成参（:3246-3290）。
- **provider 合法性校验**：`PUBLIC_PROVIDER_CHOICES=("openrouter","bianxie","custom","gemini","openai_response")`、`PUBLIC_IMAGE_PROVIDER_CHOICES=("openrouter","bianxie","custom","gemini","openai")`（:102-103）；`_normalize_provider_name` :111-116。CLI 用 `_argparse_provider` 校验（:119-130）。
- **环境变量清单**（.env.example / docker-compose.yml）：
  - `HF_TOKEN`（RMBG-2.0 gated 下载，autofigure2.py:2152-2162）
  - `FAL_KEY` / `ROBOFLOW_API_KEY`（SAM3 API，:1589-1602）
  - `ROBOFLOW_API_URL` / `ROBOFLOW_API_FALLBACK_URLS`（:181-184）
  - `OPENAI_API_KEY`（image_provider=openai 且未传 image_api_key 时的回退，:3276-3277）
  - `AUTOFIGURE_CUSTOM_BASE_URL`（custom 默认 base_url，:106-108）
  - `OPENROUTER_MULTIMODAL_RETRIES` / `_RETRY_DELAY`（:816-825）
  - `SAM3_API_RETRIES` / `SAM3_API_RETRY_DELAY`（:1832-1841）
  - `AUTOFIGURE_PYTHON`（server.py:32 指定跑子进程的 python）
  - `PYTHONUNBUFFERED`（server.py:257-258）
- **API key 传递路径**：前端明文入 payload → server 拼 CLI 参数（server.py:211-246）→ `run.log` 中**脱敏**（:260-264）→ 子进程 env 继承，键不落任何配置文件。

---

## 7. 改动点评估（研究重点）

### 7.1 换模型：生图→MiniMax image-01(TokenPlan)、SVG 重建→Deepseek-v4-flash

**结论：改动集中在「provider 表 + 默认模型名 + 前端默认字符串」，无需重构 adapter。** 模型调用已经三层收敛（§4.0），各 provider 实现完备。

- **生图 MiniMax image-01**：
  - 若 TokenPlan 网关暴露 **OpenAI Images 兼容** `POST /v1/images/generations|edits` → 直接走现有 `_call_openai_image_generation`（autofigure2.py:585-624，bianxie/openai 分支已通）。改动 = 在 `IMAGE_PROVIDER_CONFIGS`（:161-167）加/改一条 `default_image_model="minimax/image-01"`（若自定义 base_url 则走 custom 分支）。
  - 若 TokenPlan 走 **chat.completions + 返回 data URI** → 现有 `_call_openai_compatible_image_generation`（:392-439）已支持，但注意它**不带 max_tokens/temperature**（:417-420），且**只认 data URI 图像**（:428-434）——契约设计时需确认 MiniMax 返回形态。
  - 前端默认模型名要同步改：`getDefaultImageModel`（app.js:985-996）与 `index.html:125` 的 placeholder 默认 `gpt-image-2`。
  - **注意**：image_size 映射（:540-561）与 `image_size` 参数（1K/2K/4K）是针对 OpenAI/Gemini 的，MiniMax 若尺寸枚举不同需在 `_resolve_openai_image_size` 处加映射。
- **SVG 重建 Deepseek-v4-flash**：
  - 现有默认 `gemini-3.1-pro-preview`（PROVIDER_CONFIGS :137/:142/:147/:152）或 `gpt-5.5`（:157）。换模型 = `PROVIDER_CONFIGS[provider]["default_svg_model"]` 或 TS 后端每次显式传 `--svg_model deepseek-v4-flash`（server.py:227-228 已透传）。
  - 多模态输入格式：Deepseek-v4-flash 若 OpenAI 兼容 → `_call_openai_compatible_multimodal`（:352-389，PNG data URI 内联图）已可用；若走 Responses 格式 → :515-537。**需确认其是否接受内联 base64 图像、以及图像张数**（步骤4一次 2 张、步骤4.6一次 3 张：figure+samed+当前SVG渲染PNG）。
  - **prompt 硬编码**在 :2371-2439（步骤4）、:2559-2574（修复）、:3054-3113（优化）——与模型无关，但**强约束 `viewBox/width/height` = 原图像素**（:2397-2403）与占位符 `<g id="AF01">` 结构（:2418-2435），换模型后验证重点在：是否仍遵循这些结构约定（步骤5的正则替换依赖它们）。
  - 参数：`max_tokens=50000`（:2451/:3125）对 Deepseek 类模型可能过高，契约设计需按目标模型能力调。OpenRouter 路径已有重试（:816-867），其他 provider **无重试**。
  - **模型名是纯字符串**、无 registry，所以 TS 后端完全可控；无需改 Python 代码即可切换（只要目标模型走 OpenAI-compatible 且能处理多模态图像）。

### 7.2 把 /web 的 FastAPI 调用改指向外部 TS 后端

**结论：改动面小但散，集中在 app.js 的 7 处调用点 + 服务端返回的产物 URL。无集中 API 层是主要麻烦点。**

- **fetch 调用点**（§5.3 表格）：全部相对路径。若 TS 后端**同源托管 /web 静态文件**（TS serve `web/`），则 7 处调用零改动自动指向 TS；TS 需按 §2 契约镜像 `/api/run`、`/api/upload`、`/api/history`、`/api/config`、`/api/events`(SSE)、`/api/history/{id}` 及静态 `/vendor/svg-edit/…`。
- 若 /web 仍由 Python 服务、仅数据面指向 TS：需给 app.js 所有调用点加 base 前缀（现无 BASE_URL 常量，1/2/3/4/5/6/7/8 共 8 处字符串都要动），或用 `<script>` 注入全局变量。
- **产物 URL 是服务端构造的相对路径**（`/api/artifacts/{job_id}/{path}`，server.py:474；history 同理 :171-176）。前端直接用 `<img src>` / fetch 消费（app.js:2264-2289, addArtifactCard :2328-2368）。→ **TS 后端要么代理该路径，要么在 Python 侧改 URL 生成逻辑**（新增 `public_base` 配置）。这是契约设计必须解决的第一个耦合点。
- **CORS**：Python 侧**零 CORS 配置**。若 TS 后端（面板域）在浏览器里直接调 Python 微服务（跨源 fetch），必须给 Python 加 CORSMiddleware 或让 TS 全后端代理；若 TS 只做服务端调用（Python 作为微服务被 TS 调），无 CORS 问题。
- **鉴权**：Python 服务无鉴权，`/api/run` 里 API key 直接入 payload/CLI 参数（server.py:211-218）。面板集成时需在 TS 层鉴权；Python 作为内部微服务可保持无鉴权但**必须网络隔离**（沿用面板既有 docker.sock root 等价风险的处置思路）。
- **postMessage 桥**：现状没有（§5.3）。T4 若要 iframe 嵌入 /web，且 /web 与面板**不同源**，则：
  - 画布注入需把 app.js:2299-2314 的 `win.svgEditor.loadFromString` 直调改成「父→iframe postMessage 传 SVG + iframe 内监听后注入」，或干脆让 iframe 内页面自己 fetch（走 TS 同源）再注入。
  - **同源时**（面板域 serve /web），现有直调机制原样可用，T4 只需确保 iframe 与父同源 + 静态资源路径可达。
- **EventSource**：SSE 跨源受 CORS 限制；TS 后端若同源提供 `/api/events` 则无碍；若 TS 要把 Python 的 SSE 透传给浏览器，需保持 SSE 帧格式（server.py:356-358：`event: <name>\ndata: <json>\n\n`）不变。

### 7.3 暴露任务契约（Python 作无状态执行引擎：提交→轮询进度/日志→取产物）

**结论：现有架构已 80% 具备「任务 id + 进度流 + 产物定位」；缺口是「可轮询的任务状态端点」与「结构化阶段进度」。**

已具备（可原样复用的资产）：
- 提交即得 job_id：`POST /api/run` 同步返回 job_id（server.py:179-288）。
- 产物以**固定文件名**落盘（§3），`outputs/{job_id}/` 即产物命名空间；`_collect_artifacts`（:446-465）+ `_artifact_payload`（:468-477）已能列出 + 生成 URL。
- 进度通道：SSE `/api/events/{job_id}`（status/artifact/log/close）；**产物出现粒度 = 阶段粒度**（figure→samed→template→optimized→final 天然对应步骤 1-5）。
- 历史持久：job 完成后靠 outputs 目录扫描即可恢复（`_build_history_item` :404-443），不依赖内存。

最小改动清单：
1. **新增轮询式状态端点**（现没有）：`GET /api/jobs/{job_id}` → `{state: queued|running|finished|failed, exit_code, artifacts:[…], log_url}`。可直接复用 `_build_history_item`/`_collect_artifacts` 对活任务与死任务统一作答；state 来自 `JOBS[job_id].done/process.poll()`（:77, :496）。
2. **结构化阶段进度**（可选）：现在阶段进度只能从「哪个产物出现了」反推（前端 stepMap app.js:2134-2142 就是这么做）。若契约要显式 stage，需在 autofigure2.py 各阶段加结构化 stdout 行（如 `[stage:2] segment_with_sam3 done`）——server 的 `_pipe_output`（:520-528）已逐行转发，改造成本极低；或由 Python 侧把 `method_to_svg` 的返回 dict（:3536-3544）落一个 `outputs/{job_id}/result.json`。
3. **任务状态持久化**（无状态化关键）：`JOBS` 是 in-memory（:113），**进程重启丢在途任务**（但产物仍在磁盘）。作为无状态引擎，建议把 job 元数据（cmd、env 摘要、start/finish 时间）落 `outputs/{job_id}/job.json`（`run.log` 首行 meta 已是雏形，:260-264）。
4. **取消/停止**：子进程对象在 `Job.process`（:73），有 kill 接口但**无暴露端点**。契约若需要 cancel 语义需新增 `POST /api/jobs/{id}/cancel`（SIGTERM 子进程 + 标记）。
5. **产物 URL 稳定性**：`/api/artifacts/{job_id}/{path}` 与 `/api/history/{job_id}/artifacts/{path}` 双端点（:337-343 / :171-176）已稳定；TS 后端直接透传或改 URL 即可。
6. **并发与端口**：server.py 启动时会**杀掉占用 8000 的其它 uvicorn**（:578-701），单实例假设；TS 编排 Python 微服务时应固定端口、避免该逻辑误杀。

---

## 8. 给 P3 契约设计 / T4 iframe 改写的要点清单

1. Python 微服务契约 = `/api/run`(POST, RunRequest 18 字段) + `/api/events/{id}`(SSE 4 事件) + `/api/artifacts/{id}/{path}` + （建议新增）`/api/jobs/{id}`。SSE 帧格式 `event:\n data:\n\n`（server.py:356-358）。
2. 模型默认值双份（Python :133-167 与前端 app.js:975-996），TS 后端接管后**以 TS 为准、显式传参**，Python 默认值退为兜底。
3. 生图大小映射（:540-561）与 max_tokens=50000（:2451/:3125）按 MiniMax/Deepseek 实际能力核；多模态图像内联为 PNG data URI（:352-389）。
4. 产物 URL 是相对路径（:474），跨源嵌入前必须统一（TS 代理或 Python 侧 base 配置）。
5. /web 前端 7 处裸 fetch + 产物 <img> 直用服务端 URL，无集中封装；T4 改写优先考虑「TS 同源托管 /web」把改动压到最小，否则 8 处字符串全改。
6. 画布 iframe 是**同源函数直调**（app.js:2299-2314），不是 postMessage；跨源嵌入需新建 postMessage 桥，或保持同源。
