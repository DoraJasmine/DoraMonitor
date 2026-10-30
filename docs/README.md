# DoraMonitor 文档中心

本地、隐私安全的 AI 编码工具用量看板，支持 Kimi Code、Codex、Claude Code、Oh My Pi、Gemini CLI、ZCode、QoderCN IDE、QoderCN CLI 和 dsh。

## 文档导航

| 文档 | 内容 | 适合谁读 |
| --- | --- | --- |
| [架构总览](./architecture.md) | 采集、聚合、计价、展示、缓存与模块边界 | 想理解项目如何运转的人 |
| [数据源与采集](./tools.md) | 9 个工具采集器的数据目录、Token 口径与去重规则 | 关心数字准确性的用户与开发者 |
| [计价体系](./pricing.md) | CNY 账本、官方价目、峰谷价、长上下文与自定义价格 | 关心费用估算的用户 |
| [额度估算](./quota-capacity-estimation.md) | 跨客户端归属、缓存档、长程区间与校准逻辑 | 使用额度测算的用户与维护者 |
| [HTTP API](./api.md) | 端点、参数、响应与错误码 | 二次开发者 |
| [配置与设置](./configuration.md) | 设置字段、环境变量、目录检测与 Kimi 配置管理 | 需要精细调整的用户 |
| [会话管理](./sessions.md) | 工作区隔离、归档/删除与安全预览 | 使用会话功能的用户 |
| [多设备同步](./sync.md) | SSH/WebDAV、摘要格式、额度用量桶与对端缓存 | 多设备用户 |
| [CLI 与守护进程](./cli.md) | 子命令、状态栏、daemon 与 tmux | 终端用户 |
| [部署与运行](./deployment.md) | npm、静默启动、Windows 自启与故障排查 | 部署和维护服务的人 |
| [npm 发布](./release.md) | dry-run、tarball 预览、发布门禁与发布后验证 | 发布维护者 |
| [开发指南](./development.md) | 本地开发、测试、工具采集器扩展与依赖策略 | 贡献者 |
| [隐私与安全](./privacy.md) | 数据边界、脱敏和网络行为 | 所有人 |

## 30 秒了解

- 读取本地用量元数据并生成趋势、费用、额度和会话视图。
- 默认只监听 `127.0.0.1`；多设备上传必须显式启用。
- 全局安装：`npm install -g doramonitor && doramonitor`。
- 后台运行：`doramonitor web --background --no-open`。

其他入口：[英文 README](../README.md) · [中文 README](../README.zh-CN.md) · [MIT 许可证](../LICENSE) · [来源与署名](../NOTICE)
