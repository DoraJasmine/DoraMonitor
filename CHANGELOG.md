# 更新日志

本文件的格式参考 Keep a Changelog；版本号遵循语义化版本。

## [1.4.2] - 2026-11-27

### 新增

- 内置价目表查缺补漏（`src/pricing.js`、`docs/pricing.md`）：
  - **OpenAI（`OPENAI_PRICES`）**：新增 `gpt-6.2-astra`（`$8/$40/$0.40`）、`gpt-6.2-sol`（`$2/$10/$0.10`）、`gpt-6.1-terra`（`$1/$5/$0.05`，修正此前被误降解至 `gpt-6.1-sol` 且标为估算的问题），补齐 `gpt-5.5`（`$5/$30`）、`gpt-5.4`/`mini`/`nano`、`gpt-5.3-codex`、`gpt-5.2`、`gpt-5-mini`/`nano`、`gpt-4.1`/`mini`、`gpt-4o`/`mini` 与 `o3`；
  - **Anthropic（`CLAUDE_PRICES`）**：新增 `claude-fable-5-2`（`$8/$40/$0.20`，5m `$10` / 1h `$16`）、`claude-fable-5-1`、`claude-sonnet-5-5`（缓存读 `$0.10`）与 `claude-haiku-5-5`（`$0.10/$0.50`，>100K 阶梯 ×5）；修复日期版本号如 `claude-fable-5-20260301` 的边界匹配；
  - **智谱 BigModel（`ZHIPU_PRICES`）**：新增 `glm-5.4`（官方按量计费开放前暂按同档 ¥8/¥28/¥2 标记估算）、`glm-5.3-flashx`（¥2/¥7/¥0.57）、`glm-5.1`、`glm-5-turbo`、`glm-4.7-flashx`、`glm-4.7`、`glm-4.6`；
  - **xAI Grok（`XAI_PRICES`）**：新增 `grok-4.7-fast`（高速档 `$4/$12/$1.00`）、`grok-4.7`（兼容 `-xhigh`/`-high`/`-medium`/`-low` 思考后缀，`$2/$6/$0.50`，≥200K ×2）、`grok-4.6`、`grok-4.3`、`grok-4.20`、`grok-4.1-fast`、`grok-build-0.1`；
  - **Cursor（`CURSOR_PRICES`）**：新增 `composer-2.5`（`$0.50/$2.50/$0.20`）与 `composer-2.5-fast`（`$3/$15/$0.50`）；
  - **Kimi / Google / Qwen / MiniMax / 扩展厂商**：补齐 `kimi-k2.8-preview`（覆盖 `K2.8-Preview-256k` / `K2.8 Preview 512k`）、`gemini-2.5-pro`、`gemini-2.5-flash`、`qwen4-max`、`qwen3.7-flash`、`minimax-m3.1-flash`、`minimax-m2.7-highspeed`、`minimax-m2.5`、`step-5-preview`、`mimo-v2.6-pro`/`flash`，并将 `hy4`/`hy4-preview` 拆出 `hy3` 单独按 `$0.834/$2.501` 计价。

### 修复

- 修复 Claude Code 缓存创建 TTL 字段解析（`src/tools/claude-code.js`）：实际 JSONL 使用 `usage.cache_creation.ephemeral_5m_input_tokens` 与 `ephemeral_1h_input_tokens`（此前只读取 `*_write_tokens`），导致全部带缓存写入的 Claude Code 记录被误判为无 TTL 分档并常驻「估算」徽标、且按两档均价多算费用。兼容旧写法并新增真机字段回归测试。
- 修正 Anthropic 1 小时缓存写入倍率（`src/pricing.js`）：对齐官方文档按 `2× input` 计费（`cacheWriteLong = input * 2`），而非此前按 `5m 写入 × 2`（即 `2.5× input`）。
- 扩展长上下文阶梯倍率配置并升级存储指纹至 `fp10:`（`src/store.js`），升级后自动刷新已持久化记录的 `price_id`、`cost_estimated` 与 TTL 拆分。

## [1.4.1] - 2026-11-27

### 修复

- 统一 Antigravity 模型统计口径（不区分思考强度）：
  - `antigravity.js` 在采集解析阶段自动剥离思考强度与角色后缀（`(XHigh)` / `(High)` / `(Medium)` / `(Low)` / `(Minimal)` / `(Thinking)` / `(Orchestrator)` 及 `Orchestrator (<模型>)` 包装，含 response id 尾部的 `-xhigh` 等后缀），与其他工具一致统一按基础模型归并，同时保留准确的计价身份（`modelResolved`）；
  - `store.js` 将 `model` / `modelDisplay` 纳入工具指纹并升级至 `fp9:`，确保已入库的历史记录在升级后首次采集即自动重入库清洗；
  - `sync.js` 对来自尚未升级对端同步缓存中的历史 Antigravity 带档位模型键同步做去后缀归一化，保证多设备「合并」视图与本机口径完全对齐；
  - `ModelInsights.jsx`、`i18n.js` 与文档移除 Antigravity 思考档位拆行特判，模型明细表恢复按计价身份统一合并展示。

## [1.4.0] - 2026-11-27

### 新增

- 新增 Cursor 用量采集：Cursor 不在本地记录 Token，采集器读取本机登录会话并调用 cursor.com 账号接口，按「天 × 模型」统计总量。仅 Windows（依赖 DPAPI 解密登录态），仅覆盖最近 31 天；无输入/输出/缓存拆分，`requests` 记为 0，同一账号的多台设备会重复计数。登录令牌只存在于采集进程内存，不落盘、不写日志。
- 新增 Google Antigravity 用量采集：直接只读（锁库时副本读取）`~/.gemini/{antigravity,antigravity-cli}/conversations/*.db` 与 WSL 发行版中的会话库，解析 protobuf `steps.metadata` / `gen_metadata.data`（含编排会话与无独立 generation 的检查点）与 `conversation_summaries.db` 工作区 URI，按 message id 跨端去重，并补充 Gemini 4 / 3.x 官方价目。

### 修复

- 自动更新链路加固（`update-check.js`、`self-update.js`、`UpdateDialog.jsx`）：
  - 源码部署将 `git status`、游离 `HEAD`/分支上游解析、`git fetch` 与分叉检测提前到停服务之前，前置校验失败时不再误杀在线服务；不再硬编码 `origin/main`；
  - 取消 `3847` 端口与 `127.0.0.1` 硬编码，从请求真实端口/绑定地址向脱离进程传入 `--port` / `--host`，修复非默认端口（如 `3848`）与自定义绑定地址健康检查必败的问题，并在无计划任务或无 systemd 单元时自动回退至 `doramonitor web/daemon --background` 重启；
  - 从磁盘读取更新后 `package.json` 解决 `require.cache` 导致目标版本号仍记录旧版本的问题；为 `npm install -g` 补全安装前缀（`--prefix`）推导以适配 `install-linux.sh`（`~/.local`）；Windows 改用 `cmd.exe /d /c` 消除 Node 24 `DEP0190` 警告并保留命令错误尾日志；
  - 全量覆盖 `running / fetching / installing / building / restarting` 进行中状态的并发锁与 10 分钟超时检测，并在 `spawnApply` 启动子进程前立即预写入初始状态消除首轮轮询竞态；
  - `update-check.js` 放宽回退超时至 10 秒，避免冷连接环境下 302 跳转回退来不及完成；`UpdateDialog` 补齐中英文阶段文案、重试进度重置与重新打开弹窗时续接进行中状态。
- 对端工作区面板（`peerWorkspaceSummaries` / `/api/usage/peer-workspaces`）：修复未按当前所选 `tool` 或时间范围（`range`）过滤对端工作区、以及工具标签错用筛选参数导致对端行统一显示为 `<设备名> · all` 的问题；`buildWsDaily` 随表携带 `c`（CNY 账本费用），选中对端工作区时四张概览卡（`today`/`7d`/`30d`/`all`）、估算费用与连续日历日 `每日趋势` 均与所选工作区保持一致；工作区面板与下拉选项统一随当前时间范围、设备与工具联动；工具标签页支持展示仅存在于对端同步中的工具。
- 多设备口径与详情弹窗一致性：`GET /api/usage/query` 在指定单个对端设备（`device=<对端设备名>`）时不再混入本机行存数据；`mergePeerUsage` 补齐 `resolved` 计价身份过滤并修正对端合并后 `cacheHitRate` 的计算口径（与 `inputCacheRead / (inputOther + inputCacheRead + inputCacheCreation)` 一致）；桶聚合路径下的 `recentFromRecords` 改为按相同日历日起点过滤 `7d`/`30d`；前端 `ModelInsights` 保留 Antigravity 思考/编排档位分开统计，修复全局模型筛选在合并/对端视图下 `估算费用` 误归零及 `App.jsx` 初始默认汇率残留 `7.2`（现统一为 `6.67`）的问题；当前视图 CSV 导出与展示模型列表保持一致。
- Antigravity 多端与路径适配：同一 Windows 宿主机上的 WSL 发行版已通过多设备同步（本地目录 / SSH / WebDAV）上报 `antigravity` 时，Windows 采集器会自动跳过 `\\wsl.localhost` 扫描以防双算；`sourceFiles` 纳入活动 `-wal` 与 `conversation_summaries.db`；Windows 盘符路径（`d:/...` → `D:\...`）在工作区归一化时统一格式；`pricing.js` 支持按 Antigravity 显示名（如 `Claude Opus 5.5 (High)`、`Claude Opus 4.6 (Thinking)`、`Orchestrator (Argon)`）直接匹配官方价目，确保各对端同步记录计价一致。

## [1.3.3] - 2026-11-05

### 修复

- 当日明细弹窗口径不一致：趋势图默认包含对端设备，但点开的明细只算本机，同一天的合计对不上。现在明细的合计、模型统计与工作区并入对端日汇总（对端仅同步到天粒度），小时分布与逐请求列表仍为本机数据并在界面明确标注；弹窗跟随顶部「设备」筛选。

### 变更

- 当日明细移除「逐请求明细」表格：该表格只覆盖本机且与上方合计口径不同，容易误读；逐请求明细保留在页面主列表（`detailLocalNote` 仍说明对端明细需在该设备查看）。

## [1.3.2] - 2026-11-05

### 新增

- Windows 启动脚本内置守护：`start-windows.bat` 先注册计划任务再从任务启动，注册不可用时自动回退到 `keep-alive.cmd` 循环守护（进程退出 5 秒后重启）；启动前先释放 3847 端口，避免旧实例占用导致 `EADDRINUSE` 重启死循环。

### 修复

- 模型匹配鲁棒性：价目表匹配改为阶梯式降级（直连 → 剥客户端路由前缀 `sn-`/`sd-`/`sv-` → 逐段剥尾部署名），模式化噪音（日期构建 `-1017`、上下文档位 `-512k`）剥离后保持官方价，未知词后缀剥离后降级为估算；版本段（`5`/`4.5`）与泛词（`model`/`router`/`default`）永不剥离——防止侵蚀到相邻模型的错误价格。
- `gfmodel`、`sn-glm-5-3-flash`、`sn-deepseek-v4-1-flash-1017` 等路由码不再落入 Kimi K2.6 兜底估算；`gfmodel` 补入计价映射（GLM-5.3-Flash），DeepSeek 与 GLM 正则补破折号代替点号的变体。
- 估算标识污染：`rateKeyFor` 在无价目行时不再标记 estimated（该判断应由查询时 `priceForCell` 派生），修复合约违背——补价目行后估算徽标永久无法清除的问题。
- 入库指纹未覆盖派生字段：`fingerprintOf` 现包含 `modelResolved`/`priceId`/`costEstimated`，修复身份映射或计价逻辑变更时指纹不变、旧数据永不重写的问题（此前只能靠手工递增 fp 版本号绕过）。
- `recostRecords` 现在同时重新解析模型身份：磁盘 bucket 缓存中旧解析的 `model_resolved` 也能修正，无需触碰源文件。
- `register-autostart.ps1` 不再静默吞掉注册失败（此前 `| Out-Null` 使其假报「已注册」，服务实际无守护）；失败时明确报错并以退出码 2 通知调用方回退。

## [1.3.1] - 2026-11-03

### 修复

- DeepSeek Flash 变体计价：上下文限制型(`deepseek-v4.1-flash-1017-512k`)与客户端路由前缀(`sn-deepseek-...`)此前落入 Kimi K2.6 兜底估算(高估约 5 倍)，现归入官方 Flash 价目行(与日期后缀 `-1017` 同一惯例)。

## [1.3.0] - 2026-11-03

### 新增

- **Kimi 额度支持 API Key 读取**:在额度详情页可配置 Kimi Code Console 生成的 API Key(`sk-kimi-...`,存储于 `settings.kimiApiKey`,多账号可用 `quotaAccounts[].apiKey` 按账号覆盖),配置后优先经 `https://api.kimi.com/coding/v1/usages` 以 Bearer Key 读取 5 小时/周额度,不再依赖 15 分钟即过期的 Kimi Code 登录凭证——在其他机器使用 Kimi 时额度照常可读;保存时立即实测并显示校验结果,已配置状态常驻徽标提示;API Key 在设置接口中打码,不回显明文。

## [1.2.3] - 2026-11-01

### 修复

- 自更新期间不再弹出命令行窗口:`windowsHide` 补齐至全部外部调用(netstat、taskkill、schtasks、git status、git diff),此前 `sh()` 内的调用已带而裸 `execFileSync` 调用遗漏,从无控制台的 detached 更新器拉起控制台程序时 Windows 会分配可见控制台;

### 变更

- 一键更新的"未提交修改"保护仅检查已跟踪文件(`--untracked-files=no`):未跟踪文件不受 ff-only merge 与 reset --hard 影响,不再阻断更新;已跟踪文件的未提交修改与远端分叉仍照常中止。

## [1.2.2] - 2026-11-01

- 更新过程不再弹出命令行窗口(`windowsHide`),对话框内以进度条展示实时进度;
- 自更新第二轮验证版本。

## [1.2.1] - 2026-11-01

- 自更新管线首个验证版本,内容与 1.2.0 相同(新增一键更新、版本探测数据源切换至 GitHub Releases)。

## [1.2.0] - 2026-11-01

### 新增

- **一键更新**:检测到新版本后,可在看板头部直接执行更新(自动识别源码部署或 npm 全局安装;停服务 → 拉取/安装 → 构建 → 重启服务,全程脱离进程执行并汇报进度);本地有未提交修改或与远端分叉时自动中止,不丢弃任何工作;
- 版本探测数据源改为 GitHub Releases API,提示点击直达发布说明页。

### 变更

- 隐私条款:新版本探测为唯一自动出站请求(只读、缓存 6 小时、可关闭),`docs/privacy.md` 已修订。

## [1.1.0] - 2026-11-01

### 新增

- 本地 SQLite 行存存储引擎（`node:sqlite`，WAL）：逐请求全历史持久化，聚合口径与既有实现等价（测试守护），旧版按日聚合桶一次性导入，源文件已删除的历史不丢失；
- 工作区维度用量统计：按工作区切片、来源机器与贡献工具标注、仅本机生效的别名（FR-10）；
- 多设备同步协议 v4：同步载荷附带工作区维度（键经共享盐 HMAC 哈希，目录名经 `wsNames` 明文同步——2026-11-01 所有者修订隐私条款，仅用于自建同步通道的合并视图展示）；
- 每日趋势与热力图点击下钻当日明细：小时分布、按模型/工作区分项、逐请求列表（FR-11）；
- 模型用量明细：按计价身份合并跨工具同名模型，逐请求分页明细（FR-12）；
- 统一筛选条（时间 × 工作区 × 模型）、Hero 总览卡、当前视图 CSV 导出；
- 新增 HTTP 端点：`GET /api/usage/query`、`GET /api/usage/records`、`GET /api/usage/peer-workspaces`、`GET/POST /api/workspace-aliases`；`/api/summary` 新增 `rangeModels`、`storeWorkspaces`、`storeEnabled` 字段；
- ZCode 用量工作区归属：采集器联接 `session` 表的工作目录，用量 100% 可归属；
- 文档：新增统一术语表 `docs/terminology.md`。

### 变更

- 运行环境要求提升至 Node.js 22.13+（`node:sqlite` 免实验标志的最低版本），不再支持 Node 18；
- `input_tokens` 口径修正：ZCode 的总输入按缓存组件拆分，缓存命中率反映真实情况；
- 全部文档完成书面语与专业术语规范化，新增统一术语表。

### 修复

- 双进程（daemon 与 web）并发写入 SQLite 时因缺少 busy_timeout 偶发静默失败的问题；
- 瞬态扫描失败（如 WAL 短暂不可读）会清空对应工具全部行存历史的问题；
- 工作区键解析对含连字符、下划线、点的 Kimi 工作区 id 失效的问题；
- 模型明细按计价身份筛选时触发 SQLite 聚合误用（`misuse of aggregate: MAX()`）的问题；
- 多设备合并视图下对端摘要的键名原型污染与数值类型校验缺失。

### 已知限制

- 多设备同步暂不携带工作区×模型交叉维度：选中对端工作区时，模型明细区展示本机同筛选数据并附提示；
- 逐请求明细仅为本机数据，对端明细请访问对应设备的看板；
- 大历史体量下，任一源文件变化会触发该工具的全量重折叠（后续版本将引入差量更新）。

## [1.0.2] 及更早

见 npm 发布历史与 Git 提交记录。
