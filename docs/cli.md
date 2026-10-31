# CLI 与守护进程

除 Web 仪表盘外，DoraMonitor 还提供一组 CLI 子命令，用于在终端中查看状态、运行
常驻守护进程，并向 tmux/状态栏输出单行用量摘要。统一入口是
`src/doramonitor.js`（npm 全局安装后即 `doramonitor` 命令）。

## 1. 子命令总览

```
doramonitor web      # 启动 Web 仪表盘（默认；未知子命令也落到这里）
doramonitor status   # 输出一行用量摘要（适合状态栏）
doramonitor daemon   # 常驻守护：定时刷新 status.cache + 定时同步
doramonitor stop     # 停止 daemon
doramonitor tools    # 列出各工具检测状态
doramonitor sync     # 手动执行一次多设备同步
doramonitor -v       # 版本
```

### web

- 默认 `127.0.0.1:3847`，自动打开浏览器；`--port / --host / --no-open` 可调。
- 端口被占（`EADDRINUSE`）→ 中文提示换端口并以退出码 1 结束。
- 启动横幅包含版本号、各工具检测状态（不可用标 `(not found)`）与隐私声明。

### tools

逐行打印每个工具：`<label> <ok|未检测到> <id> [（仅 credits 计费）]`，
以及对应数据目录。示例：

```
Kimi Code          ok        kimi-code            数据: C:\Users\you\.kimi-code
QoderCN CLI        ok        qoder-cn-cli         （仅 credits 计费）
Codex              未检测到   codex                数据: —
```

### sync

- 未启用同步配置 → 提示在 `~/.doramonitor/config.json` 配置 `sync` 段后重试，
  退出码 1。
- 否则强制 collect → 上传本机摘要 → 在线拉取 peers；打印上传结果、拉到的设备
  数（失败时提示"使用缓存 N 台设备"）与每台 peer 的数据天数。

## 2. status：单行状态摘要

`node src/cli.js`（或 `doramonitor status`）输出一行，形如：

```
K: 12.3M ¥45.60 2.10x 命中:87% | Z: 3.1M ¥2.20 | QC: 320 credits
```

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--tool` | `all` | 指定 provider id 或 `all` |
| `--range` | `month` | `today / 7d / 30d / month / all`；**month 为当月 1 日 0 点（日历口径）**，注意与仪表盘的滚动窗口不同 |
| `--style` | `plain` | `plain` 或 `tmux` |
| `--local` | — | 只统计本机（不合并 peer 缓存） |
| `--plan-price` | — | Kimi 套餐月价（元），用于计算"杠杆"（已用费用/套餐价） |
| `--currency` | — | 覆盖货币符号 |
| `--status-file` | `~/.doramonitor/status.cache` | daemon 输出目标 |
| `--interval` | 30（daemon 模式，下限 5s） | 刷新间隔 |

### 渲染细节

- 每工具一段：`<短标签>: <tokens> <费用> [<credits>] [<杠杆>x] [命中:<pct>%]`。
  短标签映射：kimi-code→`K`、zcode→`Z`、qoder-cn→`Q`、qoder-cn-cli→`QC`、
  claude-code→`CC`、dsh→`dsh`；codex 无缩写，显示原 id。
- 货币符号优先级：CLI flag > settings.currencySymbol >
  `~/.kimi-code/kimi-status.toml` 的 `currency_symbol` > `"$"`。
- 杠杆 = Kimi 费用 / plan-price；tmux 样式按杠杆配色：
  ≥1 → red，≥0.7 → colour208（橙），≥0.3 → yellow，否则 green。
- 启用了同步且未给 `--local` 时，合并 `remote-cache` 里的 peer 记录（与仪表盘
  合并视图一致）。

## 3. daemon：常驻守护进程

```
node src/cli.js daemon [--interval 30] [--tool all] [--style tmux] [--status-file ...]
```

### 行为

- **单实例守卫**：pid 文件 `~/.doramonitor/daemon.pid`；已有活进程 → 打印
  "已在运行" 并以 0 退出；陈旧 pid 文件直接覆盖。
  - 活性检测：`process.kill(pid, 0)`；非 Windows 再读 `/proc/<pid>/cmdline`
    匹配 `cli.js|ai-usage|doramonitor`，防止 pid 复用导致永久误判。
- 启动立即执行一次 tick，然后每 `interval` 秒一次：
  - 渲染状态行 → **原子写**（tmp + rename）到 `status.cache`；
  - 每 60 秒执行额度采样与标准定期测算；每 15 秒刷新 PID 心跳，Web 在 daemon 健康时不再重复采样，
    心跳过期约两分钟后自动接管；
  - 每 `max(60, settings.sync.syncInterval || 300)` 秒额外执行一次强制
    collect + runSync；每次尝试后写 `sync.state`，保留最近成功时间、失败原因与对端设备。
- SIGINT/SIGTERM 停止采样器并清理 pid 文件后退出。
- `doramonitor daemon --background`（或 `-d`）跨平台脱离终端启动，复用健康实例并等待 PID 心跳确认；
  其余 daemon 参数原样传递。`scripts/start-windows.bat` 依次后台启动 daemon 和 Web，登录自启仍由独立的
  `scripts/register-autostart.ps1` 负责。
- 启动输出示例：`DoraMonitor daemon: pid 12345，每 30s 写入 ~/.doramonitor/status.cache；每 60s 采样额度并检查同步设置`。

### stop

- 无 pid 文件 / pid 已失效 → 提示并清理，退出码 0；
- 进程存活 → SIGTERM，删除 pid 文件。

## 4. tmux 集成示例

`~/.tmux.conf`：

```tmux
set -g status-right '#(~/.doramonitor/status.cache 读不动时可直接 cat；或跑一次性命令)'
# 推荐：daemon 已把缓存写好，直接 cat 即可（零开销）：
set -g status-right '#(cat ~/.doramonitor/status.cache)'
```

要点：**不要在 tmux 中直接运行 `doramonitor status`**（每次渲染都是一次全量
扫描的成本）；让 daemon 维护缓存文件，状态栏只 cat。tmux 样式（`--style tmux`）
的颜色转义序列已按上述杠杆阈值生成，缓存文件内容即最终显示行。

## 5. Windows 静默常驻

daemon 与 web 在 Windows 上的常驻（隐藏窗口、计划任务自启、崩溃自动拉起）见
[部署与运行 → Windows 自启](./deployment.md)。核心：

- `daemon-hidden.vbs`：隐藏启动 `doramonitor.js daemon`（不等待）。
- `web-hidden.vbs`：隐藏启动 `server.js` 并**驻留等待**（Node 退出时 VBS 以
  非零码退出，供计划任务的 RestartCount 感知并重启）。
- 两者均由 `scripts/register-autostart.ps1` / `install-windows.ps1` 现场生成。

## 6. 后台健康检查

`web --background` 启动前和启动后都请求 `/api/health`，而不是只检查端口是否能连接。
端口被其他程序占用时不会误报为 DoraMonitor 已运行；只有健康接口返回 `{ "ok": true }`
才会复用现有实例或报告启动成功。
