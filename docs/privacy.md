# 隐私与安全

DoraMonitor 的核心承诺：**只读用量元数据，不读内容，不上传，不碰密钥**。
本文列出每一条承诺的具体实现位置，便于审计。

## 1. 读什么、绝不读什么

### 读入并聚合的数据

| 数据 | 来源 | 用途 |
| --- | --- | --- |
| 模型名 / 路由码 | 各工具用量记录 | 展示与计价 |
| 时间戳 | 用量记录 | 趋势、热力图、峰谷计价 |
| Token 四分项（普通输入/模型输出/缓存读取/缓存创建） | 用量记录 | 用量统计与费用 |
| credits | QoderCN CLI | 计费量 |
| Codex `rate_limits` 快照 | rollout 文件 | 额度卡 |
| Kimi `config.toml` 的模型别名字段 | `default_model`、`[models.*]` 的 provider/model/display_name | 模型名映射 |
| Kimi Code 会话 `state.json` 的 `{title, workDir, createdAt, updatedAt, isCustomTitle}` | 会话管理列表 | 会话列表展示 |

### 绝不读入、绝不存储、绝不展示

- 提示词、回复、代码、工具参数全文、日志全文
- API Key、token、secret、password、authorization（任何形式的凭据）
- 文件内容 blob、图片附件
- Claude/Anthropic 的消息正文、Codex 的指令正文

各 provider 的解析器带**快速拒绝**：行内不含 `"usage.record"` / `"tool.call"`
等字面量就不做 JSON.parse——解析面被压到最小。

## 2. 凭据防线的四道闸

1. **模型别名解析前剥离**（`model-map.js`）：config.toml 逐行过滤，匹配
   `api_key / token / secret / password / authorization` 及任何
   `*KEY|TOKEN|SECRET|PASSWORD` 命名的行直接置空，之后才解析别名。
   （测试断言：加载结果里绝不出现 `sk-...`，连 `"api_key"` 字符串都不出现。）
2. **API 掩码视图**（`config-store.js` 的 `getConfigView`）：`/api/config`
   返回的 provider/model 条目里 `api_key` 永远替换为 `has_api_key` 布尔，
   `env` 只返回 `env_keys` 键名列表。**密钥值不出后端进程**。
3. **会话预览脱敏**（`sessions.js`）：匹配
   `/api[_-]?key|sk-[a-zA-Z0-9]{12,}|BEGIN (RSA |OPENSSH )?PRIVATE KEY/i` 的
   文本整段替换为 `[redacted: possible secret content]`。
4. **写文件权限**：Kimi 凭据刷新（quota.js）与 config.toml 写入都用
   tmp + rename 原子写，凭据文件 mode 0600。

## 3. 网络边界

- **默认只绑定 `127.0.0.1:3847`**；`--host` 可改但那是你的显式决定。
- **无 CORS 响应头**：任何其他网站/源的页面都无法用浏览器读取本服务的数据
  （同源策略拦截）。
- **回环 Host 与写请求 Origin 校验**：默认绑定下拒绝非本机 Host，阻止 DNS 重绑定；写请求携带的 Origin 必须与当前服务一致，阻止跨站提交。无 Origin 的本机 CLI/脚本仍可调用。
- **设置响应脱敏**：`GET/POST /api/settings` 不返回 WebDAV 密码，只返回 `hasPassword` 状态。
- **无鉴权**：这是"仅本机"设计的前提——不要把 `--host 0.0.0.0` 暴露到不可信
  网络。
- 出站网络请求**只有三类**，都可预期：
  1. `quota.js` → `https://api.kimi.com/coding/v1/usages` 与
     `https://auth.kimi.ai/api/oauth/token`（Kimi 额度卡；凭据来自本机
     kimi-code 的登录态）；
  2. `codex-quota.js` → `https://chatgpt.com/backend-api/wham/usage` 与 OpenAI
     OAuth 刷新端点（Codex 额度；使用本机 Codex 登录态，60 秒节流）；
  3. `catalog.js` → models.dev 在线目录镜像（模型目录导入功能；失败三级回退
     到缓存/内置快照）。
- 多设备同步是**你显式配置后**才有的出站行为。除日粒度 token 汇总外，额度测算还会
  同步一分钟粒度的时间、工具、模型和 Token 元数据，以及额度百分比样本；不含提示词、
  回复、会话正文或凭证；工作区目录名随 v4 `wsNames` 同步（2026-11-01 所有者修订，
  仅用于自建通道的合并视图展示，见[同步文档 → 安全说明](./sync.md)）。

## 4. 会话管理的高危操作防护

- 删除会话/工作区必须 `confirm: true`（HTTP 400 `confirm_required`）。
- 工作区删除有三道闸：非空拒绝、残留文件拒绝（`force` 才可清）、
  路径正则 + resolve + `startsWith(root)` 双重防穿越（`path_escape`）。
- 预览重建**刻意排除**工具调用详情与工具 dump；think 部分也不显示。
- 列表接口永不返回 `lastPrompt` 等内容字段（测试守护）。

## 5. 数据存储位置（本机）

| 数据 | 位置 |
| --- | --- |
| 设置（含 WebDAV 密码、SSH 配置） | `~/.doramonitor/config.json`（本机明文，文件系统权限保护，与 kimi-code 自身凭据同级） |
| 对端设备摘要缓存 | `~/.doramonitor/remote-cache/` |
| 额度样本、测算历史和最高值 | `~/.doramonitor/quota-estimator/` |
| 目录缓存 | `~/.kimicode-dashboard/catalog-cache.json`（沿用上游项目的历史路径，迁移计划见[综合改进方案](./comprehensive-improvement-plan.md) A4） |
| daemon 状态 | `~/.doramonitor/{status.cache,daemon.pid,sync.state}` |

DoraMonitor 自身**没有**遥测、上报、自动更新检查。

## 6. 审计提示

想自行验证以上声明，推荐阅读顺序：

1. `src/tools/base.js` — 记录形状（读什么字段的最终清单）；
2. `src/tools/*.js` — 每个工具采集器实际 parse 的行；
3. `src/model-map.js:40-51` — 密钥行剥离；
4. `src/config-store.js:246-307` — 掩码视图；
5. `src/sessions.js:437-509` — 预览脱敏与净化；
6. 出站实现位于 `quota.js`、`codex-quota.js`、`catalog.js` 和显式启用后的 `sync.js`。
