# DoraMonitor

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#requirements)

**English** · [简体中文](./README.zh-CN.md)

DoraMonitor is a local, privacy-first dashboard for AI coding tools. It combines token usage, API-equivalent cost, cache hit rates, quota windows, sessions, and multi-device summaries in one Web UI and CLI.

![DoraMonitor dashboard](./assets/screenshot.png)

## Supported tools

| Tool | Local data source | Usage data |
| --- | --- | --- |
| Kimi Code | `~/.kimi-code/sessions/**/wire.jsonl` | Tokens, cost, 5-hour/weekly quota |
| Codex | `~/.codex/sessions/**` and archived rollouts | Tokens, cost, rate-limit snapshots |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Tokens and cost |
| Oh My Pi (omp) | `~/.omp/agent/sessions/**` (legacy `~/.pi/agent`) | Tokens and cost |
| Gemini CLI | Gemini settings and OpenTelemetry export | Tokens and tool events |
| ZCode | `~/.zcode/cli/db/db.sqlite` | Tokens, GLM Coding Plan 5h/weekly quota |
| QoderCN IDE | QoderCN `local.db` | Tokens |
| QoderCN CLI | `~/.qoder-cn/projects/**/*.jsonl` | Credits |
| dsh | `~/.dsh/sessions/**` | Tokens and cost |

Missing tools are reported as unavailable without preventing other tools from loading. SQLite databases are opened read-only.

## Requirements

- Node.js **18 or newer**. Node.js **22.5+** is recommended for the built-in SQLite and zstd support.
- On older Node versions, ZCode/QoderCN SQLite readers require the `sqlite3` CLI in `PATH`; compressed transcripts use the bundled pure-JS `fzstd` fallback.
- No database server, Rust toolchain, or administrator account is required.

## Install and run

```bash
npm install -g doramonitor
doramonitor
```

Open <http://127.0.0.1:3847>. The npm package includes the prebuilt Web UI, so a frontend build is not required after installation.

From source:

```bash
git clone https://github.com/DoraJasmine/DoraMonitor.git
cd DoraMonitor
npm ci
npm run build
npm start
```

For development with Vite hot reload, run `npm run dev`.

## Background and Windows startup

Start a detached server without opening a browser:

```bash
doramonitor web --background --no-open
```

On Windows, `scripts/start-windows.bat` provides the same portable, double-clickable launcher. For hidden startup at logon and automatic restart:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-autostart.ps1
```

The one-command Windows installer uses only nodejs.org and the public npm registry:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -WithWeb -Start
```

See [deployment and recovery](./docs/deployment.md) before exposing or changing the listening address. The default is loopback only.

## CLI

```text
doramonitor [web]                 Start the Web dashboard
doramonitor web -d --no-open     Start in the background
doramonitor status                Print a one-line usage summary
doramonitor daemon                Write status cache and synchronize periodically
doramonitor sync                  Synchronize once
doramonitor tools                 List detected tools and data directories
doramonitor stop                  Stop the daemon
doramonitor --help                Show all options
```

## Features

- Today, 7-day, 30-day, and all-time usage, model statistics, trends, and an annual heatmap.
- Input, output, cache-read, and cache-write tokens with per-model cache hit rates.
- Official-price links, custom prices, USD/CNY display, and a single internal CNY ledger.
- Kimi and Codex quota cards plus clearly marked, non-official equivalent-capacity estimates.
- Cross-client model attribution: GPT usage in omp can count toward OpenAI quota estimation; unrelated models are excluded.
- Optional client-only estimation switches and detailed estimation history on the `/quota` page.
- Kimi session/workspace management with secret-redacting previews.
- Optional SSH/WebDAV multi-device synchronization, including minute-level quota-usage buckets.

Equivalent capacity and API-price costs are estimates, not vendor bills or guaranteed subscription limits.

## Privacy

DoraMonitor reads usage metadata, not prompts, replies, source code, or provider credentials. The server binds to `127.0.0.1` by default and does not enable CORS. Multi-device upload is off until explicitly configured. See [Privacy & security](./docs/privacy.md).

## Documentation

- [Documentation index](./docs/README.md)
- [Architecture](./docs/architecture.md)
- [Tool data sources](./docs/tools.md)
- [Configuration](./docs/configuration.md)
- [Pricing](./docs/pricing.md)
- [Quota estimation](./docs/quota-capacity-estimation.md)
- [Deployment](./docs/deployment.md)
- [npm release checklist](./docs/release.md)
- [Development](./docs/development.md)

## Verify and contribute

```bash
npm test
npm run build
npm pack --dry-run
```

CI runs the same checks on Ubuntu and Windows with Node 18 and 22. See [the development guide](./docs/development.md) for tool-adapter conventions.

## License and attribution

MIT. DoraMonitor is derived from [kimicode-dashboard](https://github.com/JochenYang/kimicode-dashboard), with substantial changes. The original Jochen copyright and MIT license are retained; DoraMonitor's copyright and attribution details are in [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
