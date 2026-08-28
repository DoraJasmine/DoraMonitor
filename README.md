# AI Usage Monitor

本地、隐私安全的 **AI 编码工具用量看板**：一个页面汇总 Kimi Code、ZCode、QoderCN、QoderCN CLI 的 token 用量、费用与额度。

由 [kimicode-dashboard](https://github.com/JochenYang/kimicode-dashboard) 架构扩展而来（React 19 + Tailwind + Node 标准库 HTTP server，零后端框架依赖；SQLite 读取使用 Node 22 内置 `node:sqlite`）。

![截图](assets/screenshot.png)

## 支持的工具

| 工具 | 数据来源（只读） | 统计内容 |
|---|---|---|
| Kimi Code | `~/.kimi-code/sessions/**/wire.jsonl`（全部 agent 目录） | token、估算费用（Kimi 官方价）、套餐杠杆、5h/7d 额度与重置时间 |
| ZCode | `~/.zcode/cli/db/db.sqlite` → `model_usage` | token（含 reasoning/cache 分项） |
| QoderCN（IDE） | `~/.config/QoderCN/SharedClientCache/cache/db/local.db` → `chat_message` | token（内部模型码自动映射显示名） |
| QoderCN CLI | `~/.qoder-cn/projects/**/*.jsonl` | **credits 计费值**（CLI 不落地 token，仅记录 credits） |

- 所有 SQLite 均以**只读模式**打开，不影响运行中的工具。
- 每个工具的数据缺失时自动降级为「不可用」，不影响其他工具展示。

## 快速开始

需要 Node.js **22.5+**（内置 `node:sqlite`）。

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
- **时间范围**：今天 / 近 7 天 / 近 30 天 / 全部
- **范围 KPI 卡**：各范围 token、请求数、费用、命中率
- **Kimi 额度卡**：5 小时滚动窗口 + 每周额度（自订阅日每 7 天刷新），显示精确重置倒计时
- **年度热力图**：GitHub 风格每日 token 强度
- **每日趋势**：Top 模型多序列曲线
- **模型统计 / 最近请求**：带工具维度与 credits 列
- **会话管理**（Kimi）：按工作区归档 / 恢复 / 删除
- **模型配置**（Kimi）：config.toml 别名与价格映射

## 状态行 & tmux 守护进程

```bash
npm run status                       # 单行输出，适合 shell prompt
npm run status -- --style tmux       # tmux 颜色样式
npm run status -- --tool kimi-code   # 只看 kimi
node src/cli.js daemon --interval 30 # 守护进程：定时写缓存文件
```

输出示例（`--plan-price 199 --currency ¥`）：

```
Z:287.7M | K:852.0M ¥261.79 | QC:3924cr | Q:107.7K (1.32x) 命中:96.7%
```

- 杠杆（`1.32x`）仅在配置了套餐价时显示，默认读取 `~/.kimi-code/kimi-status.toml` 的 `plan_price` / `currency_symbol`，也可用 `--plan-price` 覆盖。
- daemon 缓存文件默认 `~/.ai-usage-monitor/status.cache`，tmux 可直接读取。

## Kimi 额度口径说明

Kimi 的额度模型**没有月度窗口**（官方文档）：

- **每周额度**：自订阅日起每 7 天自动刷新；
- **5 小时窗口**：滚动限速，窗口结束自动恢复。

看板通过 `GET https://api.kimi.com/coding/v1/usages`（读取 `~/.kimi-code/credentials/kimi-code.json` 的本地凭证）获取两个窗口的已用百分比与官方重置时间。凭证为 15 分钟短效 token，由 kimi CLI 自动轮换；凭证过期时额度卡显示「待刷新」，不影响本地统计。

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
