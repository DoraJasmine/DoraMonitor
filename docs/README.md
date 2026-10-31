# DoraMonitor 文档中心

本地、隐私安全的 AI 编码工具用量看板，支持 Kimi Code、Codex、Claude Code、Oh My Pi、Gemini CLI、ZCode、QoderCN IDE、QoderCN CLI 和 dsh。

## 文档导航

| 文档 | 内容 | 适合谁读 |
| --- | --- | --- |
| [项目需求（PRD）](./product-requirements.md) | 产品范围、领域术语、兼容约束与验收基线 | 产品、设计与开发共同评审 |
| [架构重构方案](./architecture-refactor-plan.md) | 领域边界、分层依赖、DTO、调用链与实施阶段 | 评审和实施架构重构的人 |
| [数据迁移方案](./data-migration-plan.md) | v1/v2 schema、键稳定、备份、锁、peer 兼容与回滚 | 评审和实施数据迁移的人 |
| [未来功能计划](./future-roadmap.md) | 多 Kimi 账号、其他额度集成与同步增强 | 了解后续需求与优先级的人 |
| [功能与计算方式](./features.md) | 各页面、设置、CLI 与实现链路总览 | 想快速了解全部功能的人 |
| [当前架构总览](./architecture.md) | 采集、聚合、计价、展示、缓存与模块边界 | 想理解项目如何运转的人 |
| [用量统计与数据源](./tools.md) | 9 个工具采集器的数据目录、Token 口径与去重规则 | 关心数字准确性的用户与开发者 |
| [计价体系](./pricing.md) | CNY 账本、官方价目、峰谷价、长上下文与自定义价格 | 关心费用估算的用户 |
| [额度估算](./quota-capacity-estimation.md) | 跨客户端归属、缓存档、定期测算与校准逻辑 | 使用额度测算的用户与维护者 |
| [HTTP API](./api.md) | 端点、参数、响应与错误码 | 二次开发者 |
| [配置与设置](./configuration.md) | 设置字段、环境变量、目录检测与 Kimi 配置管理 | 需要精细调整的用户 |
| [会话管理](./sessions.md) | 工作区隔离、归档/删除与安全预览 | 使用会话功能的用户 |
| [多设备同步](./sync.md) | SSH/WebDAV、摘要格式、额度用量桶与对端缓存 | 多设备用户 |
| [CLI 与守护进程](./cli.md) | 子命令、状态栏、daemon 与 tmux | 终端用户 |
| [部署与运行](./deployment.md) | npm、静默启动、Windows 自启与故障排查 | 部署和维护服务的人 |
| [npm 发布](./release.md) | dry-run、tarball 预览、发布门禁与发布后验证 | 发布维护者 |
| [开发指南](./development.md) | 本地开发、测试、工具采集器扩展与依赖策略 | 贡献者 |
| [隐私与安全](./privacy.md) | 数据边界、脱敏和网络行为 | 所有人 |
| [已知限制与注意事项](./limitations.md) | 部署、统计、计价、额度、同步与开源边界 | 上线、对账或公开仓库前阅读 |

## 30 秒了解

- 读取本地用量元数据并生成趋势、费用、额度和会话视图。
- 默认只监听 `127.0.0.1`；多设备上传必须显式启用。
- 全局安装：`npm install -g doramonitor && doramonitor`。
- 后台运行：`doramonitor daemon --background`，再执行 `doramonitor web --background --no-open`。

其他入口：[英文 README](../README.md) · [中文 README](../README.zh-CN.md) · [MIT 许可证](../LICENSE) · [来源与署名](../NOTICE)
