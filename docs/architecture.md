# 架构总览与数据流

本文描述 DoraMonitor 的整体架构：数据从各工具的本地文件出发，经过采集、聚合、计价，
最终呈现在 Web 仪表盘、CLI 状态行与守护进程缓存中的完整链路。

## 1. 一图看懂

```
 ┌────────────────────────── 本机数据源（只读） ──────────────────────────┐
 │  Kimi Code        ~/.kimi-code/sessions/**/wire.jsonl                  │
 │  ZCode            ~/.zcode/cli/db/db.sqlite          (SQLite, 只读)     │
 │  QoderCN (IDE)    %APPDATA%/QoderCN/.../local.db     (SQLite, 只读)     │
 │  QoderCN CLI      ~/.qoder-cn/projects/**/*.jsonl                     │
 │  Codex            ~/.codex/sessions/** + archived_sessions/** (.zst)  │
 │  Claude Code      ~/.claude/projects/**/*.jsonl                       │
 │  dsh              ~/.dsh/sessions/**  (.jsonl.zstd 多帧)               │
 └──────────────────────────────┬────────────────────────────────────────┘
                                │ providers/*.scan(home)  只读元数据
                                ▼
 ┌─────────────────── 采集层 collect.js（15s 增量缓存）───────────────────┐
 │  文件戳探测(mtime+size) → 未变则复用旧 records → 变了才重扫              │
 │  产出: records[](time 降序) + events[](tool.call) + quota 快照          │
 └──────────────────────────────┬────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────────┐
        ▼                       ▼                           ▼
 ┌─────────────┐        ┌──────────────┐            ┌────────────────┐
 │ aggregate.js │        │ pricing.js   │            │ sync.js        │
 │ 按范围/模型  │        │ 每条记录     │            │ 日粒度摘要     │
 │ 聚合/热力图  │        │ costForUsage │            │ 上传/拉取 peer │
 └──────┬──────┘        └──────┬───────┘            └───────┬────────┘
        │                      │  内部一律 CNY 账本           │
        ▼                      ▼                            ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │                    server.js  http://127.0.0.1:3847                   │
 │   /api/summary  /api/prices  /api/sessions  /api/config  /api/quota   │
 │   静态托管 dist/（Vite 构建的 React SPA，含 SPA 回退与 gzip）            │
 └──────────────────────────────┬───────────────────────────────────────┘
                                ▼
                    浏览器 / Tauri 桌面壳（同一套前端）

 旁路：cli.js status/daemon → 写 ~/.doramonitor/status.cache（tmux 状态栏）
      quota.js → Kimi 在线 usages API（额度，唯一的外网只读调用）
```

## 2. 技术栈与运行形态

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 后端 | 纯 Node.js（无 Express），`src/server.js` | 原生 `http.createServer`，路由手写 |
| 前端 | React 19 + Vite 6 + Tailwind 3 | 源码在 `web/`，构建产物 `dist/` |
| UI 基建 | Radix UI（Dialog/Select/Tabs/Slot）+ CVA + lucide 图标 + framer-motion | shadcn 风格 |
| TOML | `smol-toml` | 读写 Kimi Code 的 `config.toml` |
| 解压 | `zlib.zstd*`（Node 原生）→ `fzstd`（纯 JS 回退） | Codex `.zst` / dsh `.zstd` |
| SQLite | `node:sqlite`（Node 22.5+）→ `sqlite3` CLI shim 回退 | ZCode / QoderCN 只读查询 |
| 测试 | Node 内置 test runner（`node --test`） | `npm test`，无第三方框架 |

**两种运行形态，同一套前端**：

1. **Web 形态**：Node 服务托管 `dist/` 并提供 `/api/*`；浏览器访问。
2. **Tauri 桌面形态**（预留）：前端通过 `web/src/lib/backend.js` 透明切换到
   `invoke()` 调用 Rust 命令，payload 形状与 `/api/*` 完全一致。当前仓库不含
   Tauri 壳源码，但前端与配置为其保留了兼容（`base: "./"`、`@tauri-apps/api`
   chunk 等）。

## 3. 模块地图（src/）

| 模块 | 行数级 | 职责 |
| --- | --- | --- |
| `server.js` | ~730 | HTTP 服务：26 个 `/api/*` 端点、静态托管、SPA 回退、gzip、安全防护 |
| `collect.js` | ~130 | 采集调度：15s TTL 增量缓存、文件戳探测、单 provider 故障隔离 |
| `providers/index.js` | ~140 | provider 注册表、可用性探测、增量缓存用的源文件清单 |
| `providers/base.js` | ~170 | 共享基础：记录形状、工具元数据、home 展开、SQLite 后端 |
| `providers/kimi-code.js` | ~240 | Kimi Code：wire.jsonl 解析、fork 去重、tool.call 事件 |
| `providers/zcode.js` | ~140 | ZCode：SQLite `model_usage` 表 → 记录 |
| `providers/codex.js` | ~310 | Codex：rollout 文件（含 zst）、response_id 去重、rate_limits 快照 |
| `providers/claude-code.js` | ~170 | Claude Code：projects/*.jsonl、message.id 去重 |
| `providers/dsh.js` | ~230 | dsh：多帧 zstd、session 头、message.id 去重 |
| `providers/qoder-cn.js` | ~200 | QoderCN IDE：SQLite `chat_message`、token_info JSON |
| `providers/qoder-cn-cli.js` | ~180 | QoderCN CLI：credits-only，两层目录遍历 |
| `aggregate.js` | ~420 | 范围过滤、模型分组、每日趋势（top6+others）、热力图、工具聚合 |
| `pricing.js` | ~790 | 八张价目表、匹配、峰谷/节假日、长上下文、自定义价、CNY 账本 |
| `model-map.js` | ~155 | Kimi 专属：config.toml 别名 + 环境变量模型 → 展示/计价身份 |
| `model-identity.js` | ~175 | 通用模型身份：QoderCN 路由码/dsh 插件码 → 显示名 + 计价键 |
| `sessions.js` | ~710 | 会话枚举、归档/恢复/删除、安全预览（重建 + 脱敏） |
| `config-store.js` | ~550 | Kimi `config.toml` 读写（smol-toml）、掩码视图、目录导入落盘 |
| `catalog.js` | ~450 | models.dev 目录：在线 → 磁盘缓存 → 内置快照三级回退 |
| `settings.js` | ~175 | 全局设置 `~/.doramonitor/config.json`：默认值、校验、原子写 |
| `sync.js` | ~460 | 多设备同步：SSH / WebDAV 后端、摘要构建/还原、对端缓存 |
| `quota.js` | ~290 | Kimi 额度在线客户端：token 刷新、usages 解析、60s 缓存 |
| `cli.js` | ~380 | 状态行渲染 + daemon（pid 文件、单实例、定时写缓存、定时同步） |
| `doramonitor.js` | ~190 | 统一 CLI 入口（web/status/daemon/stop/tools/sync） |
| `paths.js` | ~75 | Kimi 数据目录解析（override → env → 默认） |
| `i18n.js` | ~120 | 后端侧 zh/en 文案与语言探测（Accept-Language → env → Intl） |
| `data/builtin-catalog.json` | 2.0MB | models.dev 完整镜像（193 provider / 7243 模型），离线兜底 |

## 4. 数据流详解

### 4.1 采集（collect.js）

- `collect({force})` 是唯一入口，带 **15 秒内存 TTL**（`COLLECT_TTL_MS`）：
  - TTL 内且未强制 → 直接返回快照并标记 `fromCache: true`；
  - 否则对每个 provider 做**文件戳探测**（路径+mtimeMs+size，stat-only）：
    戳未变 → 复用上次 records（不重扫）；变了 → 重扫。
- **按文件增量缓存**（kimi-code / codex / dsh 三个大头 provider）：解析结果按
  文件缓存（key = 路径 + mtimeMs + size）。JSONL/rollout 是追加型文件，重扫时
  只有真正变化的文件会被重读重解析，跨文件去重与配额挑选在廉价的后处理里跑
  （对已解析记录做一次哈希 + 排序）。缓存按 home 命名空间隔离；
  `collect.invalidate()` 会同时清空 provider 的文件缓存——费用设置变更后
  成本必须重算。
- **日聚合桶（阶段 3，已实施）**：每个源文件折算为 `日期×工具×模型×计价档`
  的整数 token 计数并持久化到 `~/.doramonitor/buckets/<toolId>/`（原子写，
  stamp/tzOffset/version 三重校验）。桶**不存费用**——聚合时用当前价目表
  现算（`priceForCell`），厂商调价零失效。窗口内文件的"去重后贡献明细"
  也随桶持久化并在加载后按现行价目重算，因此**冷启动零文件解析**
  （实测 6s → ~300ms）。跨文件去重签名集随桶持久化，配合 mtime 序
  first-wins 与传播窗口保证增量结果与全量一致。回滚开关：
  `DORAMONITOR_DISABLE_BUCKETS=1`。
  原始记录仅保留近 30 天（`RECORD_WINDOW_DAYS`，次级上限 2 万条）供
  "最近请求"表使用；7d/30d 聚合为日历日窗口（与滚动窗口的差异见方案文档）。
  估算标记分两层：折算只记**时间性**估算（无时间戳 DeepSeek，桶 v2 起），
  表行级估算（无价格行的兜底）由查询时 `priceForCell` 现算——因此**价格表
  新增行后，新价格与"官方价"标记自动回溯全部历史，无需清桶**。
  - 单个 provider 抛异常 → 用空结果占位（`meta.errors`），**绝不拖垮其他工具**。
- 快照（records 合并 + 全局排序）按扫描代数缓存一次，TTL 命中路径零重排。
- 快照形状：`{ byTool, records, events, tools, scannedAt }`；`records` 全局按
  `time` 降序。`events` 目前只有 kimi-code 的 `tool.call` 事件（WebSearch、
  FetchURL 等工具调用计数）。
- 会话归档/删除、设置保存后都会调用 `invalidate()` 强制下次全量重扫。

### 4.2 聚合（aggregate.js）

- 范围（`range`）：`today` = 本地当天 0 点起；`7d` / `30d` = 滚动窗口
  （`now - N*86400000`）；`all` 不过滤。CLI 的 `status` 另支持 `month`
  （当月 1 日 0 点，日历口径）。
- 分组键是 `tool + "\0" + model`：同名模型在不同工具下**不合并**。
- `dailyByModel`：取 token 前 6 的模型各成一条序列，其余归入"其他模型"；
  跨度 ≤93 天时补齐日历缺口形成连续曲线，更长则只保留有活动的日期。
- 热力图：53 周、GitHub 风格，单元格按日 token 占最大日比例分 0–4 五档。
- 缓存命中率 = `inputCacheRead / (inputOther + inputCacheRead + inputCacheCreation)`。

### 4.3 计价（pricing.js，详见[计价体系](./pricing.md)）

- **内部账本一律人民币**（`costCny`）：人民币厂商直接用官方 CNY 价；美元厂商
  （OpenAI、Claude、Qwen/MiniMax/hy3）在入账时按 `fxRate` 一次性换算成 CNY。
  展示层要美元时再除回去（`toDisplay`）——**换算只发生一次**，缓存值不改写。
- 服务端在 `/api/summary` 响应层用 `displayCost` 把 CNY 转成用户所选币种。

### 4.4 展示（server.js + web/）

- `/api/summary` 的聚合缓存 key 为 `scannedAt|deviceKey|tool`，一次算齐 4 个
  范围 + 热力图；超过 32 条整体清空。
- 前端**不做 summary 轮询**：挂载、切换范围/工具/设备、手动刷新时各拉一次；
  页脚显示"上次扫描 N 前"。额度卡内部有 60s 的本地倒计时 tick。
- 静态托管：Vite 内容哈希文件名 → `Cache-Control: immutable` 一年；>1KB 的
  js/css/html/svg/json 自动 gzip；`/sessions`、`/models` 等路径 SPA 回退到
  `index.html`。

### 4.5 等效额度测算（quota-*.js）

- `quota-sampler.js` 在 Web 服务内每 60 秒采样 Kimi/Codex 双窗口百分比；Codex 首次启动时
  回补 rollout 中的全部历史 `rate_limits`，Kimi 历史只能从功能上线后积累。
- `quota-models.js` 只纳入目标厂商的模型：GPT 可来自 Codex/OMP，Kimi 可来自 Kimi Code/OMP；
  DeepSeek 等无关模型和未知模型默认排除。Kimi 可选择仅使用 Kimi Code 用量。
- `sync.js` 在原日摘要之外增加 `quotaUsage` 一分钟桶与 `usageWaterMark`，并携带额度样本；
  本机与 WSL 的用量因此能在同一时间区间对齐。旧格式或超过 24 小时的 peer 数据只产生
  低置信度临时估算，新鲜 peer 水位未覆盖区间时则不测算。
- `quota-estimator.js` 从同一窗口内严格增长的百分比构造区间，以 Token 组成和缓存命中率
  做带时间衰减的稳健回归，输出 85% / 90% / 95% / 98% 四档等效 Token 与人民币容量；重置、
  百分比下降及待同步区间不参与计算。样本不足时使用 API 刊例价弱先验推算，明确标记外推，
  并输出 0–100 数据质量评分及原因，不能把评分解释为统计概率。
- 长程稳健估算使用独立的 `longTermTargets`：5h 仅取 ≥30 分钟、weekly 仅取 ≥6 小时的完整
  自动区间，至少 3 个区间和 5 个百分点；排除手动校准样本，历史以 `estimateKind` 隔离。
- `quota-calibration.js` 支持手动设置测算起点、结束和取消；结束强制校验 5 分钟、10K 有效
  Token、1 个百分点增量、窗口未重置及 peer 覆盖，失败保留起点。
- `quota-estimator-store.js` 在 `~/.doramonitor/quota-estimator/` 保存 90 天样本、6 小时
  测算缓存和最高有效纪录；每次实际重算追加到 `history.jsonl`，永久保留完整时间链、模型
  结构和测算元数据，历史接口分页读取。所有结果都是推测值，与官方剩余百分比分开展示；
  当前仅 Web 服务调度采样，daemon 不另行轮询。

## 5. 关键设计决策

| 决策 | 原因 |
| --- | --- |
| 运行时依赖只有 2 个 | 支持离线 tar 包分发（Windows 安装器只额外带 `node_modules/smol-toml`） |
| 内部 CNY 单一账本 | 多币种厂商混算时只换算一次，避免汇率被乘除多次；显示层随意切换 |
| `usageScope === "turn"` 才计数 | Kimi wire 里同时有 turn 级与 session 级汇总，只取 turn 防双算 |
| 值元组签名去重（kimi） | fork 会话逐字节复制父 wire.jsonl，实测重复 ~15% 记录 / ~26% token |
| stat-only 文件戳增量 | 大会话树（数千 wire.jsonl）下避免每 15s 全量读文件 |
| 单 provider 故障隔离 | 一个工具的数据损坏不能让整个看板 500 |
| 未映射模型码原样透传 | 新路由码出现时记录绝不消失或抛错，只是以原始 id 显示 |
| 默认只绑 127.0.0.1、无 CORS 头 | 纯本机工具的设计前提；任何跨源请求都会被浏览器拦截 |
| records 按 time 降序 | 最近请求表、去重、配额快照都依赖最新优先 |

## 6. 目录结构速查

```
DoraMonitor/
├─ src/                    # Node 后端（见上表）
│  ├─ data/builtin-catalog.json   # models.dev 离线快照
│  └─ providers/           # 七个工具的数据采集器
├─ web/                    # 前端源码（Vite root）
│  ├─ src/App.jsx          # 用量页（SPA 主壳）
│  ├─ src/pages/           # ModelsPage（模型/定价设置）、SessionsPage
│  ├─ src/components/      # DailyBars / Heatmap / PricingTab / QuotaCard + ui/
│  ├─ src/lib/backend.js   # HTTP ↔ Tauri 双通道数据层
│  └─ public-assets/       # favicon
├─ dist/                   # 构建产物（随 npm 包分发）
├─ test/                   # Node 内置测试（14 个文件）
├─ scripts/                # Windows 安装器 / 自启注册 / daemon 补丁
├─ docs/                   # 本文档集
├─ start-doramonitor.bat   # （生成物）最小化窗口启动
├─ daemon-hidden.vbs       # （生成物）隐藏启动 daemon
└─ web-hidden.vbs          # （生成物）隐藏启动 web 服务
```

> 注意：`web/web/` 与 `test/test/`、`scripts/scripts/` 是历史遗留的旧版拷贝，
> 不参与构建与测试，详见[开发指南 → 已知遗留问题](./development.md)。
