# 数据源与采集（Tools）

DoraMonitor 支持 9 个 AI 编码工具。本文逐一说明各工具采集器的数据目录、扫描文件、
解析事件、token 归一化口径、去重规则与特殊行为。模型厂商（provider）与 AI 工具
（tool）是不同概念：同一厂商模型可以出现在多个客户端中。

## 通用约定（所有工具采集器共享）

- 记录形状（`tools/base.js` 的 `emptyRecord`）：

  ```js
  {
    tool,                 // provider id，如 "kimi-code"
    time: 0,              // epoch 毫秒；0 表示未知
    model: "unknown",
    modelDisplay: "unknown",
    modelResolved: null,  // 计价用 id（如 "qwen3.8-flash"）
    modelProvider: null,  // 仅 dsh 写入
    inputOther: 0,        // 普通输入（不含缓存）
    output: 0,
    inputCacheRead: 0,    // 缓存读取
    inputCacheCreation: 0,// 缓存写入总量
    inputCacheCreationShort: null, // 可选：短档写入（Kimi/Claude 5min、OpenAI 30m）
    inputCacheCreationLong: null,  // 可选：长档写入（Kimi/Claude 1h、OpenAI 12h）
    costCny: 0,           // 内部 CNY 账本
    costEstimated: false,
    priceId: null,
    credits: null,        // 仅 QoderCN CLI / peer 同步记录非零
    project: null, session: null, sessionHint: null,
  }
  ```

- **只读元数据**：绝不解析消息正文、工具参数全文、日志全文或任何凭据。
- **全零 token 记录一律丢弃**（zcode / codex / claude-code / dsh / qoder-cn 显式；
  qoder-cn-cli 额外要求 credits 也为 0）——error/cancelled 且无 token 的行不算请求。
- 记录按 `time` 降序输出；`meta.errors` 截断为 20 条。
- 递归遍历时跳过 `blobs/`、`tasks/`、`node_modules/` 目录。
- **按文件增量缓存**（kimi-code / codex / dsh）：解析结果按 (路径 + mtimeMs +
  size) 缓存，重扫只重读变化的文件；跨文件去重与配额挑选跑在廉价的后处理里。
  `meta.filesReread` 表示本次实际重读的文件数。`collect.invalidate()`（设置
  变更、会话移动）会清空这些缓存以保证费用重算。
- home 展开：支持 `~`、`~/`、`~\` 与 Windows `%VAR%` 环境变量。
- SQLite 只读：优先 `node:sqlite`（Node 22.5+ 的 `DatabaseSync`，`readOnly: true`），
  否则回退 `sqlite3` CLI（`-readonly -json`，参数绑定，30s 超时）；两者皆无则报
  "No SQLite backend"。
- 缓存命中计费比例、费用计算统一由 `pricing.js` 完成（见[计价体系](./pricing.md)）。

## provider 总表

| id | 显示名 | 主色 | 数据根（env 优先） | 可用性判定 | 数据形态 | 计费量 |
| --- | --- | --- | --- | --- | --- | --- |
| `kimi-code` | Kimi Code | `#22c55e` | `KIMI_CODE_HOME` → `~/.kimi-code` | `sessions/` 存在 | JSONL 事件流 | Token |
| `zcode` | ZCode | `#3b82f6` | `ZCODE_HOME` → `~/.zcode` | `cli/db/db.sqlite` 存在 | SQLite | Token |
| `qoder-cn` | QoderCN | `#f59e0b` | `QODER_CN_CONFIG_HOME` → `%APPDATA%\QoderCN`（mac: `~/Library/Application Support/QoderCN`；linux: `~/.config/QoderCN`） | `SharedClientCache/cache/db/local.db` 存在 | SQLite | Token |
| `qoder-cn-cli` | QoderCN CLI | `#eab308` | `QODER_CLI_HOME` → `~/.qoder-cn` | `projects/` 存在 | JSONL | **Credits**（`creditsOnly: true`） |
| `codex` | Codex | `#10a37f` | `CODEX_HOME` → `~/.codex` | `sessions/` 存在 | JSONL（可 zstd 压缩） | Token |
| `claude-code` | Claude Code | `#d97757` | `CLAUDE_CONFIG_DIR` → `~/.claude` | `projects/` 存在 | JSONL | Token |
| `dsh` | dsh | `#4D6BFE` | `DSH_HOME` → `~/.dsh` | `sessions/` 存在 | JSONL（多帧 zstd） | Token |
| `gemini` | Gemini CLI | `#4285f4` | `GEMINI_CLI_HOME` → `~/.gemini` | `settings.json` 启用 telemetry 且配置 outfile | OpenTelemetry NDJSON | Token |
| `omp` | Oh My Pi | `#d946ef` | `PI_CODING_AGENT_DIR` → `~/.omp/agent`（回退 `~/.pi/agent`） | `sessions/` 存在（XDG 迁移时 `$XDG_DATA_HOME/omp/sessions`） | JSONL | Token |

---

## 1. Kimi Code（tools/kimi-code.js）

**扫描**：`<home>/sessions/` 树下所有名为 `wire.jsonl` 的文件（精确匹配文件名），
路径形如 `sessions/<workspace>/session_<id>/agents/<agent>/wire.jsonl`。

**解析的事件**：

| 事件 | 处理 |
| --- | --- |
| `type === "usage.record"` | 唯一计费来源。**仅统计 `usageScope === "turn"`**（wire 里同时存在 session 级汇总，直接跳过防双算）。字段：`usage.inputOther / output / inputCacheRead / inputCacheCreation` |
| `context.append_loop_event` + `event.type === "tool.call"` | 产生 `kind:"event"` 记录（不参与请求数/费用），`modelDisplay = 事件名`（WebSearch、FetchURL…）。时间缺失时回退**文件 mtime** |

**fork 会话去重**（这是本 provider 最重要的正确性设计）：

- Kimi Code fork 会话时逐字节复制父 `wire.jsonl`，实测带来约 15% 记录 / 26% token
  的重复。
- usage.record 没有唯一 id，因此按**值元组签名**去重：
  `[model, time, inputOther, output, inputCacheRead, inputCacheCreation].join("\u0000")`。
- **无时间戳的记录绝不参与去重**（无法与真实重复区分，宁可保守）。
- 去重计数输出在 `meta.duplicatesSkipped`。

**模型身份**（两层）：

1. `model-map.js`：解析 `config.toml` 的 `default_model` 与 `[models."alias"]`
   （`provider / model / display_name`），以及环境变量
   `KIMI_MODEL_NAME / KIMI_MODEL_PROVIDER / KIMI_MODEL_ID`（注入为
   `__kimi_env_model__` 别名）。**解析前剥离疑似密钥行**（`api_key`、`token`、
   `secret`、`password`、`authorization` 及任何 `*KEY|TOKEN|SECRET|PASSWORD`）。
2. 裸 id（如 `kimi-for-coding`）再经 `model-identity.js` 取显示名
   （→ "K2.8 Preview"）与计价键（→ `kimi-k2.7-code`）。

**会话归属**：从文件路径提取 `{workspace, session, agent}`。

**增量探测文件集**：`sessions/` 下所有 `wire.jsonl` 的 stat 戳。

---

## 2. ZCode（tools/zcode.js）

**数据源**：`<home>/cli/db/db.sqlite` 表 `model_usage`，SQL：

```sql
SELECT model_id, session_id, input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens,
       computed_total_tokens, started_at, status
FROM model_usage WHERE started_at < 20000000000000 ORDER BY started_at DESC
```

**归一化要点**：

- 时间：`started_at` 为 ms epoch；`0 < v < 100000000000` 视为秒并 ×1000。
- **`input_tokens` 是总输入**（OpenAI 口径，含缓存）。拆分：
  `cacheRead = min(cache_read, totalInput)`；
  `cacheCreate = min(cache_creation, totalInput - cacheRead)`；
  `inputOther = max(0, total - cacheRead - cacheCreate)`。
  这样缓存命中率反映真实情况（GLM 计划下 ~97% 而非错误的 ~48%）。
- 输出：`output_tokens > 0` 用之，否则回退 `reasoning_tokens`（reasoning 已含在
  output 内）。
- session = `session_id`；model = `model_id`。

---

## 3. QoderCN（IDE 版，tools/qoder-cn.js）

**数据源**：`<home>/SharedClientCache/cache/db/local.db` 表 `chat_message`：

```sql
SELECT ... FROM chat_message
WHERE role='assistant' AND token_info IS NOT NULL AND trim(token_info) NOT IN ('','{}')
ORDER BY gmt_create, rowid
```

- 先用 `sqlite_master` + `pragma_table_info('chat_session')` 探测 `project_name`
  列是否存在（旧版本无此列则退回无项目 JOIN 的 SQL）。

**归一化要点**：

- `token_info` JSON：`prompt_tokens` **已包含** `cached_tokens`（OpenAI 口径）→
  `inputOther = max(0, prompt - cached)`、`inputCacheRead = cached`、
  `output = completion_tokens`。
- 模型：`model_info.model_key` → `model-identity.js` 解析显示名与计价键
  （如 `dfmodel` → "DeepSeek-V4.1-Flash" / `deepseek-flash`）。
- 时间 `toMs`：数字 / 文本 / 秒精度三重防御。
- project：`project_name`；值为 `"."` 时置 null。

---

## 4. QoderCN CLI（tools/qoder-cn-cli.js）

**`creditsOnly: true`**：该 CLI 各版本记录的 token 字段至今全为 0，真实计费量是
`usage.credits`。UI 会显示"仅 credits 计费"提示，此工具不参与费用估算。

**扫描**：`projects/<encoded-cwd>/<uuid>.jsonl`，**只遍历两层**（目录 → 文件），
非全递归。

**解析**：`type === "assistant"` 行的 `message.usage.{input_tokens, output_tokens,
cache_read_input_tokens, cache_creation_input_tokens, credits}`（Claude 风格）。

- `total <= 0 且 credits <= 0` 才跳过（保留"零 token 但有 credits"的行）。
- **不去重**（CLI 文件间无复制问题）。
- **不调用 costForUsage**：`costCny` 保持 0，成本语义由 credits 承担。
- project：目录名中的 `-` 还原为 `/`（模糊提示，注释明确说明）。

---

## 5. Codex（tools/codex.js）

**扫描**：`<home>/sessions/**` **加** `<home>/archived_sessions/**`，递归找后缀
`.jsonl.zst` / `.jsonl.zstd` / `.jsonl` 的 rollout 文件。

**解压**：`.zst/.zstd` 先用 `zlib.zstdDecompressSync`，失败回退纯 JS 的
`fzstd.Decompress`（多帧兼容）。

**解析的事件**：

| 事件 | 处理 |
| --- | --- |
| `token_usage_record` | 唯一计费来源：`payload.usage.{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens}`。OpenAI 口径 input 含缓存 → `inputOther = max(0, input_tokens - cached_input_tokens)` |
| `turn_token_usage` / `thread_token_usage` | **从不统计**（它们是累计值，会双算） |
| `turn_context` | 提供 `payload.turn_id → {model, cwd}`；token_usage_record 本身无 model 字段，回退文件内 `lastModel/lastCwd` |
| `event_msg` + `payload.rate_limits` | 云配额快照：文件内取最新，跨文件取 `ts >= best.ts`；输出为 `scan()` 返回值上的 `quota` 字段 |

**去重**：`payload.response_id` 集合——同一线程归档后会同时出现在 `sessions/`
与 `archived_sessions/`。**全零占位行在去重之前丢弃**，防止占位行先占住
response_id、吞掉同 id 的真实记录（这是 data-accuracy 测试专门回归的坑）。

**配额窗口**（`quotaWindows`）：`primary` → `{kind:"session", label:"5-hour"}`，
`secondary` → `{kind:"weekly", label:"Weekly"}`；`used_percent` 必须为有限数否则
跳过；clamp 0–100；`resets_at` 为 epoch **秒**（>1e11 的值按毫秒防御）。
无数据 → `{available:false, reason:"no_data", windows:[]}`。

**主动轮询**（`src/codex-quota.js`）：rollout 只在 Codex CLI 运行时产生，在其他
客户端（omp、IDE 插件等）消耗同一账号额度时快照会变旧。`/api/quota?tool=codex`
会（60s 节流）用 `~/.codex/auth.json` 的 OAuth token 请求
`GET https://chatgpt.com/backend-api/wham/usage`（401 时用 refresh_token 换新并
回写 auth.json），成功快照持久化到 `~/.doramonitor/codex-quota.json`；scan 把
rollout 快照与轮询快照按 `fetchedAt` 取新合并，失败静默回退。

**额度测算样本**：与卡片只取最新快照不同，解析器还把每个 `rate_limits` 的双窗口快照
按原始时间写入 `quotaSamples`。Web 服务首次启动时一次性回补全部 rollout 历史，后续快照
和主动轮询结果保存到 `~/.doramonitor/quota-estimator/samples.jsonl`，供等效 Token 容量测算。

**会话/项目**：`payload.session_id || payload.thread_id || 文件名`；project =
turn 的 `cwd`。

---

## 6. Claude Code（tools/claude-code.js）

**扫描**：`<home>/projects/` 递归 `*.jsonl`；只解析 `type === "assistant"` 行的
`message.usage`。

**归一化要点**：

- Anthropic 口径 **`input_tokens` 不含缓存**，`inputOther` 原样；`cacheRead =
  cache_read_input_tokens`；`cacheCreate = cache_creation_input_tokens`，若为 0
  且存在 `usage.cache_creation` 对象则用 `ephemeral_5m_write_tokens +
  ephemeral_1h_write_tokens` 之和。
- **去重**：key = `` `${message.id}|${obj.requestId || ""}` `` —— `claude
  --resume/--continue` 会把旧回合复制进新 transcript 文件。无 `message.id` 的行
  不去重直接计数。
- time = `Date.parse(obj.timestamp)`；project = `obj.cwd`（缺失回退编码目录名
  如 `D--proj`）；session = `obj.sessionId`（缺失回退文件名去 `.jsonl`）。
- **不提供额度**：Claude Max/Pro 的限额对本地文件不可见（设计使然）。

---

## 7. dsh / DeepSeek Harness（tools/dsh.js）

**扫描**：`<home>/sessions/` 下 `.jsonl.zstd` 与 `.jsonl`。

**解压**：`.zstd` 是**多帧拼接**，用纯 JS 的 `fzstd.Decompress` 流式解码；
fzstd 加载失败时记入 `meta.errors` 并跳过 .zstd 文件，**不抛异常**（明文
`.jsonl` 仍可读）。

**解析的事件**：

| 事件 | 处理 |
| --- | --- |
| `type === "session"`（首行会话头） | 取 `obj.id` 与 `obj.cwd` 作为 session / project；缺失回退目录名 |
| `type === "assistant/message"` | `data.usage.{inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}`；DeepSeek 口径 **inputTokens 不含缓存**，`inputOther` 原样 |

**去重**：`message.id`。

**模型身份**：`message.source.model` 为原始路由码（如 `dfmodel`），
`message.source.provider`（如 `qodercn`）经 `resolveModelIdentity(raw, {provider})`
解析；`modelResolved = identity.pricingKey || raw`。dsh 是唯一写 `modelProvider`
字段的 provider。

**无配额**（provider-snapshots 无配额数据）。

---

## 8. Oh My Pi / omp（tools/omp.js）

**扫描**：`sessionsRoot` 树下所有 `.jsonl`（递归，含 subagent 子会话——它们写在父会话同名
artifact 目录里，即 `<bucket>/<会话文件名去 .jsonl>/<child>.jsonl`）。
home 按实际 sessions 位置选择：新 `~/.omp/agent` 只有配置而没有 sessions 时，会继续回退到
旧 `~/.pi/agent/sessions`，避免迁移期间隐藏历史用量。

**文件格式**（上游 `@oh-my-pi/pi-coding-agent` src/session）：首行是 256 字节定宽
title 槽（`{type:"title",...,pad}`，合法 JSON 但非 header）；其后为
`{type:"session",version:3,id,timestamp,cwd}` 头 + 逐行 entry。
无 session 头的 `.jsonl`（artifact 杂物）整体跳过。

**解析的事件**：

| 事件 | 处理 |
| --- | --- |
| `type === "session"` | 取 `id` / `cwd` 作为 session / project |
| `type === "message"` 且 `message.role === "assistant"` | `message.usage.{input, output, cacheRead, cacheWrite}`；模型/厂商取 `message.model/provider`；时间取 `message.timestamp`（epoch ms） |
| `type === "model_usage"` | 会话外模型调用（如标题生成）的 `usage`，同样计费 |
| `toolResult`（含 task 子代理聚合 `details.usage`） | **跳过**——子代理会话有自己的 .jsonl，计入会双算 |

pi 口径 `input` **不含**缓存（`totalTokens` 为四项之和），`inputOther` 原样。
omp 自记的 `usage.cost` 是美元，不采用——费用统一走 `pricing.js` 人民币表。

**去重**：`/fork` 会把全部历史（entry id 与 timestamp 原样）复制进新文件，
按 `id|timestamp` 全局去重（entry id 是短 hex，单用 id 可能跨会话碰撞）。
全零 usage 占位条目在进入去重前跳过。

**无配额**。

---

## 9. Gemini CLI（tools/gemini.js）

**前提**：在 `~/.gemini/settings.json` 中启用 telemetry，并配置本地 `outfile`。
采集器只读取该 OpenTelemetry NDJSON 文件；没有文件导出时工具显示不可用。

- `gemini_cli.token.usage`：按 `(model, type)` 读取累计计数，相邻数据点做差得到本次用量；
  计数下降视为新 CLI 进程并重新起算。`input` 归普通输入，`output/thought` 归输出，
  `cache` 归缓存读取，`tool` 归普通输入。
- `gemini_cli.tool.call.count`：同样按累计差值生成工具事件，不计请求 Token。
- 数据没有项目维度，会话统一为 `gemini-cli`；时间戳来自导出点，短会话可能落在最后一次导出时间。
- 文件最多读取前 32 MiB，应在 Gemini 侧轮换。遥测 outfile 同时纳入 `sourceFiles()` 的文件戳探测，
  文件增长会触发增量采集，不会长期停留在首次快照。

**无配额**。

---

## 10. QoderCN 路由码 / 通用模型身份（model-identity.js）

多个工具记录的是**内部路由码**而非真实模型 id。`model-identity.js` 是唯一映射点：

- `QODER_DISPLAY_NAMES`（QoderCN 路由码）：`dfmodel`→DeepSeek-V4.1-Flash、
  `dmodel`→DeepSeek-V4-Pro、`qfmodel`→Qwen3.8-Flash、`qmodel`→Qwen3.7-Plus、
  `qmodel_latest`→Qwen3.7-Max、`qmodel_preview`/`q35model_preview`→Qwen3.8-Max-Preview、
  `q35model`→Qwen3.5-Plus、`q36fmodel`→Qwen3.6-Flash、`gmodel`→GLM-5、
  `gm51model`→GLM-5.2、`kmodel`→Kimi-K2.7-Code、`mmodel`→MiniMax-M3；
  路由档位 `auto/efficient/lite/performance/ultimate` 只命名不定价。
- `EXTRA_DISPLAY_NAMES`：`hy3/hy3-x`→Hy3、`hy4-preview`→Hy4 Preview、
  `deepseek-flash` 等、以及 Kimi Code 计划 id `kimi-for-coding`→"K2.8 Preview"、
  `kimi-for-coding-highspeed`→"K2.7 Code Highspeed"。
- `PRICING_KEYS`：路由码 → 计费 id（如 `qfmodel`→`qwen3.8-flash`、
  `kimi-for-coding`→`kimi-k2.7-code`）。**每个有显示名的模型码必须有计价键**
  （否则会回落 Kimi K2.6 兜底价——这是测试强制守护的回归）。
- 解析规则：大小写不敏感；`provider:code`、`vendor/code` 取尾段；
  **未映射码原样透传**（`known: false`），绝不消失或抛错。

## 11. 增量缓存与探测（collect.js / tools/index.js）

每个工具采集器声明自己的"源文件集"用于 stat 探测：

| provider | 探测文件 |
| --- | --- |
| kimi-code | `sessions/` 下所有精确名 `wire.jsonl` |
| qoder-cn-cli | `projects/` 递归 `*.jsonl` |
| zcode | `cli/db/db.sqlite` 单文件 |
| qoder-cn | `SharedClientCache/cache/db/local.db` 单文件 |
| codex | `sessions/` + `archived_sessions/` 下 rollout 后缀文件 |
| claude-code | `projects/` 递归 `*.jsonl` |
| dsh | `sessions/` 下 `.jsonl.zstd` + `.jsonl` |
| gemini | telemetry 配置的实际 `outfile` |
| omp | `sessionsRoot(home)` 下递归 `*.jsonl` |

文件戳 = 路径 + mtimeMs + size；数量、路径、存在性任一变化即触发该 provider
重扫，其余 provider 完全跳过。
