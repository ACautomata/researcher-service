# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is the `~/.openclaw` configuration directory for an OpenClaw AI agent gateway. It tracks non-sensitive configuration files in git, synced to `git@github.com:ACautomata/research-agent.git`.

All changes are made via SSH to the remote server. Local clone is at `/Users/junran/Documents/research-agent/`.

## Architecture

This repo follows OpenClaw's hub-and-spoke multi-agent pattern. The main agent (颖姗) is bound to messaging channels and delegates specialized tasks to sub-agents via `sessions_spawn`.

- **openclaw.json** — Main gateway configuration. All secrets use `${ENV_VAR}` references resolved from `.env` (which is gitignored).
- **agents/main/agent/models.json** — Custom model provider definitions (currently MiniMax Anthropic-compatible endpoints).
- **canvas/index.html** — OpenClaw Canvas web UI.
- **workspace/** — Main agent (颖姗) working directory. Contains SOUL.md, AGENTS.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, DREAMS.md. See [docs](https://docs.openclaw.ai/concepts/agent-workspace).
- **workspace-autoresearch/** — Sub-agent workspace for the Autoresearch agent. Mirrors the main workspace structure with SOUL.md, AGENTS.md, IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, DREAMS.md. This agent is spawned by 颖姗 for paper ingest, literature queries, cross-paper comparison, and wiki quality auditing.
- **workspace-paper-review/** — Agent workspace for paper review and validation experiment design. Contains SOUL.md, AGENTS.md, USER.md, memory/, and skills/ for the 5-stage paper analysis pipeline.
- **benchmarks/** — Developer benchmarks and evaluation datasets for testing agent capabilities.

## Key Configuration Details

- **Gateway**: loopback-bound on port 18789, token auth via `${GATEWAY_TOKEN}`.
- **Model**: Primary `minimax/MiniMax-M2.7`, fallback `minimax/MiniMax-M2.7-highspeed`. Provider auth uses `minimax-oauth` (handled by the minimax plugin).
- **Channels**: Feishu configured with WebSocket mode, pairing DM policy, allowlist group policy. Requires `${FEISHU_APP_ID}` and `${FEISHU_APP_SECRET}` in `.env`.
- **Memory**: QMD backend indexing `**/*.md` in workspace.
- **TTS**: Edge TTS with `zh-CN-XiaoxiaoNeural`.
- **Browser**: Headless Chromium at `/usr/bin/chromium`, no sandbox.
- **Session**: `dmScope: "per-peer"` — each user gets an independent DM session context.

### Gotchas

- Feishu channel: `streaming` must be boolean, not string. No `tools` property at channel level.
- Config validation errors appear in gateway logs on startup.
- `plugins.installs.*.installPath` is the resolved install directory; keep managed installs as absolute paths.
- QMD `paths[].path` entries resolve relative to the agent workspace directory; use `.` for the workspace root.
- External tools (Context7, WebReader) have weekly rate limits — use Playwright to read docs.openclaw.ai as fallback.
- `.env` uses `export VAR="value"` format (shell export syntax).

## Operations

```bash
# Restart gateway after config changes
openclaw gateway restart

# Verify config after restart
openclaw logs --tail 15

# View live logs
openclaw logs --follow

# Check version
openclaw --version

# Feishu pairing management
openclaw pairing list feishu
openclaw pairing approve feishu <CODE>
```

## Gitignore Strategy

`.env` and `auth-profiles.json` contain secrets — never track them. Runtime data (`logs/`, `tasks/`, `*.sqlite`), QMD caches (`qmd/`, `agents/*/qmd/`), CLI-managed dirs (`extensions/`), and channel data (`qqbot/`) are excluded. Agent workspaces and their checked-in skills are tracked, while runtime state inside those workspaces is ignored. `openclaw.json` is tracked because all tokens are env var references.
