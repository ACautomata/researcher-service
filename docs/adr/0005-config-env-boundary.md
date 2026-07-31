# ADR 0005：配置边界——`config/settings/` 为唯一环境变量读取处

## 状态

已接受。确立 runtime 代码的环境变量读取边界；与 [0001-persistent-credential-encryption](./0001-persistent-credential-encryption.md) 的「生产 fail-fast / secret 独立注入」一脉相承，把该思路从单把密钥推广到全部配置。

## 背景

环境变量读取曾散在 `config/` 之外的 runtime 代码里，且无集中声明：

- `containers/orchestrator.py` 直接 `os.environ.get('LLM_API_KEY', '')` —— 敏感值，缺省静默给空串；生产漏设会把空 key 静默注入容器（与 issue #195「卡 creating」同类错配，不启动即不知）。
- `chat/pairing.py` 直接 `os.environ.get('OPENCLAW_FLEET_WS_SCHEME' / 'OPENCLAW_FLEET_WS_HOST', …)` —— 非敏感、有默认，但读点游离于声明之外。
- `config/settings/` 下则已合法读取 `DJANGO_SECRET_KEY` / `DJANGO_ALLOWED_HOSTS` / `CREDENTIAL_ENCRYPTION_KEYS` / `OPENCLAW_FLEET_ROOT` / `OPENCLAW_TEMPLATE_DIR` / `RESEARCHER_DIR` / `OPENCLAW_IMAGE`。

散读的后果：运维/新人无法从单一处看出「面板到底吃哪些 env、哪些必填」；敏感值缺省静默容错，错配要到运行期才暴露。

## 决定

1. **`config/settings/*.py` 是唯一的 `os.environ` 读取处**，即面板配置的单一声明处与单一来源。runtime app（`containers` / `chat` / `wiki` / `models` / `accounts`）不直接读 `os.environ`，一律经 `django.conf.settings` 取配置。

2. **敏感值只经环境注入，不经 CLI argv 传参**。secret（`LLM_API_KEY` / `DJANGO_SECRET_KEY` / `CREDENTIAL_ENCRYPTION_KEYS` 等）走 shell env / compose / K8s `environment`；dev 本地可用 gitignored `.env` + `load_dotenv` 提供便利。**不引入 argv 传 secret**——argv 会泄露进 `ps` / shell history，且非 Django 惯例（manage.py 子命令不接受 secret flag）。「命令行传入敏感内容」按惯例解读为「命令行环境（env / `.env`）注入」。

3. **必填 secret 生产 fail-fast，dev / integration 宽容**。`prod.py` 的 `validate_prod_env` 追加 `LLM_API_KEY` 非空校验（与 `DJANGO_SECRET_KEY` 硬读同款）；dev / integration 不加 fail-fast——integration CI 恰恰靠 `LLM_API_KEY` env 注入跑真容器，强制非空会打红。

4. **settings 落点**：`base.py` 给 `OPENCLAW_FLEET` 增 `'LLM_API_KEY'`（默认 `''`，宽容），新增 `OPENCLAW_FLEET_WS{SCHEME, HOST}`；`orchestrator.py` / `pairing.py` 改读 `django.conf.settings`。

5. **边界是架构约定（code review 维护），非零容忍 grep**。两处豁免：
   - `DJANGO_SETTINGS_MODULE` 自举——`manage.py` / `asgi.py` / `wsgi.py` 在 settings 加载前必须 `setdefault`，物理上无法入 config/（pytest 已在 `pyproject.toml` 声明 `DJANGO_SETTINGS_MODULE = config.settings.dev`，不靠 env）。
   - 测试 harness / fixture（如 `tests/integration/conftest.py` 的 `INTEGRATION_VITE_PORT`、测 settings 解析的 `config/tests/`）——测试基建读 env 不属于 runtime。
   机械 lint「非 config/ 出现 `os.environ` 即 fail」会把 `manage.py` 与 `prod.py` 的故意硬读误判，故不设。

## 为什么

- **单一声明处 = 可发现性**：所有 env 集中在 `config/settings/`，运维一眼看全「吃哪些变量、哪些必填」，不必满仓 grep。
- **settings 作唯一门面是 Django 惯例**：不新建独立「env 注册包」——那是给 Django 项目加非惯例的多余层，反而让 settings 绕一道。调用方读 `django.conf.settings` 是框架既有约定，零新包、改动最小。
- **fail-fast 修静默错配**：`LLM_API_KEY` 从「缺省静默空串」改为「生产缺失即拒启动」，把错配从运行期提前到启动期，与 0001 的生产 fail-fast 风格统一。
- **dev/integration 宽容是强制非空的前提**：若非 dev 宽容，integration CI（依赖 `LLM_API_KEY` env）与本地 runserver 会被 fail-fast 打红。

## 考虑过但否决的方案

- **新建 `config/env.py` 中央注册包，settings 与其他 runtime 都走它**：边界最硬（单文件），但给 Django 项目加了非惯例层，settings 反而绕一道。否。
- **CLI argv 传 secret（settings 启动期 argparse 解析 `sys.argv`）**：argv 泄露 `ps` / shell history，且非 Django 惯例。否。
- **零容忍 grep 硬规则（连 tests / manage.py 也禁）**：`DJANGO_SETTINGS_MODULE` 自举物理上做不到，会把 `prod.py` 故意硬读误判。否。
- **dev 也给 `LLM_API_KEY` fail-fast**：会打红本地 integration 与缺 env 的 dev runserver。否。

## 后果

- `CONTEXT.md` 新增「配置边界 / 配置边界豁免 / 必填 secret 的 fail-fast」三词条，术语与本 ADR 对齐。
- 落地改动面：`base.py`（`OPENCLAW_FLEET` 增键 + `OPENCLAW_FLEET_WS`）、`prod.py` 的 `validate_prod_env`（`LLM_API_KEY` 非空）、`orchestrator.py`、`pairing.py` 改读 settings。runtime 代码行为在 env 齐备时不变；生产缺 `LLM_API_KEY` 时由「静默空 key」变为「启动拒」。
- 边界靠 code review 维护，不设机械 lint；后续新增 env 读取一律落 `config/settings/`。
- 本 ADR 与 [0001-persistent-credential-encryption](./0001-persistent-credential-encryption.md) 相关：0001 的「生产 fail-fast 解析 + secret 独立环境注入」是本 ADR 必填 secret 条款的先例。
