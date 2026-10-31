# DoraMonitor

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)](#requirements)

**English** · [简体中文](./README.md)

**Windows and Linux (including WSL) are supported.** DoraMonitor is a local, privacy-first dashboard for AI coding tools. It combines token usage, API-equivalent cost, cache hit rates, quota windows, sessions, and multi-device summaries in one Web UI and CLI.

![DoraMonitor dashboard](./assets/screenshot.png)

## Supported tools

| Tool | Local data source | Usage data |
| --- | --- | --- |
| Kimi Code | `~/.kimi-code/sessions/**/wire.jsonl` | Tokens, cost, 5-hour/weekly quota |
| Codex | `~/.codex/sessions/**` and archived rollouts | Tokens, cost, rate-limit snapshots |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Tokens and cost |
| Oh My Pi (omp) | `~/.omp/agent/sessions/**` (legacy `~/.pi/agent`) | Tokens and cost |
| Gemini CLI | Gemini settings and OpenTelemetry export | Tokens and tool events |
| ZCode | `~/.zcode/cli/db/db.sqlite` | Tokens, estimated cost |
| QoderCN IDE | QoderCN `local.db` | Tokens |
| QoderCN CLI | `~/.qoder-cn/projects/**/*.jsonl` | Credits |
| dsh | `~/.dsh/sessions/**` | Tokens and cost |

Missing tools are reported as unavailable without preventing other tools from loading. SQLite databases are opened read-only.

## Requirements

- Node.js **22.13 or newer** (`node:sqlite` is flag-free from 22.13/23.4); Node.js **24.x** recommended; native zstd on 22.5+.
- Older Node versions are unsupported; compressed transcripts use the bundled pure-JS `fzstd` fallback.
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
npm run deploy
npm start
```

`npm run deploy` checks Node, installs the locked dependencies, and builds the Web UI. Use `npm run deploy -- --background` to deploy and start detached, or `--skip-install` to rebuild without reinstalling. For development with Vite hot reload, run `npm run dev`.

## One-command install, background and startup

On Linux (including WSL), the user-level installer needs no sudo. `--with-web` registers systemd user services and `--start` starts them immediately:

```bash
bash scripts/install-linux.sh --with-web --start
```

On Windows, the PowerShell installer registers hidden logon tasks and starts the dashboard:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -WithWeb -Start
```

Both installers use only nodejs.org and the public npm registry, contain no private sync configuration, and can install Node.js when it is missing. If `doramonitor` is not found after installation, open a new terminal; on Windows you can also run `doramonitor.cmd` explicitly.

For an existing installation, start the daemon and detached server without opening a browser:

```bash
doramonitor daemon --background
doramonitor web --background --no-open
```

Windows also provides `scripts/start-windows.bat` to start both and `scripts/register-autostart.ps1` for logon startup. The Linux systemd units are `doramonitor-web.service` and `doramonitor-daemon.service`.

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

- Today, 7-day, 30-day, and all-time usage, model statistics, 7/30-day trends, and 7/30-day or annual heatmaps.
- Input, output, cache-read, and cache-write tokens with per-model cache hit rates.
- Official-price links, custom prices, USD/CNY display, and a single internal CNY ledger.
- Kimi and Codex quota cards with per-account home visibility controls and clearly marked equivalent-capacity estimates.
- Cross-client model attribution, optional client-only estimation switches, and detailed history on `/quota`.
- Kimi session/workspace management with secret-redacting previews.
- A `/sync` settings page for optional SSH/WebDAV/local-directory synchronization, with configuration and recent-result status, peer devices, and minute-level quota-usage buckets.

Equivalent capacity and API-price costs are estimates, not vendor bills or guaranteed subscription limits.

## Privacy

DoraMonitor reads usage metadata, not prompts, replies, source code, or provider credentials. The server binds to `127.0.0.1` by default and does not enable CORS. Multi-device upload is off until explicitly configured. See [Privacy & security](./docs/privacy.md).

## Documentation

- [Documentation index](./docs/README.md)
- [Features and calculations](./docs/features.md)
- [Architecture](./docs/architecture.md)
- [Usage statistics and tool data sources](./docs/tools.md)
- [Configuration](./docs/configuration.md)
- [Pricing and price tables](./docs/pricing.md)
- [Quota estimation](./docs/quota-capacity-estimation.md)
- [Known limitations](./docs/limitations.md)
- [Deployment](./docs/deployment.md)
- [npm release checklist](./docs/release.md)
- [Development](./docs/development.md)

## Verify and contribute

```bash
npm test
npm run build
npm pack --dry-run
```

CI runs the same checks on Ubuntu and Windows with Node 22 and 24. See [the development guide](./docs/development.md) for tool-adapter conventions.

## License and attribution

MIT. DoraMonitor is derived from [kimicode-dashboard](https://github.com/JochenYang/kimicode-dashboard), with substantial changes. The original Jochen copyright and MIT license are retained; DoraMonitor's copyright and attribution details are in [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
