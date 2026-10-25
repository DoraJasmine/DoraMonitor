# DoraMonitor 文档中心

> 本地、隐私安全的 AI 编码工具用量看板 — 支持 Kimi Code、ZCode、QoderCN、QoderCN CLI、
> Codex、Claude Code、dsh（DeepSeek Harness）七类工具。

这里是 DoraMonitor 的完整技术文档。所有文档基于当前源码撰写，并随代码同步维护。

## 文档导航

| 文档 | 内容 | 适合谁读 |
| --- | --- | --- |
| [架构总览](./architecture.md) | 整体架构、模块地图、采集→聚合→展示全链路、增量缓存、目录结构 | 想理解项目如何运转的所有人 |
| [数据源与采集](./providers.md) | 七个 provider 逐一详解：数据目录、扫描文件、事件解析、token 归一化、去重规则 | 想知道"数据从哪来、准不准"的用户与开发者 |
| [计价体系](./pricing.md) | 内部 CNY 账本设计、全部内置价目表、DeepSeek 峰谷价、长上下文阶梯价、自定义价格、模型识别与映射链 | 关心费用估算准确性的用户 |
| [HTTP API 参考](./api.md) | 全部 `/api/*` 端点：方法、参数、响应结构、错误码 | 二次开发、写脚本调用的人 |
| [配置与设置](./configuration.md) | 设置文件全字段说明、环境变量总表、数据目录探测规则、Kimi config.toml 管理与目录导入 | 想精细调整行为的用户 |
| [会话管理](./sessions.md) | 工作区/会话枚举、归档/恢复/删除、安全预览的重建与脱敏规则 | 使用会话管理功能的用户 |
| [多设备同步](./sync.md) | SSH / WebDAV 双后端、日粒度摘要格式、对端缓存、设备页签的工作方式 | 多台设备使用的用户 |
| [CLI 与守护进程](./cli.md) | `doramonitor` 全部子命令、状态栏输出格式、daemon 单实例与 pid 管理、tmux 集成 | 终端/状态栏用户 |
| [部署与运行](./deployment.md) | npm 方式、Windows 一键安装器、计划任务自启、三种启动方式对比、日志与故障排查 | 部署和维护服务的人 |
| [开发指南](./development.md) | 目录结构、技术栈、测试、构建、如何新增 provider / 价格行、已知遗留问题 | 贡献代码的开发者 |
| [隐私与安全](./privacy.md) | 读什么、绝不读什么、脱敏与打码规则、网络边界 | 所有人 |

## 30 秒了解 DoraMonitor

- **是什么**：跑在本机的 Web 仪表盘 + CLI 状态栏，读取各 AI 编码工具在本地磁盘留下的
  用量元数据（模型名、时间、Token 数），聚合为趋势图、热力图、费用估算和额度显示。
- **不是什么**：不联网上传数据（同步功能除外，且由你显式配置）、不读取提示词/回复/代码、
  不读取任何 API Key。
- **怎么跑**：`npm start` 后访问 <http://127.0.0.1:3847/>；Windows 也可用计划任务 + 隐藏窗口
  常驻（见[部署与运行](./deployment.md)）。

## 快速链接

- 主仓库首页：[README.zh-CN.md](../README.zh-CN.md) / [README.md](../README.md)
- 运行时依赖刻意只有两个：`smol-toml`（读写 Kimi config.toml）、`fzstd`（纯 JS zstd 解压）
- 许可证：[MIT](../LICENSE)
