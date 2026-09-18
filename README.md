# AI Usage Monitor

本地、隐私安全的 **AI 编码工具用量看板**：一个页面汇总 Kimi Code、ZCode、QoderCN、QoderCN CLI、Codex 的 token 用量、费用与额度。

由 [kimicode-dashboard](https://github.com/JochenYang/kimicode-dashboard) 架构扩展而来（React 19 + Tailwind + Node 标准库 HTTP server，零后端框架依赖；SQLite 读取使用 Node 22 内置 `node:sqlite`）。

![截图](assets/screenshot.png)

## 支持的工具

| 工具 | 数据来源（只读） | 统计内容 |
|---|---|---|
| Kimi Code | `~/.kimi-code/sessions/**/wire.jsonl`（全部 agent 目录） | token、估算费用（Kimi 官方价）、套餐杠杆、5h/7d 额度与重置时间 |
| ZCode | `~/.zcode/cli/db/db.sqlite` → `model_usage` | token（含 reasoning/cache 分项） |
| QoderCN（IDE） | `~/.config/QoderCN/SharedClientCache/cache/db/local.db` → `chat_message` | token（内部模型码自动映射显示名） |
| QoderCN CLI | `~/.qoder-cn/projects/**/*.jsonl` | **credits 计费值**（CLI 不落地 token，仅记录 credits） |
| Codex | `~/.codex/sessions/**/*.jsonl` + `archived_sessions` | token（`token_usage_record`，按 `response_id` 去重；模型/cwd 取自 `turn_context`）、费用（OpenAI 官方价） |

- 所有 SQLite 均以**只读模式**打开，不影响运行中的工具。
- 每个工具的数据缺失时自动降级为「不可用」，不影响其他工具展示。

## 快速开始

需要 Node.js **22.5+**（内置 `node:sqlite`）；Node 20 亦可运行，SQLite 读取自动回退到 `sqlite3` CLI（需在 PATH 中）。

```bash
npm install
npm run build    # React UI → dist/
npm start        # http://127.0.0.1:3847
```

开发模式（API + Vite 热更新）：

```bash
npm run dev
```

### 功能

- **工具页签**：全部 / 单工具切换，页签上直接显示各自用量
- **设备页签**：多设备时显示 合并 / 本机 / 各设备，数字随选择联动
- **联网搜索统计**：解析 kimi 会话 `tool.call` 事件，统计 WebSearch / FetchURL 次数
- **时间范围**：今天 / 近 7 天 / 近 30 天 / 全部
- **范围 KPI 卡**：各范围 token、请求数、费用、命中率（随工具过滤联动）
- **货币与自定义定价**：显示货币切换（USD/CNY + 汇率），为任意模型录入自定义单价（支持 CNY 录入），保存后自动重算全部费用
- **Kimi 额度卡**：5 小时滚动窗口 + 每周额度（自订阅日每 7 天刷新），显示精确重置倒计时；OAuth 凭证过期自动续期
- **联网搜索统计**：解析 kimi 会话的 `tool.call` 事件，统计 WebSearch / FetchURL 次数（KPI 卡展示）
- **年度热力图**：GitHub 风格每日 token 强度
- **每日趋势**：Top 模型多序列曲线
- **模型统计 / 最近请求**：带工具维度与 credits 列
- **会话管理**（Kimi）：按工作区归档 / 恢复 / 删除
- **模型配置**（Kimi）：config.toml 别名与价格映射

## 命令行

安装命令（软链到 `~/.local/bin`，已在 PATH 即可直接使用）：

```bash
ln -sf "$PWD/src/ai-usage.js" ~/.local/bin/ai-usage
```

```bash
ai-usage                    # 启动 Web 仪表盘（默认打开浏览器）
ai-usage status             # 单行用量状态（适合 shell prompt）
ai-usage status --style tmux
ai-usage daemon             # 守护进程：写状态缓存 + 周期同步
ai-usage stop               # 停止守护进程
ai-usage sync               # 立即上传/拉取各设备用量
ai-usage tools              # 列出检测到的工具与数据源
```

输出示例（`--plan-price 199 --currency ¥`）：

```
Z:287.7M | K:852.0M ¥261.79 | QC:3924cr | Q:107.7K (1.32x) 命中:96.7%
```

- 杠杆（`1.32x`）仅在配置了套餐价时显示，默认读取 `~/.kimi-code/kimi-status.toml` 的 `plan_price` / `currency_symbol`，也可用 `--plan-price` 覆盖。
- daemon 缓存文件默认 `~/.ai-usage-monitor/status.cache`，tmux 可直接读取。

## Windows 一键安装

在 Windows PowerShell 中（两行，逐行执行）：

```powershell
curl.exe -o install-windows.ps1 http://<ubuntu-ip>:8765/install-windows.ps1
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -WithWeb
```

脚本自动完成：便携版 Node 22、应用安装、同步配置（CNY 显示 / 设备名 / 指向 Ubuntu）、
SSH 免密推送（输入一次 Ubuntu 密码）、首次同步、登录自启（daemon 隐藏运行 +
本地看板 http://127.0.0.1:3847）。安装后任意 PowerShell 可直接使用 `ai-usage` 命令。

维护者打包方式（Ubuntu 侧）：

```bash
git ls-files > /tmp/fl.txt
tar czf ai-usage-monitor-win.tar.gz -T /tmp/fl.txt dist node_modules/smol-toml
# python3 -m http.server 8765 --bind <ip> --directory <dir>  提供下载点
```

`node_modules/smol-toml` 是唯一运行时第三方依赖，必须随包分发。

仓库根目录另附两个 Windows 便捷启动器：`start-ai-usage.bat`（最小化窗口启动本地看板）和 `daemon-hidden.vbs`（无窗口启动 daemon，供计划任务调用）。

## 跨设备同步

每台设备把**按天聚合**的用量摘要（每天/每工具/每模型的 token 与 credits，一年约十几 KB）上传到共享后端，看板合并显示并支持按设备筛选。

```jsonc
// ~/.ai-usage-monitor/config.json 的 sync 段
"sync": {
  "enabled": true,
  "backend": "ssh",            // "ssh" 或 "webdav"
  "deviceName": "ubuntu4090-ts",
  "syncInterval": 300,         // daemon 同步间隔（秒）
  "ssh": { "host": "127.0.0.1", "user": "zxt", "port": 22,
           "remotePath": "~/.kimi-status-sync" },
  "webdav": { "url": "https://...", "username": "...", "password": "..." }
}
```

- 远端文件：`<remotePath>/ai-usage-monitor/<device>.json`（SSH）或 `<url>/ai-usage-monitor/<device>.json`（WebDAV）
- 对端文件缓存在 `~/.ai-usage-monitor/remote-cache/`，网络不可达时看板自动降级使用缓存
- 触发方式：`ai-usage sync` 手动、`ai-usage daemon` 周期、仪表盘「立即同步」按钮
- 看板顶部出现「设备」页签（合并/本机/各设备），数字随选择联动
- 从旧 kimi-status 迁移：沿用相同 SSH 拓扑，新旧文件互不干扰

## Kimi 额度口径说明

Kimi 的额度模型**没有月度窗口**（官方文档）：

- **每周额度**：自订阅日起每 7 天自动刷新；
- **5 小时窗口**：滚动限速，窗口结束自动恢复。

看板通过 `GET https://api.kimi.com/coding/v1/usages` 获取两个窗口的已用百分比与官方重置时间。凭证为 15 分钟短效 token：过期时看板自动用 refresh_token 续期并按 kimi CLI 的格式写回 `~/.kimi-code/credentials/kimi-code.json`，与 kimi CLI 共享同一份凭证轮换；续期失败时额度卡显示原因，不影响本地统计。

## 货币与自定义定价

「模型 → 定价与货币」页：

- **显示货币**：USD 或 CNY；CNY 按可配置汇率（默认 7.2）由内部 USD 成本换算显示。
- **自定义模型定价**：为官方价格表没有的模型（GLM、DeepSeek 等）录入单价，每 1M tokens 三分项（输入 / 缓存命中 / 输出），币种可按行选择。匹配规则：模型名大小写不敏感，先精确后子串，最长模式优先；留空分项沿用官方参考价。保存后自动全量重算。

配置持久化在 `~/.ai-usage-monitor/config.json`；所有工具（Kimi / ZCode / QoderCN / Codex）的费用统一按此计算。

- Kimi 模型按 [Kimi API Platform](https://platform.kimi.ai/) 官方价；Codex 的 OpenAI 模型按 OpenAI 官方价（GPT-6 Astra、GPT-5.6 Sol/Terra/Luna、GPT-5 系列等，见 `src/pricing.js` 的 `OPENAI_PRICES`）。无公开价的型号（如 `codex-auto-review`）按近似价估算并在界面标注「估算」。

QoderCN CLI 仅记录 credits 计费（日志中 token 字段全为 0），看板会显示 credits 提示并以 credits 作为其费用口径。

## 架构：新增一个工具只需一个文件

```
src/
  providers/
    base.js          # 统一数据模型与工具函数
    index.js         # 注册表 + 数据源文件探测（增量缓存用）
    kimi-code.js     # wire.jsonl 扫描
    zcode.js         # node:sqlite 只读查询
    qoder-cn.js      # node:sqlite + 模型码映射
    qoder-cn-cli.js  # jsonl 转录扫描
    codex.js         # rollout jsonl 扫描（token_usage_record）
  collect.js         # 增量收集器（stat 探测 + TTL 缓存）
  aggregate.js       # 时间范围 / byTool / 热力图聚合
  quota.js           # Kimi 额度 API 客户端
  cli.js             # 状态行 + daemon
  server.js          # HTTP API + 静态资源（gzip + immutable 缓存）
```

统一记录模型：`{ tool, time, model, inputOther, output, inputCacheRead, inputCacheCreation, costUsd, credits, project, session }`。

新增工具：在 `src/providers/` 写一个 `{ id, label, defaultHome, isAvailable, scan }` 模块并注册进 `index.js` 的 `PROVIDERS` 数组即可，聚合、API、UI 自动生效。

### 性能设计

- 收集层：15s TTL 内存缓存 + 文件 stat 增量探测，未变化不重扫
- 聚合层：4 个时间范围 + 热力图按扫描代数缓存，TTL 内零重算
- 传输层：文本资源 gzip；Vite 内容哈希分块（react/motion/radix 独立 chunk）配 immutable 缓存

## 隐私

只读取模型名、时间戳与 token 计数等**用量元数据**；提示词、回复、代码、API Key 与凭据一律不读取、不展示、不存储。

## 测试

```bash
npm test   # node --test，含 provider 鲁棒性 / 额度解析 / 聚合过滤用例
```

## License

MIT（继承 kimicode-dashboard）
