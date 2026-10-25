# 计价体系（Pricing）

DoraMonitor 的费用估算全部由 `src/pricing.js` 实现。本文说明计价的设计原则、
全部内置价目表、特殊计价规则（峰谷、节假日、长上下文、缓存写入）、自定义价格、
汇率处理，以及"一条用量记录如何变成一个费用数字"的完整链路。

## 1. 核心设计：内部 CNY 单一账本

- 所有费用在**内部一律以人民币记账**（字段 `costCny`）：
  - 人民币计价厂商（Kimi、DeepSeek、智谱）：直接用官方 CNY 价。
  - 美元计价厂商（OpenAI、Anthropic、Qwen/MiniMax/hy3 等）：入账时按
    `fxRate`（默认 7.2）**一次性**换算成 CNY。
- 展示层选择美元时，再把 CNY **除回** `fxRate`（`toDisplay`）。
- **换算只发生一次**：聚合缓存里的成本值永远保持 CNY，币种转换只发生在 API
  输出层（`displayCost` / `displayCosts`），改币种不会重扫、也不会累积误差。

不变式（有测试守护）：改变 `fxRate` 时，Kimi / DeepSeek / 智谱等 CNY 模型的费用
完全不变；只有美元厂商的费用随汇率变化。

## 2. 计价链路：一条记录怎么变成费用

```
wire 记录 (model="kimi-code/kimi-for-coding", usage={...})
   │
   ├─① 模型身份解析
   │    kimi-code:  model-map.js（config.toml 别名/env）→ 裸 id
   │    qoder/dsh:  model-identity.js（路由码 → pricingKey）
   │    → 得到计价键，如 "kimi-k2.7-code"
   │
   ├─② 官方价匹配 matchPrice()
   │    八张价目表顺序遍历，正则匹配裸 id / 全名，首个命中即用
   │    → { input, cacheHit, cacheWrite, output, estimated, ... }
   │
   ├─③ 自定义价匹配 matchCustomPrice()
   │    settings.customPrices 命中则整体覆盖（缺省分项沿用官方价）
   │
   └─④ 成本计算 costForUsage()
        cost = inputOther×input + cacheRead×cacheHit
             + cacheCreate×cacheWrite + output×output   （每 1M tokens）
        → costCny 入账
```

匹配细节：

- 匹配对象是**裸模型段**（`provider/model` 取 `/` 后段）与全名各试一次。
- 表的**顺序即优先级**（首个命中即用）——这就是为什么 `kimi-k3.1-pro-highspeed`
  必须排在 `kimi-k3.1-pro` 之前、后者必须排在 `kimi-k3` 之前：泛匹配正则会
  子串命中更长 id。
- 未命中任何表 → 回退 `FALLBACK_PRICE`（按 Kimi K2.6 标价，`estimated: true`，
  界面显示「估算」）。

## 3. 内置价目表（官方价，单位：每 1M tokens）

### 3.1 Kimi 中国区（`KIMI_PRICES`，CNY）

来源：<https://platform.kimi.com/docs/pricing/chat>

| id | 缓存命中 | 缓存写入(默认5min TTL) | 输入 | 输出 | 上下文 | 备注 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `kimi-k3.1-pro-highspeed` | 1.30 | 13.00 | 26.00 | 136.00 | 1,048,576 | 高速版 = 标准版 2 倍价 |
| `kimi-k3.1-pro` | 1.30 | 13.00 | 13.00 | 68.00 | 1,048,576 | 2026-10-24 官方挂牌 |
| `kimi-k3` | 2.00 | 20.00 | 20.00 | 100.00 | 1,048,576 | 官方 1h TTL 为 ¥40；wire 无 TTL 字段，按默认 5min 档计 |
| `kimi-k2.7-code-highspeed` | 2.60 | 13.00 | 13.00 | 54.00 | 262,144 | 高速版 |
| `kimi-k2.7-code` | 1.30 | 6.50 | 6.50 | 27.00 | 262,144 | **`kimi-for-coding`（Coding Plan，现为 K2.8 Preview）暂按此计价**；K2 系列 2026-12 底下线 |
| `kimi-k2.6` | 1.10 | 6.50 | 6.50 | 27.00 | 262,144 | |

K3 系列官方缓存写入分 TTL 档：5min（默认）与 1h（价格为 5min 档的 2 倍）。
由于 wire.jsonl 的 `inputCacheCreation` 不携带 TTL 信息，一律按默认 5min 档计。

### 3.2 DeepSeek（`DEEPSEEK_PRICES`，CNY，峰谷分时）

来源：<https://api-docs.deepseek.com/quick_start/pricing/>

| id | 匹配的模型名 | 缓存命中 | 输入 | 输出 | 上下文 |
| --- | --- | ---: | ---: | ---: | ---: |
| `deepseek-flash` | `deepseek-flash`、`deepseek-v4(.1)-flash(-vision-exp)`、`deepseek-chat/reasoner`、`dfmodel` | 0.04 | 2.00 | 8.00 | 1,000,000 |
| `deepseek-v4-pro` | `deepseek-v4-pro…`、`dmodel` | 0.30 | 9.00 | 27.00 | 1,000,000 |

**峰谷规则**：峰时 = 工作日（周一至五）北京时间 09:00–12:00 与 14:00–18:00，
且排除中国法定节假日；**其余时段半价**（`offPeakMultiplier: 0.5`）。

- 记录带时间戳时按该时刻的峰/谷精确计价（`ratePeriod` 字段标 `peak`/`off-peak`）。
- **无时间戳时按峰价保守估计**，并标记 `estimated: true`。
- 2026 年法定节假日表硬编码在 `CN_HOLIDAYS_2026`；其他年份只按星期规则判断。

### 3.3 智谱 BigModel（`ZHIPU_PRICES`，CNY）

来源：<https://docs.bigmodel.cn/cn/guide/models>

| id | 缓存命中 | 缓存写入 | 输入 | 输出 | 上下文 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `glm-5.3-flash` | 0.23 | 0（限时免费） | 0.80 | 2.80 | 1,000,000 |
| `glm-5.3` | 2.00 | 0（限时免费） | 8.00 | 28.00 | 1,000,000 |

### 3.4 Qwen / 阿里（`QWEN_PRICES`，USD）

来源：opencode.ai/docs/go（缓存 2026-08-17）与阿里云 Model Studio。

| id | 缓存命中 | 缓存写入 | 输入 | 输出 | 上下文 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `qwen3.8-max-preview` | 0.25 | 2.50 | 2.00 | 6.00 | 1,000,000 |
| `qwen3.8-flash` | 0.016 | 0.20 | 0.15 | 0.47 | 1,000,000 |
| `qwen3.7-max` | 0.50 | 3.125 | 2.50 | 7.50 | 1,000,000 |
| `qwen3.7-plus` / `qwen3.7` | 0.04 | 0.50 | 0.40 | 1.60 | 1,000,000 |
| `qwen3.6-flash` | 0.04 | 0.50 | 0.40 | 1.60 | 1,000,000 |
| `qwen3.6-plus` | 0.05 | 0.625 | 0.50 | 3.00 | 1,000,000 |
| `qwen3.5-plus` | 0.02 | 0.25 | 0.20 | 1.20 | 1,000,000 |
| `qwen3-max` | 0.30 | 2.50 | 1.60 | 6.40 | 262,144 |
| `qwen3-coder-plus` / `qwen3-coder` | 0.20 | 1.00 | 1.00 | 5.00 | 1,000,000 |

`qwen3.8-flash` 的价格曾与 dsh 自身的成本表（dsh-cost-meter，2026-10-03）核对，
保证两个仪表盘对同一模型计价一致。

### 3.5 MiniMax（`MINIMAX_PRICES`，USD，QoderCN `mmodel` 用）

| id | 缓存命中 | 缓存写入 | 输入 | 输出 | 上下文 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `minimax-m3` | 0.06 | 0.375 | 0.30 | 1.20 | 1,000,000 |
| `minimax-m2.7` | 0.06 | 0.375 | 0.30 | 1.20 | 1,000,000 |

### 3.6 其他厂商补充（`VENDOR_EXTRA_PRICES`）

| id | 缓存命中 | 缓存写入 | 输入 | 输出 | 上下文 | 币种 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `glm-5.2` | 2.00 | 0 | 8.00 | 28.00 | 1,000,000 | CNY |
| `glm-5` | 2.00 | 0 | 4.00 | 16.00 | 1,000,000 | CNY |
| `hy3` / `hy3-x` / `hy4-preview` | 0.035 | 0.14 | 0.14 | 0.58 | 192,000 | USD（厂商归属未公开，按 OpenCode Go 目录镜像） |

### 3.7 OpenAI（`OPENAI_PRICES`，USD，Codex provider 用）

来源：<https://developers.openai.com/api/docs/pricing>
所有带 `longContextThreshold: 272_000` 的模型：**单请求输入总量超过 272K** 时，
输入与缓存价格 ×2、输出 ×1.5（按整个请求计，不拆分）。

| id | 缓存命中 | 缓存写入 | 输入 | 输出 | 上下文 | 长上下文阶梯 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `gpt-6-astra` | 1.00 | 12.50 | 10.00 | 50.00 | 1,050,000 | 是 |
| `gpt-6-sol` | 0.20 | 2.50 | 2.00 | 10.00 | 1,050,000 | 是 |
| `gpt-6-luna` | 0.01 | 0.125 | 0.10 | 0.50 | 1,050,000 | 是 |
| `gpt-5.6-sol`（含裸 `gpt-5.6`） | 0.40 | 5.00 | 4.00 | 20.00 | 1,050,000 | 是 |
| `gpt-5.6-terra` | 0.20 | 2.50 | 2.00 | 12.00 | 1,050,000 | 是 |
| `gpt-5.6-luna` | 0.02 | 0.25 | 0.20 | 1.20 | 1,050,000 | 是 |
| `gpt-5`（含 o3/o4-mini） | 0.125 | 继承输入 | 1.25 | 10.00 | 400,000 | 否 |
| `codex-auto-review` | 0.02 | 继承输入 | 0.20 | 1.20 | — | **估算价**（计划内后台模型，无公开牌价） |

### 3.8 Anthropic（`CLAUDE_PRICES`，USD，Claude Code provider 用）

来源：<https://www.anthropic.com/pricing>
全家族缓存读取 ≈ 输入 10%（Opus 5.5 为 5%），缓存写入 = 输入 1.25×。
**特定版本行排在泛家族行之前，首个命中即用。**

| id | 匹配 | 缓存命中 | 缓存写入 | 输入 | 输出 | 上下文 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `claude-fable-5` | `fable|mythos`（Mythos 5 同价） | 1.00 | 12.50 | 10.00 | 50.00 | 1,000,000 |
| `claude-opus-5-5` | `opus-5-5`（2026-09-22 发布，比 Opus 5 便宜 20%，缓存读 $0.20） | 0.20 | 5.00 | 4.00 | 20.00 | 1,000,000 |
| `claude-opus-5` | `opus-5`、`opus-4.5~4.9`（同价代） | 0.50 | 6.25 | 5.00 | 25.00 | 1,000,000 |
| `claude-sonnet-5` | `sonnet-5` | 0.20 | 2.50 | 2.00 | 10.00 | 1,000,000 |
| `claude-haiku-4-5` | `haiku-4-5` | 0.10 | 1.25 | 1.00 | 5.00 | 200,000 |
| `claude-3-haiku` | `3-haiku` | 0.03 | 0.30 | 0.25 | 1.25 | 200,000 |
| `claude-sonnet` | `sonnet`（3.5/3.7/4/4.5/4.6 同价） | 0.30 | 3.75 | 3.00 | 15.00 | 200,000 |
| `claude-opus` | `opus`（3/4/4.1 旧 $15 档） | 1.50 | 18.75 | 15.00 | 75.00 | 200,000 |
| `claude-3-5-haiku` | 其余 `haiku` | 0.08 | 1.00 | 0.80 | 4.00 | 200,000 |

### 3.9 兜底价（`FALLBACK_PRICE`）

```js
{ id: "kimi-k2.6", cacheHit: 1.1, input: 6.5, output: 27.0, currency: "CNY", estimated: true }
```

无法识别的模型按 K2.6 标价估算，界面显示「估算」徽标。**兜底只影响显示的估算
费用**——QoderCN CLI 等 credits-only 工具完全不走费用路径。

## 4. 自定义价格（settings.customPrices）

在界面「模型 → 定价与货币」中编辑，存储于 `~/.doramonitor/config.json`：

```json
{ "model": "my-proxy-model", "currency": "USD", "input": 2, "cacheHit": 0.2, "output": 10, "label": "可选备注" }
```

- **匹配规则**：model 字段大小写不敏感，**先精确后子串，最长 pattern 优先**
  （如 `glm-5.3-flash` 会赢过 `glm-5.3`）。
- **留空的分项沿用官方价**：例如只想改 DeepSeek 的输入价，cacheHit/output 留空
  即可继续享受其峰谷分时价，而不是错误地继承 Kimi 兜底价（有专门测试守护）。
- 三个价格全为空的条目保存时被丢弃。
- 保存后服务端会 `invalidate()` + 强制重扫，费用立即重算。

## 5. 汇率（fxRate）

- 语义：**USD → CNY**，默认 7.2，合法范围 (0, 100000)。
- 只影响美元厂商的入账与美元显示；界面上改汇率后立即重算。
- CLI 状态栏的货币符号优先级：命令行 flag > settings.currencySymbol >
  `~/.kimi-code/kimi-status.toml` 的 `currency_symbol` > `"$"`。

## 6. 维护指南：如何新增/更新一个价格

1. 打开 `src/pricing.js`，找到对应厂商表（`KIMI_PRICES` / `DEEPSEEK_PRICES` / …）。
2. 新增行时**注意顺序**：更具体的 id（如 `-highspeed`、版本号更高的）必须排在
   泛匹配行之前。
3. `patterns` 同时覆盖裸 id 与带前缀写法（`/^kimi-k3.1-pro$/i`、
   `/kimi[_-]?k3[._-]1/i` 等），用 `_`/`-`/`.` 等价类放宽。
4. 若该模型还没有公开牌价，参考 `kimi-for-coding` 的做法：先映射到最接近的
   官方行并在注释中写明依据与日期；不要发明价格。
5. 在 `test/pricing.test.js` 加对应断言（精确价 + `estimated` 标记 +
   `listPrices` 完整性）。
6. 跑 `npm test`，然后**重启服务**（Node 启动时加载价格表到内存，改代码不重启
   不生效）并刷新页面。

历史依据举例（写在代码注释里）：K3.1 Pro 定价核实于 2026-10-24 Kimi 开放平台
定价页；`kimi-for-coding` 按计划模型选择器显示（K2.8 Preview）暂按 K2.7 Code
计价，等官方公布 K2.8 API 价后再迁移。
