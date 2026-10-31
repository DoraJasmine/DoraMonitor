# 开发指南

## 1. 本地开发

```bash
npm ci
npm run dev
```

- API：`127.0.0.1:3847`；Vite：`127.0.0.1:5173`，代理 `/api`。
- 前端即时热更新；修改后端后需要重启 API。
- 不需要浏览器自动化作为验收前提：至少运行测试、生产构建和实际 API/CLI 验证。

## 2. 质量门禁

```bash
npm test
npm run build
npm pack --dry-run
```

`prepack` 自动执行测试和构建。GitHub Actions 在 Ubuntu/Windows、Node 22/24 矩阵上执行相同检查。测试使用 Node 内置 runner 和系统临时目录，不依赖本机真实会话。

## 3. 术语与目录

- **tool**：Kimi Code、Codex、omp 等 AI 编码工具。采集器位于 `src/tools/`，注册表导出 `TOOLS`、`listTools`、`getTool`。
- **quotaProvider**：额度账户族，仅用于额度领域、存量额度数据及同步适配；公开额度 API 与前端统一传 tool，映射集中在 `src/quota-tool.js`。
- **modelProvider / 配置 provider**：模型厂商或 Kimi `config.toml` 中的服务提供方，例如 OpenAI、Kimi、DeepSeek。`/api/config/providers` 等字段属于这一概念，不能改成 tool。
- 统一用量记录：`{ tool, time, model, inputOther, output, inputCacheRead, inputCacheCreation, costCny, credits, project, session }`。
- 内部费用统一为 CNY；展示货币只在响应边界转换。

主要目录：

```text
src/tools/          工具采集器与注册表
src/collect.js     增量采集与快照缓存
src/aggregate.js   时间范围、模型、趋势与热力图
src/pricing.js     官方价、自定义价与 CNY 账本
src/quota-*.js     额度采样、估算、校准、存储 schema 与迁移
src/quota-tool.js  公开 tool 与内部额度账户族的集中映射
src/tool-quota-service.js 额度读取、历史、校准的应用编排
src/server.js      HTTP 参数、DTO、错误映射与静态托管
web/src/           React SPA
test/              Node 测试
scripts/           Windows 安装、静默启动与自启
```

## 4. 新增工具采集器

1. 新建 `src/tools/x.js`，导出 `{ id, label, creditsOnly?, defaultHome, isAvailable, scan }`。
2. `scan` 返回 `{ records, meta }`；全零记录丢弃，时间降序，明确去重规则，坏行不得影响其他工具。
3. 在 `src/tools/index.js` 的 `TOOLS` 注册，并在 `sourceFiles()` 提供增量探测文件。
4. 在 `src/tools/base.js` 的 `TOOL_META` 添加名称和颜色。
5. 对齐 Token 口径，尤其是输入是否包含缓存；路由模型码必须在 `model-identity.js` 中映射到显示名和计价键。
6. 添加测试：缺目录、正常解析、全零、去重、坏行、增量扫描等价性。

不要读取提示词、回复、代码或凭据来实现用量统计。

## 5. 修改价格或额度估算

- 价格行必须附官方来源链接并添加定价测试；修改后重启服务。
- 额度估算只纳入目标厂商模型，客户端开关不能意外纳入无关模型。
- 重置、百分比下降、未同步完整区间不能作为高质量样本。
- 推测值必须携带方法、覆盖范围与置信度，不能展示成官方固定额度。

## 6. 新增 API

在 `src/server.js` 的路由链中添加端点，统一返回 JSON、明确错误码，复用 `collect()` 快照而不是另扫文件。前端在 `web/src/lib/backend.js` 添加同名语义的数据函数，并更新 `docs/api.md`。

## 7. 依赖与发布

运行时依赖只有 `smol-toml` 和 `fzstd`。新增运行时依赖必须说明必要性并验证 npm tarball 安装；前端依赖放在 devDependencies。发布预览和正式发布流程见[发布文档](./release.md)。
