# DoraMonitor 统一术语表

本文是全项目文档的统一术语对照表，供读者理解与后续写作者引用。写新文档或修订旧文档时，
同一概念应使用同一译法；代码标识符（字段名、环境变量、文件名、SQL）保持英文原样，不做翻译。

## 1. 核心领域术语

| 术语 | 英文 | 说明 |
|---|---|---|
| 工具 | tool | 用户视角的 AI 编码工具（如 Kimi Code、Codex） |
| 额度账户族 | quotaProvider | 额度归属的账户族（如 kimi、openai） |
| 模型厂商 | modelProvider | 模型上游厂商 |
| 计价身份 | modelResolved / pricing key | 用于匹配价目表的模型归一标识 |
| 聚合桶（日桶） | day bucket | 按日聚合的用量数据单元；正文中首次出现写全称"按日聚合桶"并括注简称，后文可用"日桶" |
| 逐请求记录 | usage record / row | 每次模型请求一行的用量明细 |
| 统计口径 | accounting semantics | 数字如何统计的规则（如 Token 四分项） |
| 账本 | ledger | CNY 内部计费账本（字段 `costCny`） |
| 对端 | peer | 多设备同步中的其他设备（统一用"对端"，不用"远端"） |
| 回退 | fallback | 主路径不可用时的降级路径（如三级回退、`FALLBACK_PRICE` 回退价） |
| 健康探测 | health probe | 服务可用性检查（`/api/health`、PID 心跳） |
| 水位 | watermark | 已同步范围的标记（`usageWaterMark`） |
| 额度账号 | accountKey | 稳定匿名的账号标识，同一工具可有多个账号 |
| 客户端范围 | usageScope | 参与额度估算的客户端范围（全部客户端 / 仅 Kimi Code / 仅 Codex） |
| 工作区键 | workspaceKey | 用量记录归一化出的稳定工作区标识（哈希或路径来源） |
| 设备身份 | deviceName / deviceId | 同步用的设备名与随机安装 ID，二者共同防止同名安装覆盖 |
| Token 四分项 | token quadrants | 普通输入 / 模型输出 / 缓存读取 / 缓存创建（`inputOther` / `output` / `inputCacheRead` / `inputCacheCreation`） |
| 缓存命中率 | cache hit rate | `inputCacheRead / (inputOther + inputCacheRead + inputCacheCreation)` |
| 等效额度估算 | quota capacity estimation | 由官方额度百分比与本地用量反推的推测值，须标注置信度 |
| 额度样本 | quota sample | 按窗口（5h/7d）采样的额度百分比记录，保留 90 天 |
| 峰谷分时价 | peak / off-peak pricing | DeepSeek 等按时段区分的计价规则 |
| 回退价 | fallback price | 无法识别模型时按 K2.6 标价估算的 `FALLBACK_PRICE` |
| 对端缓存 | remote-cache | 本机保存的其他设备摘要缓存（`~/.doramonitor/remote-cache/`） |
| 凭据 | credentials | 登录态与密钥文件；文档中一律不展示其值 |

## 2. 用语规范（写作约定）

| 规范 | 说明 |
|---|---|
| 回滚 vs 回退 | rollback 一律写"回滚"（数据迁移、版本回退开关）；fallback 一律写"回退/降级"。二者不混用 |
| 对端 vs 远端 | 同步的另一台设备写"对端"；SSH/共享存储的远端主机语境可写"远端"（如"远端 HOME 解析"） |
| Token 四分项名称 | 统一为"普通输入 / 模型输出 / 缓存读取 / 缓存创建"；价目表列名"缓存命中/缓存写入"对应字段 `cacheHit`/`cacheWrite`，保持原样 |
| 聚合桶 | 首次出现写"按日聚合桶（简称日桶）"，后文可用"日桶"；不再混用"聚合桶/日聚合桶"等变体 |
| 口语词替换 | 兜底→回退/降级；落盘/落库→持久化；跑→执行；走→经由；拿到→获得；卡住→阻塞；臆测/瞎猜→无依据推断 |
| 密码学术语 | "哈希""加盐""HMAC"保留原样 |
| 额度体系用语 | "等效额度估算""测算区间""置信度"等保留既有用法 |

## 3. 相关文档

- 领域术语与分类约束的规范性定义见[项目需求（PRD）§4](./product-requirements.md)。
- 各术语的实现位置见[架构总览](./architecture.md)与[开发指南 §3](./development.md)。
