# 部署与运行

## 1. 环境要求

- Node.js **18+**，推荐 **22.15+**。
- Node 22.5+ 使用内置 `node:sqlite`；Node 22.15+ 还可使用原生 zstd。旧版 Node 的 ZCode/QoderCN 读取器需要 `sqlite3` CLI。
- zstd 优先使用 Node 原生能力，旧版自动回退到运行时依赖 `fzstd`。
- 不需要数据库服务、Rust 工具链或管理员权限。

## 2. 启动方式

| 方式 | 命令 | 行为 |
| --- | --- | --- |
| npm 前台 | `doramonitor` | 当前终端运行并打开浏览器 |
| 源码前台 | `npm start` | 使用仓库中的 `dist/` |
| 后台（跨平台） | `doramonitor web --background --no-open` | 脱离终端，不打开浏览器 |
| Windows 双击 | `scripts/start-windows.bat` | 调用上面的后台命令，路径可迁移 |
| Windows 登录自启 | `scripts/register-autostart.ps1` | 隐藏窗口、登录启动、Web 崩溃重启 |
| 开发模式 | `npm run dev` | API + Vite 热更新 |

后台命令会先检查端口，已监听时不会重复启动。Windows 注册脚本还会在安装目录生成 `web-hidden.vbs`、`daemon-hidden.vbs` 和 `start-doramonitor.bat`。

常用参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` | `127.0.0.1` | 监听地址；不要无保护地改成 `0.0.0.0` 或 `::` |
| `--port`, `-p` | `3847` | HTTP 端口 |
| `--home`, `--dir` | 自动检测 | Kimi Code 数据目录（直接运行 `src/server.js` 时） |
| `--no-open` | — | 不自动打开浏览器 |

## 3. Windows 一键安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -WithWeb -Start
```

- 优先使用 PATH 中 Node 18+；没有可用 Node 时，从 nodejs.org 下载便携 Node 22。
- 从公共 npm registry 安装 `doramonitor`，不包含私人服务器、SSH 或同步默认值。
- `-WithWeb` 注册隐藏登录任务；`-Start` 安装后立即后台启动。两个开关都可省略。

已有安装只需注册自启：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/register-autostart.ps1
```

移除自启：

```powershell
Unregister-ScheduledTask -TaskName doramonitor-daemon,doramonitor-web -Confirm:$false
```

## 4. 源码部署与更新

首次克隆后可直接使用跨平台部署脚本：

```bash
npm run deploy
```

脚本检查 Node 18+，执行 `npm ci` 和前端构建，但不会自动启动或打开浏览器。常用选项：

```bash
npm run deploy -- --skip-install       # 复用 node_modules，仅构建
npm run deploy -- --start              # 构建后前台启动
npm run deploy -- --background         # 构建后后台启动
npm run deploy -- --background --port 3848
```

日常更新建议同时运行质量门禁：

```bash
git pull
npm ci
npm test
npm run build
```

修改 `src/` 后必须重启 Web 服务。所有设置保存后立即生效；daemon 每分钟读取最新同步配置。

## 5. 验证与日志

- 健康检查：`http://127.0.0.1:3847/api/health` 应返回 `{ "ok": true }`。
- 工具检测：`doramonitor tools` 查看各工具是否可用及数据目录。
- daemon 状态：`~/.doramonitor/daemon.pid`、`status.cache`、`sync.state`。
- 前台启动日志直接显示在终端；后台启动故障时改用前台命令定位。

## 6. 故障排查

**端口被占用**：改用 `doramonitor web --port 3848`，或停止已有实例。后台命令检测到端口已监听时不会强行启动第二个进程。

**页面无法访问**：优先使用 `127.0.0.1` 而不是可能解析到 IPv6 的 `localhost`；检查服务是否仍在运行。

**某工具显示未检测到**：运行 `doramonitor tools` 核对目录，再检查对应环境变量和 `/api/summary` 中该工具的 `meta.errors`。

**SQLite 不可用**：升级 Node 22.5+，或安装 `sqlite3` CLI 并加入 PATH。

**前端是旧版本**：源码更新后重新 `npm run build` 并重启服务。静态资源使用内容哈希，正常刷新即可。

**同步未启用**：多设备同步默认关闭。在「同步」页显式启用并填写连接配置后才会上传聚合用量；也可直接编辑 `~/.doramonitor/config.json`。
