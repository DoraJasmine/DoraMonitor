# 开发指南

面向要给 DoraMonitor 贡献代码的开发者：目录结构、本地开发、测试、构建、
常见扩展点的改造步骤，以及当前已知的遗留问题。

## 1. 本地开发

```bash
npm install
npm run dev        # concurrently 同时起：API(127.0.0.1:3847) + Vite(127.0.0.1:5173)
```

- `npm run dev:api` / `npm run dev:web` 可拆分进程。
- Vite 把 `/api` 代理到 `http://127.0.0.1:3847`；前端改代码即时热更新，
  **后端改代码需手动重启 API 进程**（无热重载）。

### 测试

```bash
npm test           # node --test test/*.test.js（Node 内置 runner，无第三方框架）
```

- 14 个测试文件，覆盖：聚合、价目、目录导入、config 读写、模型映射/身份、
  各 provider 解析与去重、会话管理、热力图、paths、同步摘要、数据准确性回归
  （`data-accuracy.test.js` 是专门的"数字必须对"回归集）。
- 夹具模式：`fs.mkdtempSync` 在系统临时目录搭一次性 HOME，测试尾部删除；
  不写仓库内夹具。zstd 夹具用 `zlib.zstdCompressSync` 生成；无 zstd 绑定的旧
  Node 上相关用例自动 skip。
- `prepack`（npm 发布/打包前）= `npm test && npm run build`，是事实上的 CI 门禁。

### 构建

```bash
npm run build      # vite build → dist/（emptyOutDir）
npm run preview    # 本地预览构建产物
```

`manualChunks` 把 react / framer-motion / lucide / radix 拆成独立 vendor chunk
——内容哈希文件名让服务端能发 `immutable` 一年缓存，业务代码改动不击穿缓存。

## 2. 目录结构与职责

见[架构总览 → 模块地图](./architecture.md)。前端要点补充：

- `web/src/App.jsx`：SPA 主壳 + 用量页（无 react-router，自实现
  `usage / sessions / models` 三页切换 + `history.replaceState`，配合服务端
  SPA 回退）。
- `web/src/pages/ModelsPage.jsx`：模型/Provider/副模型/定价与货币 四个 Tab。
- `web/src/pages/SessionsPage.jsx`：会话管理页。
- `web/src/lib/backend.js`：数据层双通道（HTTP `/api/*` ↔ Tauri `invoke`），
  函数名即语义（`fetchSummary`、`archiveSession`…），端点对照表见
  [API 参考](./api.md)。
- `web/src/i18n.js`：zh/en 约 230 个 key；`fill(template, vars)` 做占位符替换。
- localStorage 键：`kcd_theme` / `kcd_locale` / `kcd_page` / `kcd_home` /
  `kcd_range` / `aum_tool` / `aum_device`。

### 样式系统

- Tailwind `darkMode: ["class"]`；主题切换 = `<html>` 的 `light` class，
  `index.html` 里有防闪烁内联脚本（首帧前读 `localStorage.kcd_theme`）。
- 颜色全走 shadcn 式 HSL CSS 变量；专属 `heat.0~4` 五档热力图色。
- 性能决策：热力图 tooltip 用原生 `title` 而非 Radix Tooltip（约 370 个格子 ×
  Radix + framer-motion 曾导致滚动卡顿）；Radix 弹层 `modal=false` +
  `styles.css` 里对抗 `react-remove-scroll` 的样式，避免锁 body 造成页面横移。

## 3. 如何新增一个 provider

以"新工具 X"为例：

1. **建 `src/providers/x.js`**：`module.exports = { id, label, creditsOnly?,
   defaultHome, isAvailable, scan(home) }`。
   - `scan` 返回 `{ records, meta }`（meta 含 `filesScanned/linesSeen/
     recordCount/home/.../errors≤20`）；records 用 `emptyRecord("x")` 起步。
   - 遵守通用约定：只读元数据、全零丢弃、time 降序、去重规则明确
     （参考[数据源与采集](./providers.md)）。
   - token 口径对齐：先弄清目标工具的 `input_tokens` 是否含缓存
     （OpenAI 含 / Anthropic、DeepSeek 不含），在归一化处拆好四类 token。
2. **注册**：`src/providers/index.js` 的 `PROVIDERS` 数组加入，并在
   `sourceFiles()` 里给出增量探测文件集。
3. **元数据**：`providers/base.js` 的 `TOOL_META` 加 `{ label, color }`。
4. **模型身份**：若工具记录内部路由码，在 `model-identity.js` 补
   `QODER_DISPLAY_NAMES`（或 `EXTRA_DISPLAY_NAMES`）与 `PRICING_KEYS`——
   **有显示名的码必须有计价键**（测试强制）。
5. **测试**：新建 `test/x.test.js`，至少覆盖：缺目录空结果、正常解析、
   全零跳过、去重、坏行容错。跑 `npm test`。

## 4. 如何更新/新增价格行

见[计价体系 → 维护指南](./pricing.md)。核心三条：具体行排泛匹配行之前、
注释写明价格来源与核实日期、补测试。**改完记得重启服务**。

## 5. 如何加一个 API 端点

`src/server.js` 的 `handleApi`（约 230–634 行）：

1. 在路由判断链中加 `if (url.pathname === "/api/xxx")`；
2. 用 `json(res, 200, {...})` 输出（自动带 no-store 头）；
3. 错误走 `mapSessionError` / `mapConfigError` 同款 code→status 映射；
4. 若依赖采集数据，从 `collect({force})` 快照取，不要自己读文件；
5. 前端在 `web/src/lib/backend.js` 加对应 fetch 函数（保持 HTTP/Tauri 双通道
   的函数签名习惯）。

## 6. 发布（npm）

- `package.json` 的 `files` 白名单：`src`、`dist`、`scripts`、`assets`、
  `README.md`——**`dist` 必须先构建**，`prepack` 会强制 `npm test && npm run build`。
- `bin: doramonitor → src/doramonitor.js`，全局安装后得到 `doramonitor` 命令。

## 7. 依赖策略

- **运行时依赖刻意只有 2 个**：`smol-toml`（config.toml）、`fzstd`（纯 JS zstd）。
  这是 Windows 离线包能只带一份 `node_modules/smol-toml` 的前提。新增运行时
  依赖前先想离线打包链路；能用 Node 内置（`zlib`、`node:sqlite`、`node:test`）
  就用内置。
- devDependencies：React/Vite/Tailwind/Radix/framer-motion 等前端件 +
  `concurrently`；`@tauri-apps/*` 为桌面壳预留（前端 `backend.js` 的 invoke
  通道），当前仓库不含 Tauri 壳源码。

## 8. 已知遗留问题 / 待清理

以下问题在当前代码库真实存在，改动相关区域时顺手处理：

1. **`web/web/`**：`web/src` 的一份过时拷贝（无主题切换、modelLabel 逻辑相反、
   用 `costUsd` 字段）。**没有任何构建/服务端代码引用它**，纯遗留，可删。
2. **`test/test/`**：10 个旧版测试副本（2026-09-18 快照）。`npm test` 的 glob
   `test/*.test.js` 不含子目录，不会运行，纯遗留，可删。
3. **`scripts/scripts/`**：3 个 ps1 的旧副本（install-windows.ps1 旧版本）。
4. **`assets/assets/screenshot.png`**：与 `assets/screenshot.png` 重复的嵌套副本。
5. **README 落后于代码**：README.zh-CN.md 的"费用参考表"仍是旧的 USD 价
   （实际已改为 CNY 官方价 + 多厂商）；"桌面端（Tauri）"一节引用的
   `npm run tauri:dev` / `tauri:build` 脚本已不存在于 package.json。
6. **`doramonitor.js` 两处帮助文案路径错误**：写成 `~/.doramonitor-monitor/`，
   实际是 `~/.doramonitor/`（见 [CLI 文档勘误](./cli.md)）。
7. **`web/src/i18n.js` 的 `navUsage` key 在 zh/en 里各定义了两次**（值相同，
   后者覆盖前者，无实际影响）。
8. **`aggregateToolEvents` 的 `all` 范围不过滤**（start=0）：设计如此（事件无
   精确时间的回退到 mtime），但与工具 token 的 range 语义不同，UI 上注意区分。
9. 无 CI（`.github/` 不存在）：质量门禁只有本地 `prepack` 钩子。
