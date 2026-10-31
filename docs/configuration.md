# 配置与设置

DoraMonitor 有三类配置：**自身设置**（`~/.doramonitor/config.json`）、**环境变量**、
以及它**代为管理**的 Kimi Code `config.toml`。本文逐一说明全部字段、默认值与
校验规则。

## 1. 自身设置：`~/.doramonitor/config.json`

- 读写失败一律静默回退默认值（坏配置绝不弄崩看板）。
- 保存为原子写（`config.json.<pid>.tmp` → rename）。
- 界面入口：「价目」页管理货币与价格；「额度」页的每张卡片可控制是否在首页展示；
  「同步」页管理多设备连接；首页图表标题旁可切换热力图和每日趋势范围。
- 保存后服务端强制重扫，所有设置**立即生效，无需重启**；daemon 每分钟读取最新同步设置。

### 1.1 完整字段与默认值

```json
{
  "currency": "CNY",            // 显示币种，仅 "CNY" | "USD"
  "currencySymbol": "¥",        // 符号（trim 后最多 4 字符；切币种自动带出 $/¥）
  "fxRate": 6.67,               // USD→CNY 汇率（默认取 2026-10 市场中间价），合法 (0, 100000)
  "customPrices": [],           // 自定义价格，见下
  "quotaAccounts": [            // 可选；配置后替代默认单 Kimi 账号
    { "tool": "kimi-code", "accountKey": "kimi:default", "label": "个人", "home": "/home/user/.kimi-code" },
    { "tool": "kimi-code", "accountKey": "kimi:work", "label": "工作", "home": "/home/user/.kimi-code-work" }
  ],
  "quotaEstimation": {
    "kimiCodeOnly": false,       // true 时仅用 Kimi Code 中的 Kimi 模型估算额度
    "codexOnly": false           // true 时仅用 Codex 中的 GPT 模型估算额度
  },
  "dashboard": {
    "hiddenQuotaCards": [],       // 首页隐藏的卡片 ID：tool:accountKey；默认全部显示
    "heatmapRange": "1y",        // "7d" | "30d" | "1y"
    "dailyRange": "30d"          // "7d" | "30d"
  },
  "sync": {                     // 多设备同步，详见 docs/sync.md
    "enabled": false,
    "backend": "ssh",           // "ssh" | "webdav" | "local"
    "deviceName": "",           // 空则取 hostname（≤64 字符）；不同安装必须唯一
    "syncInterval": 300,        // 秒，daemon 同步周期，必须 ≥30
    "local": {
      "path": ""                // local 后端的共享绝对路径（≤500），见 docs/sync.md
    },
    "ssh": {
      "host": "",               // ≤200
      "user": "",               // ≤64
      "port": 22,               // 1–65535
      "remotePath": "~/.kimi-status-sync",  // ≤300，~ 按远端 HOME 解析
      "identityFile": ""        // ≤300，支持 ~ 展开
    },
    "webdav": {
      "url": "",                // ≤300
      "username": "",           // ≤120
      "password": ""            // ≤200
    }
  }
}
```

### 1.2 customPrices 条目结构

```json
{
  "model": "my-model-or-substring",   // ≤120 字符；大小写不敏感，先精确后子串，最长优先
  "currency": "USD",                  // "CNY" | "USD"
  "input": 2.0,                       // 每 1M tokens；有限非负；null = 沿用官方价
  "cacheHit": 0.2,
  "output": 10.0,
  "label": "可选备注"                 // ≤120
}
```

规则：

- 三个价格**全 null 的条目保存时被丢弃**。
- 留空的分项**沿用匹配到的官方行**——例如只覆盖 DeepSeek 的输入价，
  缓存命中/输出仍享受其峰谷分时价，而不是错误地继承 Kimi 兜底价。
- 匹配命中后整体替换官方价，再进入统一的成本计算。
- 详见[计价体系 → 自定义价格](./pricing.md)。

## 2. 环境变量总表

### 2.1 数据目录

| 环境变量 | 影响的工具 | 默认（未设置时） |
| --- | --- | --- |
| `KIMI_CODE_HOME` | Kimi Code | `~/.kimi-code`（Windows `%USERPROFILE%\.kimi-code`） |
| `ZCODE_HOME` | ZCode | `~/.zcode` |
| `QODER_CN_CONFIG_HOME` | QoderCN (IDE) | win: `%APPDATA%\QoderCN`；mac: `~/Library/Application Support/QoderCN`；linux: `~/.config/QoderCN` |
| `QODER_CLI_HOME` | QoderCN CLI | `~/.qoder-cn` |
| `CODEX_HOME` | Codex | `~/.codex` |
| `CLAUDE_CONFIG_DIR` | Claude Code | `~/.claude` |
| `DSH_HOME` | dsh | `~/.dsh` |

Kimi 数据目录的完整优先级（`paths.js`）：

```
server --home/--dir 参数  >  界面路径控件  >  KIMI_CODE_HOME  >  ~/.kimi-code
```

合法性判定：目录存在且包含 `config.toml` 或 `sessions/`。所有 home 值都支持
`~`、`~/`、`~\` 与 Windows `%VAR%` 展开。

### 2.2 模型身份（Kimi Code）

| 环境变量 | 作用 |
| --- | --- |
| `KIMI_MODEL_NAME` | 注入一个"环境模型"，别名 `__kimi_env_model__`；wire 里该别名的记录解析为它 |
| `KIMI_MODEL_PROVIDER` | 可选，配套 provider |
| `KIMI_MODEL_ID` | 可选，覆盖计价用 id（默认同 NAME） |

### 2.3 其他

| 环境变量 | 作用 |
| --- | --- |
| `LANG` / `LC_ALL` / `LC_MESSAGES` | 后端语言探测回退链（Accept-Language → env → Intl），默认 `en` |
| `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL` | 设为 `1` 启用副模型实验特性（界面提示） |

## 3. Kimi Code config.toml（代为管理）

DoraMonitor 的「模型」页可读写 Kimi Code 的 `~/.kimi-code/config.toml`
（用 `smol-toml` 全文解析，**只改模型相关段**，hooks/permission 等未知段原样保留）。

### 3.1 安全机制

- 每次保存前先备份 `<config.toml>.kcd-bak`（best-effort）。
- 原子写：临时文件 `.<name>.tmp-<pid>-<ts>`，mode 0600，rename 替换。
- API 返回的永远是**掩码视图**：`api_key` → `has_api_key` 布尔；`env` → 只留
  键名；`__` 前缀的保留别名不显示。**API Key 永不出后端**。
- 模型别名解析（model-map.js）在读入时也会先剥离疑似密钥行。

### 3.2 校验规则（ConfigError 错误码）

| 规则 | 错误码 |
| --- | --- |
| TOML 解析失败 / 读失败 / 写失败 | `invalid_toml` / `read_failed` / `write_failed` |
| provider id：`^[A-Za-z0-9_-]+$` | `invalid_id` |
| 别名禁用 `__` 前缀（保留给系统占位符） | `invalid_alias` |
| provider type 白名单：`kimi, anthropic, openai, openai_responses, google-genai, vertexai` | `invalid_type` |
| base_url 必须 http(s) | `invalid_url` |
| 模型别名必须挂已存在的 provider | `invalid_provider` / `invalid_model` |
| **`max_context_size` 必须是正整数**（kimi-code schema 要求） | `invalid_value` |
| 删除不存在的对象 | `not_found` |

### 3.3 级联行为

- 删除 provider → 级联删除指向它的所有模型别名，并清理 `default_model` /
  `default_provider` / `[secondary_model]` 中的引用；providers 段空则整段删除。
- 保存模型时 `flat: true` 表示删除 provider 指针（写成独立模型）。
- 副模型（secondary model）可带 `default_effort / max_output_size /
  max_context_size / support_efforts / off_effort / max_input_size`；
  空 model 表示清除 `[secondary_model]` 段。

### 3.4 从模型目录导入

「模型」页的目录对话框来源三级回退：models.dev 在线镜像（gh-proxy 加速）→
磁盘缓存 `~/.kimicode-dashboard/catalog-cache.json` → 内置快照
`src/data/builtin-catalog.json`（193 provider / 7243 模型）。

导入 = 一次性原子写：创建 `[providers.<id>]`，为每个可用聊天模型建
`<id>/<modelId>` 别名并写入目录元数据（context、maxInput/maxOutput、
capabilities、thinking efforts、默认 effort=high），可选设置 default_model。

## 4. 运行时缓存与派生文件

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `~/.doramonitor/config.json` | 自身设置 | 上文 |
| `~/.doramonitor/status.cache` | CLI/daemon 状态行缓存 | `daemon` 每 30s（默认）原子覆盖 |
| `~/.doramonitor/daemon.pid` | daemon pid | 单实例守卫 + `stop` 子命令用 |
| `~/.doramonitor/sync.state` | 最近同步结果 `{lastSync, peers}` | daemon 同步成功后写 |
| `~/.doramonitor/device-id` | 随机安装 ID | 同步摘要的设备身份；不要在 Windows/WSL 或不同机器间复制 |
| `~/.doramonitor/remote-cache/` | 对端设备摘要缓存 | 日汇总、一分钟测算桶和额度样本；dashboard 请求只读此缓存 |
| `~/.doramonitor/quota-estimator/` | 等效额度测算数据 | 90 天额度样本、6 小时测算缓存、追加式完整历史和最高有效纪录 |
| `~/.kimicode-dashboard/catalog-cache.json` | models.dev 目录缓存 | 兼容 Tauri 的 `fetched_at` 蛇形命名 |

内存缓存（无需清理，进程生命周期内有效）：

| 缓存 | TTL | 失效条件 |
| --- | --- | --- |
| 采集快照（collect.js） | 15s | 文件戳变化 / `invalidate()`（会话变更、设置保存） |
| 聚合缓存（server.js） | 无 TTL | key 含 scannedAt，天然失效；上限 32 条 |
| 额度缓存（quota.js） | 60s | `refresh=1` |
| 目录缓存（catalog.js） | 60s | `refresh=1` |

## 5. 常见配置场景

**改显示币种为美元**：模型页 → 定价与货币 → 货币选 USD → 保存。内部账本不变，
仅展示换算。

**给中转站的模型定价**：自定义价格加一行 model 填中转站的模型名（或其可唯一
区分的子串），币种选对，填三项价格；分项留空则沿用官方价。

**Kimi Code 装在非默认位置**：设 `KIMI_CODE_HOME`，或在界面路径控件里填
（存 localStorage `kcd_home`，仅当前浏览器生效），或启动时 `--home`。

**改完 src 代码不生效**：价格表等模块在 Node 启动时加载进内存，需要重启服务；
而设置类（汇率/自定义价）走文件读取 + 强制重扫，保存即生效。
