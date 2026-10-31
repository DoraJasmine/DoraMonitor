# 改进方案:用量洞察增强实施计划(SQLite 行存版)

> 版本:v2.1(2026-10-31)——**M1-M3 已全部实施并验收**:存储层(store.js + workspaces.js + legacy 导入)、三个 usage API、前端 R1-R4(筛选条/Hero/工作区面板/模型三态/当日与模型下钻弹层/CSV 导出)。验证:269 项测试全绿、真实数据冒烟(13.5k 行/23 工作区)、浏览器视觉验收(截图)。
> 版本:v2.0 变更:放弃"桶 schema v4 加维度",改为直接引入 `node:sqlite` 行存(Node 免 flag 下限 22.13),同时解除"逐请求明细仅近 N 天"的限制。
> 配套需求文档:[usage-insights-requirements.md](./usage-insights-requirements.md)
> 性质:技术实施方案,按阶段可独立交付、独立验收。

## 0. 方案选型结论

三个候选(详见需求文档讨论):

| 方案 | 结论 |
| --- | --- |
| A. 桶 schema v4 加维度 | ❌ 放弃——为一套注定退役的预聚合结构做迁移是浪费 |
| B. 自研分片 JSON 账本(dsh-all-usage 路线) | ❌ 放弃——它是宿主插件、必须零文件布局假设才有此设计;账本/revision/分片均为自研复杂度 |
| C. **本地 SQLite 行存(`node:sqlite`)** | ✅ 采用——零第三方依赖(Node 内置,免 flag 下限 22.13/23.4;项目已在 `src/tools/base.js:88` 用它读 ZCode/QoderCN),维度即列,任何未来维度免迁移,全历史逐请求可查 |

核心链路变为:`src/tools/*.js`(采集)→ `src/workspaces.js`(工作区归一)→ **`src/store.js`(SQLite 行存)**→ SQL 聚合 → `/api/*` → `web/src/App.jsx`。

预聚合桶(`src/buckets.js`)与记录窗口(`RECORD_WINDOW_DAYS`/`RECORD_CAP`)在迁移期后退役。

## 1. Phase 1:存储层

### 1.1 工作区归一化模块(新增 `src/workspaces.js`)

与 v1 计划相同,归一化发生在**入库前**:

- `normalizeWorkspace(toolId, record) → { workspaceKey, workspaceName }`:
  - claude-code/codex/omp/dsh/qoder-cn(-cli):`project`(cwd)即 key,显示名取路径末段;
  - kimi-code:`wd_*` ID 复用 `src/sessions.js` 的 workspace 列表(`state.json workDir`)映射为真实路径,缓存 60s;映射不到退回 `wd_*` ID;
  - zcode/gemini:`__unknown__`(显示"未知工作区",UI 注明源数据无工作目录);
- **别名**:`~/.doramonitor/config.json` 新增 `workspaceAliases: { [workspaceKey]: string }`,仅展示层替换;API GET/POST `/api/workspace-aliases`。

### 1.2 SQLite 存储(新增 `src/store.js`)

数据库文件:`~/.doramonitor/doramonitor.db`(WAL 模式,`DatabaseSync`)。

```sql
-- 源文件登记:复用现有 per-file stamp 失效机制
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  tool_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL,
  folded_at INTEGER NOT NULL,
  UNIQUE(tool_id, rel_path)
);

-- 逐请求行:append-only,按文件重折叠
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  time INTEGER NOT NULL,          -- epoch ms
  day TEXT NOT NULL,              -- 本地日历日 YYYY-MM-DD(dayKey 同源)
  hour INTEGER NOT NULL,          -- 0-23,单日视图直接 GROUP BY
  device TEXT,
  account TEXT,                   -- 多账号归属(FP-01/FP-03 预留)
  workspace_key TEXT NOT NULL DEFAULT '__unknown__',
  workspace_name TEXT,
  model TEXT, model_display TEXT, model_resolved TEXT, model_provider TEXT,
  i INTEGER NOT NULL DEFAULT 0, o INTEGER NOT NULL DEFAULT 0,
  cr INTEGER NOT NULL DEFAULT 0, cc INTEGER NOT NULL DEFAULT 0,
  cs INTEGER, cl INTEGER,         -- 缓存写短/长 TTL(可为空)
  req INTEGER NOT NULL DEFAULT 1, est_req INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  price_id TEXT, cost_estimated INTEGER NOT NULL DEFAULT 0,
  session TEXT
);
CREATE INDEX idx_rec_day ON usage_records(day);
CREATE INDEX idx_rec_tool_model ON usage_records(tool, model);
CREATE INDEX idx_rec_ws ON usage_records(workspace_key, day);
CREATE INDEX idx_rec_time ON usage_records(time);

-- 事件计数(沿用现有 eventDays 语义,按文件重折叠)
CREATE TABLE event_counts (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  day TEXT NOT NULL, tool TEXT NOT NULL, event_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(file_id, day, tool, event_name)
);

-- 旧桶一次性导入的legacy聚合(无 workspace 维度 → '__legacy__')
CREATE TABLE usage_daily_legacy (
  day TEXT NOT NULL, tool TEXT NOT NULL, model TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  i INTEGER, o INTEGER, cr INTEGER, cc INTEGER, cs INTEGER, cl INTEGER,
  req INTEGER, est_req INTEGER, credits REAL,
  PRIMARY KEY(day, tool, model, rate_key)
);
```

关键设计点:

1. **增量更新**:扫描时文件 stamp(mtime+size)变化 → `DELETE WHERE file_id = ?` 后重新折叠该文件,与现有桶的失效语义一致;未变化文件零成本跳过;
2. **去重签名**:`files` 表增加 `signatures` 列(沿用桶的冷启动签名重建机制);
3. **费用不持久化**:行存只存 token 与 `price_id`/`cost_estimated`,费用查询时按当前价目计算——沿用桶层的正确设计,调价零失效;
4. **旧历史保护**:`buckets/` 中的 cell 展开导入 `usage_daily_legacy`(已删除/归档源文件的历史只存在于桶里);聚合查询 UNION 两表;迁移期把 `buckets/` 目录改名保留,提供"从桶重新导入"命令,稳定期后删除;
5. **写入性能**:逐文件事务批量 INSERT;记录写入量级(个人用量)远低于 SQLite 能力,无需额外优化。

### 1.3 聚合层改造(`src/aggregate.js`)

- `aggregateFromBuckets()` 与 raw 路径 `aggregate()` 收敛为单一 SQL 聚合 `aggregateFromStore(filter)`;**输出 shape 保持不变**(totals/daily/dailyByModel/models/recent),`/api/summary` 与前端第一期零改动;
- 输出新增:workspaces 分组、hourly(任意日期)、modelProvider 分组——R2/R3/R4 的数据供给;
- `dayKey` 必须与 SQL 中生成的 `day` 同源同时区(沿用 `localTzOffset` 语义,单机自用无跨时区漂移问题);
- `RECORD_WINDOW_DAYS`/`RECORD_CAP`/`RECENT_LIMIT` 退役:recent 直接 SQL `ORDER BY time DESC LIMIT n`。

## 2. Phase 2:API 层(`src/server.js`)

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/usage/query` | GET | 参数:`range`(today/7d/30d/90d/all/custom起止)+ `workspace` + `model` + `groupBy`(model/workspace/tool/provider);返回 totals、daily、hourly(单日)、models、workspaces、heatmap;对标 dsh 的 scope 语义 |
| `/api/usage/records` | GET | **全历史**逐请求明细:起止日期、workspace、model 过滤 + cursor/limit 分页(SQL LIMIT/OFFSET);不再有窗口限制,无 `detailAvailable` 降级 |
| `/api/workspace-aliases` | GET/POST | 别名读写 |

- 全部为本地 SQL 查询,不触发文件重扫(验收项);
- `/api/summary` 保持兼容,前端切换完成后收敛;
- CSV 导出前端用当前查询结果生成 Blob 下载,无需新端点。

## 3. Phase 3:前端(`web/src/`)

与 v1 计划一致,差异点标注:

### 3.1 R1 布局重构

- `FilterBar`(时间范围 + 工作区 + 模型 + 导出 + 扫描健康行,状态入 localStorage 与 URL query);
- `HeroCard`(总 Token 大数字 + 中文单位副行 + 请求数/费用子卡);
- 8 张 KPI 卡收敛为次级行 + 口径说明条;
- 衍生彩色卡:缓存命中率(绿)、连续使用天数(橙)。

### 3.2 R2 工作区 UI

- `WorkspaceCard`(Top N + 占比条 + "其他 N 个",点击设全局筛选)+ 工作区统计页签;
- 别名编辑 Dialog 调 `/api/workspace-aliases`。

### 3.3 R3 图表下钻

- `DailyBars.jsx` 加 click(hover 竖线定位日期,补 Enter 触发,图例点击不冒泡);`Heatmap.jsx` 每个 `<rect>` 加 `onClick`/`role="button"`/`tabIndex`;
- `DayDetailDialog`:请求单日 scope → 日汇总 + **hourly 曲线(全历史可用,SQL 按 hour GROUP BY)** + 按模型/工作区分项 + 逐请求表(全历史分页,复用最近请求表列定义);不再需要"窗口外降级"分支。

### 3.4 R4 模型明细

- `ModelDonut`(SVG 自绘,零依赖)+ 三态 Segmented(混合/按模型/按供应商,`model_resolved`/`model_provider` 两列已就位);
- `ModelDetailDialog`:该模型按日趋势 + 汇总 + **全历史**分页逐请求列表;`openModelHistory`(App.jsx:405-409)改为打开此弹层。

### 3.5 i18n

- `web/src/i18n.js` 与 `src/i18n.js` 补 zh/en(~40 条)。

## 4. Phase 4:隐私、同步与文档

- **同步载荷**:`src/sync.js` 日汇总**不携带 workspace 维度**,多设备合并仍为"无工作区"口径;`/sync` 页与 `docs/privacy.md` 注明"工作区统计仅本机";
- 别名、筛选偏好仅存本机;
- **版本要求变更**:`package.json` engines 改 `>=22.13`(22.5 首次内置 node:sqlite 但需 `--experimental-sqlite` flag,22.13/23.4 起免 flag——自用项目直接取免 flag 下限);README 环境要求同步更新;顺带收益:sqlite3 CLI 回退路径(`openCliDatabase`)在写入场景本就不可用,读取场景也可随之下线;
- 桶层退役:`buckets.js` 代码与 `DORAMONITOR_DISABLE_BUCKETS` 开关在稳定期删除,删除前保留一个迁移版本。

## 5. 测试与验收

- 单测(`node --test`):
  - workspaces.js 归一化:各工具样本 + kimi `wd_*` 映射 + unknown 时回退;
  - store.js:折叠等价性(同源文件 → 行 → SQL 聚合 ≡ 原 `aggregate()` 的 totals/daily/models,浮点容差);stamp 变更重折叠不产生重复行;
  - 旧桶导入:`usage_daily_legacy` 与原桶聚合一致;UNION 查询口径一致;
  - `/api/usage/query` 单日 hourly;records 分页与过滤;
  - 三态模型合并数值守恒(混合 = 按模型 = 按供应商);
  - 计价等价性测试(`test/bucket-pricing.test.js` 的思路迁移到行存);
- 手工验收:按需求文档三张验收清单逐项勾选;
- 性能守卫:`/api/usage/query` < 100ms(百万行级);records 首屏 < 300ms;DB 体积预算(如 ≤ 原桶体积 × 5)。

## 6. 里程碑

| 阶段 | 内容 | 依赖 | 可独立交付 |
| --- | --- | --- | --- |
| P1 | store.js + workspaces.js + 旧桶导入 + 聚合收敛 | 无 | 是(内部,summary 不变) |
| P2 | 3 个新端点 | P1 | 是 |
| P3.1 | R1 筛选条 + Hero + 布局 | P2 | 是 |
| P3.2 | R2 工作区 UI + 别名 | P2 | 是 |
| P3.3 | R3 图表下钻 + DayDetailDialog | P2 | 是 |
| P3.4 | R4 环形图 + 三态 + ModelDetailDialog | P2 | 是 |
| P4 | 隐私/同步文档 + engines 变更 + 桶退役 | P1 | 是 |

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 旧桶导入口径跳变(legacy 无 workspace) | `__legacy__` 单列 + UI 标注;提供"从桶重新导入";`buckets/` 迁移期改名保留 |
| DB 损坏 | WAL + 单文件可备份;除已删源文件部分外可全量重建;`files` 表 stamp 机制天然支持增量重放 |
| engines 收窄影响 npm 既有用户 | engines 声明 `>=22.5`(npm 仅警告不阻断);README 醒目说明;自用项目可接受 |
| codex 会话中途换 cwd | 归一化按记录级执行(非文件级),天然正确 |
| App.jsx 已 1296 行 | 筛选状态收敛为单一 reducer;按区块拆组件;`npm test` + 四页签手工冒烟 |
| kimi `wd_* → workDir` 映射在会话删除后失效 | 保留 `wd_*` 显示不丢用量;sessions.js 本就支持归档而非物理删除 |
| zcode/gemini 无 cwd | "未知工作区"明示原因,不影响其他维度 |
