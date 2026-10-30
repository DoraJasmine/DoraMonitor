# HTTP API 参考

服务默认监听 `127.0.0.1:3847`（`--host` / `--port` 可改）。所有 `/api/*` 端点
同时接受 GET 与 POST（除非特别说明），响应统一为
`Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`。

- **无鉴权、无 CORS 头**：纯本机工具的设计前提，任何跨源请求会被浏览器拦截。
- 几乎所有端点都支持 `?home=<path>` 查询参数覆盖 Kimi 数据目录
  （优先级：query home > 启动参数 `--home` > 自动检测）。
- 错误统一为 `{ "error": "<code>", "message": "..." }` + 对应状态码。

## 端点总览

| # | 端点 | 用途 |
| --- | --- | --- |
| 1 | `GET /api/health` | 健康检查 |
| 2 | `GET /api/locale` | 服务端语言探测 |
| 3 | `GET /api/paths` | 数据目录候选与工具检测 |
| 4 | `GET /api/summary` | 核心聚合数据 |
| 5 | `GET /api/settings` / `POST /api/settings` | 读取/保存全局设置 |
| 6 | `GET /api/prices` | 官方价目表 |
| 7 | `GET /api/quota` | 额度（Kimi 在线 / Codex 本地） |
| 8 | `GET /api/tools` | provider 列表 |
| 9 | `POST /api/sync` | 立即执行多设备同步 |
| 10 | `GET /api/sessions` | 会话/工作区列表 |
| 11 | `POST /api/sessions/archive` / `unarchive` | 归档 / 恢复 |
| 12 | `POST /api/sessions/delete` | 永久删除会话 |
| 13 | `GET /api/sessions/preview` | 安全文本预览 |
| 14 | `POST /api/workspaces/delete` | 删除空工作区 |
| 15 | `GET /api/config` | Kimi config.toml 掩码视图 |
| 16–21 | `/api/config/*` | Provider / 模型别名 / 默认模型 / 副模型管理 |
| 22 | `GET /api/catalog` | models.dev 目录 |
| 23 | `POST /api/catalog/import` | 从目录导入 provider |

## 1. GET /api/health

→ `200 { "ok": true }`

## 2. GET /api/locale

按 `Accept-Language` 首段探测（zh* → `zh`，否则 `en`）。

→ `{ "detected": "zh" | "en", "messages": { ...完整 zh/en 词条对象 } }`

## 3. GET /api/paths

→

```json
{
  "current": "C:\\Users\\you\\.kimi-code",
  "valid": true,
  "candidates": [ { "path": "...", "valid": true } ],
  "tools": [ { "id": "kimi-code", "label": "Kimi Code", "available": true, "home": "...", "creditsOnly": false, "...": "工具元数据" } ],
  "env": { "KIMI_CODE_HOME": null, "KIMI_MODEL_NAME": null }
}
```

候选来自 `KIMI_CODE_HOME`、`~/.kimi-code`、`%USERPROFILE%\.kimi-code`（去重），
逐一用"目录存在且含 `config.toml` 或 `sessions/`"验证。

## 4. GET /api/summary（核心端点）

查询参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `range` | `30d` | `today` / `7d` / `30d` / `all`；非法值回落逐次计算 |
| `tool` | `all` | provider id；不在列表内强制 `all` |
| `refresh` | — | `refresh=1` 强制重扫（绕过 15s 采集缓存与聚合缓存） |
| `device` | `all` | `all`=本机+全部 peer；`local`=仅本机；其他值须为 peer 设备名 |

响应（节选）：

```json
{
  "valid": true,
  "home": "...",
  "scannedAt": 0,
  "fromCache": false,
  "meta": { "<toolId>": { "filesScanned": 0, "linesSeen": 0, "recordCount": 0, "duplicatesSkipped": 0, "errors": [] } },
  "range": "30d", "tool": "all",
  "tools": [ /* provider 列表 */ ],
  "byTool":  [ { "id": "kimi-code", "label": "...", "color": "#22c55e", "requests": 0, "totalTokens": 0, "costCny": 0, "credits": 0, "...": "" } ],
  "stats": {
    "totals": { "requests": 0, "inputOther": 0, "output": 0, "inputCacheRead": 0, "inputCacheCreation": 0, "costCny": 0, "credits": 0, "totalTokens": 0, "cacheHitRate": 0 },
    "daily":  [ { "date": "2026-10-24", "...": "同 totals + cacheHitRate" } ],
    "dailyByModel": { "dates": [], "totals": [], "series": [ { "key": "kimi-code\0k3", "label": "K3", "modelDisplay": "...", "values": [] } ] },
    "models": [ { "model": "...", "modelDisplay": "...", "requests": 0, "totalTokens": 0, "costCny": 0, "costEstimated": false, "cacheHitRate": 0 } ],
    "recent": [ /* 最近 500 条，字段裁剪 */ ],
    "recentTotal": 0, "recentLimit": 500
  },
  "toolEvents": { "byName": { "WebSearch": 3 }, "total": 3 },
  "device": "all",
  "devices": [ { "id": "local", "label": "本机", "available": true } ],
  "sync": { "enabled": false, "peers": [] },
  "heatmap": { "weeks": 53, "start": "...", "end": "...", "maxTokens": 0, "cells": [ { "date": "...", "dow": 0, "weekIndex": 0, "requests": 0, "totalTokens": 0, "costCny": 0, "cacheHitRate": 0, "level": 0 } ], "monthLabels": [ { "weekIndex": 0, "label": "10月" } ] },
  "allModels": [ /* 全时期模型行，含 display 换算后 cost */ ],
  "allModelCount": 0,
  "rangeTotals": { "today": 0, "7d": 0, "30d": 0, "all": 0 }
}
```

要点：

- 无任何工具数据目录时返回 `200 { "valid": false, "home": "...", "tools": [],
  "message": "No AI tool data directories found" }`。
- 聚合缓存 key = `scannedAt|deviceKey|tool`；一次计算 4 个 range + 热力图；
  缓存超过 32 条整体清空。
- peer 记录来自**磁盘缓存**（`~/.doramonitor/remote-cache/`），请求路径永不阻塞
  网络；peer 合成记录的请求数保留原始日汇总值。
- 成本字段：内部 `costCny`（CNY 账本），API 输出层按设置币种换算
  （`stats.models[].cost`、`allModels[].cost` 等已按显示币种给值）。

## 5. GET/POST /api/settings

- GET → `loadSettings()` 原样（结构见[配置与设置](./configuration.md)）。
- POST：body 与当前设置**浅合并**，`sync` 段深合并（`sync.ssh`、`sync.webdav`
  各自 merge）。保存后 `invalidateCollect()` + `collect({force:true})`——
  **自定义价格与汇率立即生效，无需重启**。
- 校验失败 → `400 { "error": "invalid_settings", "message": "..." }`。

## 6. GET /api/prices

→

```json
{
  "prices": [ {
    "id": "kimi-k3.1-pro", "cacheHit": 1.3, "cacheWrite": 13.0, "input": 13.0, "output": 68.0,
    "context": 1048576, "estimated": false, "period": null,
    "nativeCurrency": "CNY", "unit": "CNY / 1M tokens",
    "sourceUrl": "https://platform.kimi.com/docs/pricing/chat",
    "display": { "currency": "CNY", "symbol": "¥", "cacheHit": 1.3, "cacheWrite": 13.0, "input": 13.0, "output": 68.0 }
  } ],
  "currency": "CNY", "currencySymbol": "¥", "fxRate": 6.67, "customPrices": []
}
```

- DeepSeek 模型会输出两行：`period: "peak"` 与 `period: "offPeak"`。
- `display.*` 已按用户币种换算好，前端直接展示。
- `estimated: true` 的行界面显示「估算」徽标。

## 7. GET /api/quota 与等效容量历史

参数：`refresh=1` 强制；`tool`（`kimi-code` 默认 / `codex`）。Kimi 支持
`scope=all-clients|kimi-code-only`，Codex 支持 `scope=all-clients|codex-only`；未传时分别读取
`quotaEstimation.kimiCodeOnly` / `quotaEstimation.codexOnly`。

- `tool=kimi-code`：调用 Kimi 在线 usages API（`https://api.kimi.com/coding/v1/usages`，
  凭据在 `<home>/credentials/kimi-code.json`，过期自动刷新）。60s 内存缓存。
- `tool=codex`：读取本地 rollout、同步缓存及主动轮询的 `rate_limits` 快照，采用
  `fetchedAt` 最新的一份。主动轮询使用本机 Codex 登录态请求 `wham/usage`，60s 节流。
- 无数据：`200 { "available": false, "reason": "no_data", "windows": [], "tool": "codex" }`
- 正常：`{ "fetchedAt": 0, "tool": "kimi-code", "available": true,
  "windows": [ { "kind": "session|weekly", "label": "5-hour", "usedPercent": 42.0,
  "resetsAt": "ISO 时间" } ], "capacity": { ... } }`
- 凭据失效：`reason: "token_expired" | "no_credentials" | "http_<status>"`。

`capacity` 包含 `tool`、`accountKey`、`usageScope`、`generatedAt`、`targets`、`longTermTargets`、
`maxima` 和 `calibrations`；`provider` 暂时保留为旧客户端兼容字段，新前端不得依赖。`targets` 固定覆盖
`session` / `weekly` 与缓存命中率 `0.85 / 0.90 / 0.95 / 0.98` 的组合；每项包含 `fullWindowTokens`、
`fullWindowCostCny`、`confidence`、`confidenceScore`、`confidenceReasons`、`method`、`sampleCount`、
`outlierCount`、`dataRange`、`modelMix` 和 `observations`。
每个 observation 包含起止时间、额度增量、实际 Token、CNY、缓存命中率及各模型 Token 组成。
费用密度显著偏离中位数的区间会被剔除，不计入 `observations`；此时 `outlierCount` 大于 0，
且 `confidenceReasons` 包含 `outliers_excluded`。`fullWindowCostCny` 主值按加权总费用 ÷ 加权总额度
消耗 ×100 计算，`lowCostCny` / `highCostCny` 使用逐区间容量的 25% / 75% 加权分位数。
人民币是 API 刊例价等效价值，不是真实账单。稀疏样本可用价格弱先验推算缺失档位，并标记
`modeled` / `extrapolated` 和低置信度。数据不足时数值字段为 `null` 或缺省，不能当作官方额度或
精确的零。`maxima` 仅记录完整覆盖、非外推且中高置信度的结果。`longTermTargets` 是独立长程序列：
先合并连续短区间，5h 采用合并后 ≥30 分钟、weekly 采用 ≥6 小时的自动区间；不设样本数硬门槛，
样本少时通过低置信度体现，且排除手动校准样本。历史以 `estimateKind=standard|long-term` 隔离；
界面优先采用高置信度普通测算，长程结果默认收起为交叉校验。

`GET /api/quota/capacity/history` 查询参数为 `tool`、`accountKey`、`scope`、`window`、
`cacheHitRate`、`estimateKind`、`limit`（默认 30，最大 200）和 `offset`，返回
`{ "history": [...], "total": 0, "limit": 30, "offset": 0, "tool": "codex" }`，按最新记录优先分页。
旧 `provider=openai|kimi` 在兼容期仍可使用；同时传 tool/provider 但语义冲突时返回
`400 conflicting_tool_provider`，未知工具返回 `400 unsupported_tool`。有新观测终点的测算结果追加到
`history.jsonl`，不设置 30 条上限；记录包含完整起止时间、上一次区间结束时间、观测区间、
模型结构、触发方式和算法元数据。界面按一次测算批次并列展示四个缓存档，同一批次不会拆成四套历史。

`GET /api/quota/samples` 查询参数为 `tool`、`accountKey`、`window`、`changesOnly=1`、`limit`
（默认 50，最大 200）和 `offset`，返回 `{ "samples": [...], "total", "limit", "offset", "tool" }`。
旧 `provider` 的兼容与冲突规则同历史接口。原始额度样本每 60 秒记录并保留 90 天；
`changesOnly` 仅在界面查询时过滤重复百分比和重复重置时间，不减少原始采样。

`POST /api/quota/capacity/calibration` body：
`{ "action": "start|end|cancel", "tool": "kimi-code|codex", "accountKey": "...",
"scope": "all-clients", "window": "session|weekly" }`。旧 body.provider 仍兼容，冲突时同样返回 400。
`start` 刷新额度并记录精确起点；若已有
进行中的起点，先结算可用的上一段并以 `trigger=reanchor` 写入历史，再开始新段。`end` 要求至少
5 分钟、10K 有效 Token、额度增长 1 个百分点且 peer 覆盖完整，随后立即重算；没有显式起点时
从上次测算终点续算并标记 `trigger=manual-end`。`cancel` 放弃进行中的区间。校验失败保留起点。

Web 服务每 60 秒采样。5h/7d 标准测算分别有独立锚点：1 小时且增长 4%，或增长 10% 时触发；
长程测算也分别独立：增长 15% 且满足 30 分钟/6 小时长区间门槛时触发。失败或无有效结果保留
重试锚点。普通读取只更新展示和缓存，不写历史；算法版本变化会立即使旧缓存失效。

## 8. GET /api/tools

→ `{ "tools": [ { "id", "label", "color", "creditsOnly", "home", "available", ... } ] }`

## 9. POST /api/sync

body 可空。未启用同步 → `400 { "ok": false, "error": "sync_disabled" }`。
强制 collect 后执行 `runSync`：

→ `{ "ok": true, "uploaded": true, "uploadError": null, "downloaded": 2,
"fromCache": false, "peers": ["laptop", "ubuntu"], "error": null }`

## 10. GET /api/sessions

参数：`status`（`active` 默认 / `archived`）、`workspace`（工作区 id，可选）。

- Kimi 数据目录非法 → `400 { "error": "invalid_home", "home": "..." }`
- →

```json
{
  "home": "...", "archiveRoot": ".kcd-archive",
  "workspaces": [ { "id": "wd_demo_a1b2", "name": "demo", "root": "...",
                    "createdAt": "...", "lastOpenedAt": "...",
                    "activeCount": 3, "archivedCount": 0, "empty": false } ],
  "sessions": [ { "id": "session_021d...", "workspaceId": "wd_demo_a1b2",
                  "title": "...", "workDir": "...", "createdAt": "...", "updatedAt": "...",
                  "status": "active", "sizeBytes": 0, "fileCount": 0 } ]
}
```

**绝不返回** `lastPrompt` 或任何消息正文。

## 11. POST /api/sessions/archive 与 /api/sessions/unarchive

body：`{ "workspaceId": "wd_...", "sessionId": "session_..." }`
归档 = 移动到 `sessions/.kcd-archive/<wd>/<session>/`；恢复 = 反向移动并补写
`session_index.jsonl` 最小条目。成功后采集缓存失效。
错误：`404 not_found`、`400 invalid_workspace / invalid_session / path_escape`、
`409 exists`（目标已存在）。

## 12. POST /api/sessions/delete

body：`{ "workspaceId", "sessionId", "status": "active|archived", "confirm": true }`
—— **`confirm !== true` → `400 { "error": "confirm_required" }`**。
整目录移除磁盘数据并清理 `session_index.jsonl` 对应行。

## 13. GET /api/sessions/preview

参数：`workspaceId`、`sessionId`、`status`。

→ `{ "workspaceId", "sessionId", "status", "title", "workDir", "createdAt",
"updatedAt", "messageCount": 0, "truncated": false,
"messages": [ { "role": "user|assistant|system", "time": 0, "text": "..." } ] }`

上限 80 条消息 / 2500 字符每条；疑似密钥整段替换为
`[redacted: possible secret content]`。重建与脱敏规则见[会话管理](./sessions.md)。

## 14. POST /api/workspaces/delete

body：`{ "workspaceId": "wd_...", "confirm": true, "force": false }`

- 仍有会话 → `409 { "error": "not_empty", "activeCount": n, "archivedCount": m }`
- 有非会话残留文件且未 `force` → `409 { "error": "not_empty", "leftovers": ["..."] }`
- 成功后从 `workspaces.json` 移除并记入 `deleted_workspace_ids`。

## 15–21. Kimi config.toml 管理

| 端点 | body / 参数 | 说明 |
| --- | --- | --- |
| `GET /api/config` | — | 掩码视图：`api_key` → `has_api_key` 布尔；`env` → `env_keys` 键名；`__` 前缀别名隐藏 |
| `POST /api/config/providers` | `{ id, type, apiKey, baseUrl, defaultModel }` | 创建时 type 必填；空串字段删除 |
| `DELETE /api/config/providers/:id` | — | 级联删模型别名、清 default/secondary 引用 |
| `POST /api/config/providers/:id/models` | 模型定义（`model|name` 之一 + `provider|provider_id|base_url` 之一；**`max_context_size` 必须为正整数**） | 保存模型别名 |
| `DELETE /api/config/models/:alias` | — | 删除别名 |
| `POST /api/config/default-model` | `{ "alias": "..." }`（空串清除） | |
| `POST /api/config/secondary-model` | `{ model, default_effort, ... }`（空 model 清除） | 副模型（实验特性） |

写操作流程统一为 读 → 改 → 原子写（先备份 `<config.toml>.kcd-bak`，临时文件
mode 0600，rename 替换），并保留 hooks/permission 等未知段。

错误码映射：`not_found`→404；`no_models`→422；`invalid_toml / read_failed /
write_failed / catalog_missing`→500；其他 `invalid_*`→400。成功一律 `200` 返回
**新的掩码视图**。

## 22. GET /api/catalog

参数：`refresh=1` 强制拉取。三级回退：models.dev 在线镜像 → 磁盘缓存
（`~/.kimicode-dashboard/catalog-cache.json`，兼容 `fetched_at` 蛇形命名）→
内置快照（`src/data/builtin-catalog.json`，193 provider / 7243 模型）。

→ `{ "source": "remote|cached|builtin", "fetchedAt": 0,
"providers": [ { "id", "name", "api", "type", "models": [归一化后的可用聊天模型] } ] }`

模型归一化：剔除 embedding / deprecated / 非文本输出；capabilities 顺序固定为
`image_in, video_in, audio_in, thinking, tool_use, dynamically_loaded_tools`；
`reasoning_options` 解析为 `supportEfforts / offEffort / alwaysThinking`。

## 23. POST /api/catalog/import

body：`{ "providerId", "apiKey", "baseUrl", "defaultModel }`。
原子写入 config.toml：创建 `[providers.<id>]` + 为每个可用模型建别名
（含 capabilities / efforts 元数据），可选设置 default_model。
错误：`404 not_found`（provider 不在目录）、`400 invalid_id`、`422 no_models`。

## 通用错误与限制

| 项 | 值 |
| --- | --- |
| 请求体上限 | 1,000,000 字节（超限 `body_too_large` 并断开连接） |
| 非法 JSON | `invalid_json` |
| 未知 API 路径 | `404 { "error": "not_found" }` |
| 未捕获异常 | `500 { "error": "internal_error", "message": "..." }` |
| 静态文件越界 | `403 Forbidden` |
| SPA 回退 | `/quota`、`/sessions`、`/models` 及其子路径（不含 `.`）→ `index.html` |
