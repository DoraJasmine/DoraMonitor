# 部署与运行

本文覆盖 DoraMonitor 的所有运行方式：开发模式、npm 生产运行、Windows 一键
安装器、计划任务自启、静默启动，以及日志查看与常见故障排查。

## 1. 环境要求

- **Node.js 18+**（`engines` 声明）。
  - SQLite 只读优先用 Node 22.5+ 的内置 `node:sqlite`；更老版本需要系统装有
    `sqlite3` CLI（用于 ZCode / QoderCN IDE 两个 provider）。
  - zstd 解压：Node 22+ 有原生 `zlib.zstd*`；旧 Node 回退纯 JS 的 `fzstd`
    （功能等价，仅慢一些）。
- 无需数据库、无需管理员权限。

## 2. 运行方式对比

| 方式 | 命令 | 窗口 | 适合 |
| --- | --- | --- | --- |
| 开发模式 | `npm run dev` | 终端 | 改前端代码（Vite 热更新 + API 3847） |
| 生产（前台） | `npm start` | 终端 | 临时使用、调试 |
| 最小化窗口 | 双击 `start-doramonitor.bat` | **有一个最小化终端窗口，关掉即服务停止** | 临时后台用 |
| **静默常驻（推荐）** | 双击 `web-hidden.vbs` | **无任何窗口**（wscript.exe 驻留托管） | 日常常驻 |
| 计划任务自启 | `scripts/register-autostart.ps1` | 无窗口 + 登录自启 + 崩溃自动重启 | 长期部署 |
| npm 全局命令 | `npm i -g .` 后 `doramonitor` | 终端 | 命令行用户 |

> 三份根目录启动文件（`.bat` / `.vbs`）是**生成物**，由
> `scripts/register-autostart.ps1` 按你的安装路径现场生成（node 路径探测：
> `%LOCALAPPDATA%\ai-usage-node\node.exe` → `%ProgramFiles%\nodejs\` → x86 路径
> → PATH）。手工迁移安装位置后请重跑注册脚本。

### 各方式的注意点

- **`start-doramonitor.bat`**：`start "doramonitor" /min node.exe src\server.js --no-open`
  —— 有一个最小化终端窗口，**关窗口 = 服务终止**；进程也不脱离启动它的父进程。
- **`web-hidden.vbs`**：`Wscript.Shell.Run "...server.js --host 127.0.0.1 --port 3847 --no-open", 0, True`
  —— 窗口风格 0 = 完全隐藏；`True` = wscript 驻留等待 Node。任务管理器里会看到
  常驻 `wscript.exe`，这是设计如此，**不要结束它**（结束 = 服务停止）。
- **`daemon-hidden.vbs`**：同上但跑 `doramonitor.js daemon` 且不等待（Fire and
  Forget）。

## 3. npm 方式（通用）

```bash
git clone https://github.com/DoraJasmine/DoraMonitor.git
cd DoraMonitor
npm install
npm run build      # 构建前端到 dist/
npm start          # http://127.0.0.1:3847/
```

服务端参数（`src/server.js`）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port`, `-p` | 3847 | 端口 |
| `--host` | 127.0.0.1 | 绑定地址 |
| `--home`, `--dir` | 自动检测 | Kimi Code 数据目录 |
| `--no-open` | — | 不自动打开浏览器 |
| `-h`, `--help` | — | 帮助 |

启动时若 `dist/` 不存在会回退到遗留的 `public/` 目录；正常部署请先
`npm run build`。

## 4. Windows 一键安装器（scripts/install-windows.ps1)

面向"从局域网/Tailscale 服务器下载离线包"的场景：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -WithWeb
```

参数：`-Server`（离线包地址，默认 Tailscale IP）、`-SyncHost/-SyncUser`（SSH
同步目标）、`-DeviceName`（本设备在仪表盘上的名字）、`-WithWeb`（同时注册 Web
自启）。

执行内容（按序）：

1. 下载便携版 Node v22.17.0 到 `%LOCALAPPDATA%\doramonitor-node\`（已存在跳过；
   $Server 失败回落 nodejs.org 官方源）。
2. 下载 `doramonitor-win.tar.gz` 解压到 `%USERPROFILE%\DoraMonitor`
   （打包方式见脚本头注释；离线包额外带唯一运行时依赖 `node_modules/smol-toml`）。
3. 写同步配置 `~/.doramonitor/config.json`（CNY、fxRate 7.2、sync 启用 SSH、
   deviceName、300s 间隔、`~/.kimi-status-sync`）。
4. 配 SSH 免密：生成 `~/.ssh/id_ed25519`（Win32-OpenSSH 空口令写法 `-N '""'`），
   公钥追加到远端 `authorized_keys`。
5. 首次执行 `doramonitor.js sync`。
6. **注册登录自启计划任务**（`Register-ScheduledTask`，AtLogOn 触发，无需管理员）：
   - `doramonitor-daemon`：经 `daemon-hidden.vbs` 隐藏启动 daemon；
   - `doramonitor-web`（`-WithWeb` 时）：经 `web-hidden.vbs` 隐藏启动 web，任务
     设置 `-RestartCount 999 -RestartInterval 1min -ExecutionTimeLimit 0`
     ——**崩溃后每分钟自动拉起，无 72 小时执行上限**。
7. 写 PATH 垫片：`%LOCALAPPDATA%\Microsoft\WindowsApps\doramonitor.cmd`
   （内容为 node + src\doramonitor.js），任意终端可直接敲 `doramonitor`。

**卸载**：脚本无卸载功能，手动执行

```powershell
Unregister-ScheduledTask -TaskName doramonitor-daemon,doramonitor-web -Confirm:$false
```

### 只注册自启（已有安装布局）

`scripts/register-autostart.ps1`：自动定位安装目录与 node，生成三个启动器并
注册同样的计划任务，`-Force` 可重复执行。

`scripts/fix-daemon.ps1`：历史补丁脚本——把旧的 daemon 计划任务改为 VBS 隐藏
启动；无管理员权限时回退为把 VBS 复制到用户 Startup 文件夹。

## 5. 更新流程

```bash
cd DoraMonitor
git pull
npm install          # 依赖变化时
npm run build        # 前端有改动时
npm test             # 可选但建议
# 重启服务：
#  计划任务方式：结束 node 进程（任务计划器会自动拉起 web）
#  手动方式：结束进程后重新双击 web-hidden.vbs
```

**改了 `src/` 代码必须重启服务**——价格表等模块在 Node 启动时加载进内存。
例外：设置类（汇率、自定义价格、同步配置）保存即生效（后端强制重扫）。

## 6. 日志与验证

| 项 | 位置/方法 |
| --- | --- |
| 健康检查 | `curl http://127.0.0.1:3847/api/health` → `{"ok":true}` |
| 价格表生效验证 | `curl http://127.0.0.1:3847/api/prices` 里应能看到 `kimi-k3.1-pro` 等新行 |
| 服务标准输出 | 手动启动时在控制台；仓库根的 `server.out.log` / `server.err.log` 是手工重定向的历史日志（gitignore 内） |
| daemon 状态 | `~/.doramonitor/daemon.pid`（pid）、`~/.doramonitor/status.cache`（最新状态行）、`~/.doramonitor/sync.state`（最近同步） |
| 工具检测 | `doramonitor tools` |

## 7. 故障排查（FAQ）

**Q：浏览器打不开 `localhost:3847`（提示"localhost 拒绝连接"），但 127.0.0.1 能开**
浏览器把 `localhost` 解析成 IPv6 的 `::1`，而服务默认只绑 IPv4 的 127.0.0.1。
用 `http://127.0.0.1:3847/` 访问。不要把 `--host` 改为 `::` 或 `0.0.0.0`：
它们会监听所有网卡，可能让同一网络中的其他设备访问本机用量与会话接口。

**Q：浏览器打不开 127.0.0.1:3847（连接被拒绝）**
先 `netstat -ano | findstr 3847` 看是否监听。没监听 → 服务没起来：检查是否用
了"最小化窗口"方式且窗口被关；改用 `web-hidden.vbs` 静默启动，或检查计划任务
状态（`Get-ScheduledTask doramonitor-*`）。

**Q：重启后价格表还是旧的**
改的是 `src/` 代码但没重启服务（Node 启动时加载价目表）。重启并强刷页面
（Ctrl+F5，前端静态资源有 immutable 缓存，但文件名带哈希，正常刷新即可）。

**Q：某个工具的用量是 0 / 工具显示未检测到**
`doramonitor tools` 看数据目录是否指向正确；对应 provider 的环境变量是否生效；
`/api/summary` 响应里 `meta.<tool>.errors` 有具体解析错误（≤20 条）。

**Q：费用明显偏高/偏低**
按顺序检查：`/api/summary` 里该模型的 `modelDisplay` / `priceId` 是否映射对了
（路由码映射见[数据源与采集](./providers.md)第 8 节）；`/api/prices` 里该模型的
行与官方页是否一致；是否有自定义价格命中（子串匹配可能过宽）；DeepSeek 注意
峰谷时段与时间戳缺失时按峰价保守估计。

**Q：SQLite provider（ZCode/QoderCN）报 No SQLite backend**
升级 Node ≥ 22.5，或安装 sqlite3 CLI 并加入 PATH。

**Q：会话预览是空的/被截断**
预览重建依赖 `agents/main/wire.jsonl`（或根 `wire.jsonl`）；上限 80 条消息，
`truncated: true` 表示内容被截断——这是设计上限，不是数据丢失。

**Q：同步设备页签不出现**
检查 `config.json` 的 `sync.enabled`；SSH 后端先手动 `ssh <host> true` 验证免密；
看 `~/.doramonitor/remote-cache/` 是否已拉到对端文件（缓存模式下页签也可见）。
