# Codex / Kimi 等效额度测算实现方案

> 实现状态（2026-10-30）：核心测算、跨客户端模型过滤、Windows/WSL 一分钟用量同步、四档
> 缓存命中率、等效人民币、稀疏样本价格弱先验、量化数据质量、手动立即测算、独立长程稳健
> 估算和最高有效纪录均已落地。每次实际重算追加到完整历史，不再限制 30 次；额度样本每
> 60 秒记录并支持变化历史查询。当前定时采样只由 Web 主进程每
> 60 秒执行，daemon 不重复采样，因此也没有实现原计划的跨进程单写者锁。Kimi 的 `accountKey`
> 暂固定为 `kimi:default`；Codex 使用 account_id 的匿名哈希。本地测算直接复用采集记录，
> peer 使用新增的一分钟同步桶，没有另建一份本地一分钟用量数据库。Kimi 上线前历史无法回补。

## 1. 背景与目标

DoraMonitor 已能展示 Codex、Kimi 的 5 小时和 7 天剩余额度，也能从多个客户端采集分模型、分 Token 类型的用量。本方案在此基础上增加被动测算能力：根据账号额度百分比的变化和同一时间段的实际用量，推测当前负载结构下的等效 Token 容量。

测算结果不是官方公布的固定 Token 上限，而是“按指定模型结构和缓存命中率折算的等效容量”。官方剩余百分比与本地测算值必须始终分开展示。

### 1.1 明确需求

1. Windows、WSL 的同一账号用量必须合并后参与测算。
2. 同一模型可能从不同客户端使用，例如 OMP 中的 GPT 用量也必须能进入 OpenAI 额度测算。
3. Kimi 提供“仅使用 Kimi Code 中的 Kimi 模型用量”开关；关闭时统计所有已采集客户端中的 Kimi 模型用量。
4. 与目标额度无关的模型必须排除，例如 Kimi Code 中的 DeepSeek 不影响 Kimi 测算，其他客户端中的非 GPT 模型不影响 Codex/GPT 测算。
5. 5 小时和 7 天额度分别展示缓存命中率为 85%、90%、95%、98% 时的等效容量估算。
6. 定期重算，保存最近 30 次有效测算和各序列的历史最高有效估算。

### 1.2 非目标

- 不主动发送模型请求来“烧额度”或校准，只使用被动产生的数据。
- 不将测算值描述为官方套餐额度、官方 Token 限额或账单。
- 不为了测算补齐会话详细记录页面；跨设备细粒度数据仅供内部计算。
- 不把 DeepSeek 等无关模型用量改名后纳入目标额度。
- 不在样本不足时生成看似精确的数字。

## 2. 调研结论

### 2.1 cpa-quota-estimator

[Autsunset/cpa-quota-estimator](https://github.com/Autsunset/cpa-quota-estimator) 与需求最接近，已经实现 Codex 5 小时、周额度容量测算、历史周期和置信度。

可复用的思想：

- 从额度增长区间计算 `区间用量 × 100 / 百分比增量`。
- 使用中位数和四分位范围降低异常区间影响。
- 区分输入、缓存读取、输出 Token，而非直接相加后视为同一种消耗。
- 多模型进阶拟合使用 Huber 稳健损失、时间衰减、逐周期容量和异常样本排除。
- 明确容量是工作负载等效值，不是官方固定 Token 数。

参考实现：[基础估算](https://github.com/Autsunset/cpa-quota-estimator/blob/main/estimator.go)、[权重学习](https://github.com/Autsunset/cpa-quota-estimator/blob/main/weight_learner.go)。

### 2.2 kimi-quota-tray

[LJF-0125/kimi-quota-tray](https://github.com/LJF-0125/kimi-quota-tray) 可借鉴 Kimi 双窗口历史采样、多机样本合并和稳健消耗速度估计。该项目同时明确提醒：本地 Token 数与额度接口的次数口径不能直接对账。

因此 Kimi 功能仍可做，但输出必须命名为“等效 Token 容量”，不能声称恢复了官方次数与 Token 的固定换算关系。

### 2.3 其他项目

[CodexBar](https://github.com/steipete/CodexBar) 等项目可借鉴额度采集和展示，但未发现可直接复用的容量反推算法。

## 3. 当前代码基础与缺口

### 3.1 已有数据

- Codex 记录包含时间、模型、未缓存输入、缓存读取、缓存写入和输出 Token：`src/providers/codex.js`。
- OMP 同样提供上述字段，并额外保留 `modelProvider`，可支持跨客户端模型归属：`src/providers/omp.js`。
- Kimi Code 的 turn 级记录包含相同的四类 Token：`src/providers/kimi-code.js`。
- Codex 可从 rollout `rate_limits` 和 `wham/usage` 获取双窗口额度。
- Kimi 可从 `api.kimi.com/coding/v1/usages` 获取双窗口额度。
- 现有同步已能合并 Windows/WSL 的日粒度 Token 总量。

### 3.2 必须补齐的缺口

1. **Codex 历史快照被压扁**：provider 每个文件只保留最新 `rate_limits`，需要在独立测算存储中保留全部快照。
2. **Kimi 没有历史采样**：只能从功能上线后开始积累，不能凭空回补。
3. **采样由页面请求驱动**：关闭页面后无法保证连续记录，需要后台定时采样。
4. **现有同步时间精度不足**：peer 摘要按“日 × 工具 × 模型”聚合，并合成到当天中午，不能关联分钟级额度变化。
5. **客户端不等于额度提供方**：必须新增模型归属判断，不能只按 `tool` 过滤。
6. **额度是账号级数据**：未采集客户端、设备同步延迟和账号切换都会影响覆盖率与置信度。

## 4. 核心设计原则

### 4.1 按额度提供方组织，而非按客户端组织

内部统一使用两个额度提供方：

- `openai`：目标为 Codex/GPT 的 5 小时和 7 天窗口。
- `kimi`：目标为 Kimi 的 5 小时和 7 天窗口。

客户端只是用量来源。典型归属如下：

| 客户端 | 模型 | 是否进入 OpenAI 测算 | 是否进入 Kimi 测算 |
| --- | --- | --- | --- |
| Codex | GPT/Codex 系列 | 是 | 否 |
| OMP | GPT 系列 | 是 | 否 |
| OMP | Kimi 系列 | 否 | 是，除非开启“仅 Kimi Code” |
| Kimi Code | Kimi 系列 | 否 | 是 |
| Kimi Code | DeepSeek | 否 | 否 |
| 任意客户端 | 无法确认归属的模型 | 否 | 否，并记录覆盖率警告 |

### 4.2 用量、额度和测算是三类独立数据

- **额度样本**：账号在某时刻报告的已用百分比。
- **细粒度用量桶**：某设备在一分钟内、某客户端和模型产生的 Token 元数据。
- **测算结果**：由有效额度增长区间和合并用量计算出的等效容量。

三者分别持久化，避免把测算值写回原始用量或官方额度快照。

### 4.3 先等待数据完整，再形成高置信度结果

跨设备同步存在延迟。远端数据尚未覆盖测算区间时，可以先显示“等待设备数据”，但不能将该结果标为高置信度或写入历史最高值。

## 5. 总体架构

```text
Codex rollout / wham usage ─┐
Kimi usages API ────────────┼→ 额度采样器 → 账号级额度样本库
                            │
Codex / OMP / Kimi Code ────┼→ 模型归属过滤 → 一分钟用量桶
Windows / WSL peer 数据 ────┘                  │
                                               ▼
                              同账号、同周期、同窗口的有效增长区间
                                               │
                                               ▼
                         稳健区间估算 + 分模型/Token 类型权重拟合
                                               │
                                               ▼
                    85% / 90% / 95% / 98% 缓存命中率容量换算
                                               │
                                               ▼
                         最近 30 次历史 + 最高有效值 + 额度卡片
```

实现上不新增运行时依赖，继续使用 Node.js 内置模块、JSON/JSONL 文件和原子写。

## 6. 数据采集与模型归属

### 6.1 新增统一模型分类器

建议新增 `src/quota-models.js`，输入已有记录，输出：

```js
{
  quotaProvider: "openai" | "kimi" | null,
  modelKey: "规范化模型名",
  reason: "matched" | "irrelevant_model" | "unknown_model"
}
```

判断优先级：

1. `modelProvider` 与可信的模型身份元数据。
2. `modelResolved` 的规范化模型家族。
3. 原始 `model` 的严格规则匹配。

要求：

- GPT/Codex 规则只匹配明确的 OpenAI 模型家族，不能用宽松的任意 substring 将自定义模型误纳入。
- Kimi 规则覆盖项目当前已解析的 Kimi 模型键和展示名。
- DeepSeek、Claude、GLM 等明确的其他模型优先排除。
- 未识别模型默认排除，同时累计 `unknownTokens`，供覆盖率诊断。
- 分类器使用纯函数并配置表驱动规则，新增模型不需要修改测算算法。

### 6.2 Kimi 用量范围开关

在现有设置中增加：

```json
{
  "quotaEstimation": {
    "kimiCodeOnly": false
  }
}
```

- `false`：所有客户端中 `quotaProvider === "kimi"` 的记录。
- `true`：仅 `tool === "kimi-code" && quotaProvider === "kimi"` 的记录。
- 两种范围使用不同的 `usageScope`：`all-clients` / `kimi-code-only`。
- 历史、最高值、样本数和置信度按 `usageScope` 分开保存，切换开关不能复用另一口径的最高值。
- 默认 `false`，因为账号级额度需要尽可能完整的用量覆盖。

OpenAI 不提供对应开关，始终使用所有已采集客户端中的 GPT 用量。

## 7. 额度样本采集

### 7.1 样本结构

```json
{
  "version": 1,
  "provider": "openai",
  "accountKey": "匿名稳定账号标识",
  "window": "session",
  "sampledAt": "2026-10-30T10:00:00.000Z",
  "usedPercent": 42,
  "resetsAt": "2026-10-30T15:00:00.000Z",
  "source": "codex-rollout"
}
```

约束：

- `provider + accountKey + window + sampledAt + source` 作为幂等键。
- `usedPercent` 保留原始数值，显示层再做取整。
- 缺少有效 `usedPercent` 的响应不写入测算样本。
- 账号标识优先使用接口或 OAuth 元数据中的稳定账号 ID，并做匿名哈希；不得保存 access token、refresh token。
- 无法获得稳定账号 ID 时使用显式的当前账号 profile；检测到账号切换时另建序列，不能混算。

### 7.2 Codex

- `src/providers/codex.js` 解析时提取全部 `rate_limits` 快照，最新快照仍走现有额度卡片逻辑。
- 新增一次性历史回补流程，直接扫描原始 rollout 并写入测算样本库；保存回补检查点，避免每次启动全量重读。
- 不为测算历史强制重建现有日聚合桶。
- `src/codex-quota.js` 每次成功获取 `wham/usage` 后，同时写入样本库。
- 原始 rollout 能回补多少历史，就以实际存在的快照为准；缺失时段不插值伪造。

### 7.3 Kimi

- `src/quota.js` 每次成功获取 usages 后，同时写入双窗口样本。
- 功能上线前的 Kimi 百分比历史不可恢复，不生成假历史。
- 如响应中有官方 used/limit 原值，可在样本中保留这些非敏感数值用于诊断，但 Token 测算仍使用统一的百分比区间算法。

### 7.4 定时调度

- 采样间隔 60 秒，沿用现有在线查询节流。
- Web 服务和 daemon 复用同一采样模块；通过同机单写者锁避免两个进程同时轮询和写凭证。
- 页面手动刷新仍可立即采样，但走相同样本入库和幂等逻辑。
- 查询失败只记录采样状态，不伪造 0% 或沿用旧时间戳制造新样本。

## 8. Windows / WSL 细粒度用量同步

### 8.1 不修改现有日摘要口径

现有 `sync.js` 日摘要继续服务看板，保证原有 token 总量、费用和设备筛选行为不变。新增独立的 `quotaUsage` 数据段，只用于额度测算。

### 8.2 一分钟用量桶

```json
{
  "version": 1,
  "device": "wsl",
  "start": "2026-10-30T10:00:00.000Z",
  "durationMs": 60000,
  "tool": "omp",
  "model": "gpt-example",
  "modelResolved": "gpt-example",
  "modelProvider": "openai",
  "inputOther": 1000,
  "inputCacheRead": 9000,
  "inputCacheCreation": 0,
  "output": 200,
  "requests": 1
}
```

- 仅保存时间和 Token 元数据，不保存提示词、回复、项目名、会话正文或凭证。
- 按 `device + start + tool + model` 幂等合并。
- 无用量的一分钟不产生空桶。
- 默认保留最近 90 天，以支持多周测算和时间衰减。
- 远端记录尚未同步时，不从日摘要反推分钟分布。

### 8.3 同步水位与完整性

每个设备额外上报 `usageWaterMark`，表示本地已完整采集到哪个时间点。

区间只有在以下条件满足后才标记为 `complete`：

- 本机数据覆盖整个区间。
- 所有活跃 peer 的同步水位均覆盖区间结束时间。
- 没有未知模型或未采集客户端造成明显缺口。

处理策略：

- peer 暂时未同步：结果标记 `pending`，等待下一次同步后重算。
- peer 长时间离线：可生成低置信度 provisional 结果，但不进入最高值。
- 额度明显增长而符合条件的 Token 为零：标记 `untracked_usage`，该区间不参与正常估算。
- 未知模型 Token 占比较高：降低置信度并展示覆盖率原因。

## 9. 有效测算区间

### 9.1 分组

额度样本先按以下键分组：

```text
provider + accountKey + window + usageScope
```

再按 `resetsAt` 和异常重置边界划分周期。OpenAI 与 Kimi、5h 与 weekly、Kimi 两种用量范围均不得混合。

### 9.2 样本筛选

一个有效区间 `(a, b]` 至少满足：

1. 两个样本属于同一账号、窗口和周期。
2. `b.usedPercent > a.usedPercent`。
3. 区间内没有已确认的重置、异常回退或长时间样本断层。
4. 能取得相同时间范围内的合并用量。
5. `Δp`、有效 Token 数和覆盖率满足最低要求。

计算：

```text
Δp = b.usedPercent - a.usedPercent
Δtokens = 区间 (a.sampledAt, b.sampledAt] 内符合归属规则的 Token
```

### 9.3 百分比跨越点

相同百分比的重复轮询不能形成新区间。优先使用每个新已用百分比的首次跨越点，避免大量重复样本把区间切得过碎并低估容量。

如果接口只上报整数百分比，则按整数里程碑；如果以后提供稳定的小数，则保留小数里程碑，但仍需设置最小 `Δp` 防止浮点噪声。

### 9.4 5 小时滚动窗口的特殊性

5h 百分比下降不一定是重置，也可能是旧消耗自然过期。因此：

- 只使用正向增长段，不将下降量当成负 Token。
- 优先短区间，长区间降权。
- 跨越长时间空闲的区间即使 `resetsAt` 未变，也标记为易受过期的影响。
- 不用 5h 的净增长反推整个周期内全部历史消耗。

7 天窗口主要按固定重置时间划周期，但账号异常重置、套餐变更仍需另起周期。

## 10. 测算算法

采用两层算法：基础区间估算提供可解释结果，分量回归支持四个缓存命中率目标。没有足够数据时回退到基础估算或样本不足状态。

### 10.1 基础区间估算

固定模型和负载结构时：

\[
\widehat Q_i = \frac{100 \times T_i}{\Delta p_i}
\]

其中：

- `T_i` 是区间内的等效或原始 Token 数。
- `Δp_i` 使用百分点，例如从 40% 到 42% 时为 2。
- `Q_i` 是满窗口等效容量。

当前剩余等效容量：

\[
R_i = \widehat Q_i \times \frac{100-usedPercent}{100}
\]

多个区间使用加权中位数，不直接平均。权重综合 `Δp`、区间时长、数据完整性和时间衰减。展示范围使用有效区间估算的四分位范围；样本过少时只显示点估计和低置信度。

### 10.2 分模型、分 Token 类型消耗模型

对每个区间构造特征：

```text
每个模型的未缓存输入、缓存读取、缓存写入、输出 Token
```

使用每百万 Token 的百分点消耗作为系数：

\[
\Delta p_i \approx
\sum_m \left(
\beta_{m,u}T_{i,m,u} +
\beta_{m,r}T_{i,m,r} +
\beta_{m,c}T_{i,m,c} +
\beta_{m,o}T_{i,m,o}
\right)
\]

- `m`：模型。
- `u/r/c/o`：未缓存输入、缓存读取、缓存写入、输出。
- `T`：以百万 Token 为单位。
- `β ≥ 0`：每百万 Token 对应的额度百分点消耗。

拟合要求：

- 使用 Huber 损失降低异常区间影响。
- 使用非负约束，禁止通过负 Token 权重解释噪声。
- 默认 21 天半衰期，让近期数据对动态额度有更大影响。
- 价格比例只能作为弱先验，不能当作官方额度权重。
- 只有某模型或 Token 类型存在足够同周期变化时，才声明该系数被独立识别。
- 数据不能区分输入与缓存权重时，使用合并系数并降低置信度，不能输出虚假的独立精度。
- 每个重算都使用原始保留样本，不能把上一次拟合结果当成新观测重复学习。

### 10.3 四个缓存命中率不是四个硬分桶

固定展示目标：

```js
const CACHE_TARGETS = [0.85, 0.90, 0.95, 0.98];
```

目标命中率是“标准负载换算点”，不是要求恰好存在 85.000% 的观测。

对每个模型，从近期有效样本取得稳健的：

- `c`：缓存写入 / 总输入。
- `o`：输出 / 总输入。

对目标缓存读取命中率 `r`：

\[
u = 1-r-c
\]

若 `r+c>1`，将 `c` 限制为 `1-r`，令 `u=0`。每一百万总输入对应的额度百分点为：

\[
P_m(r)=u\beta_{m,u}+r\beta_{m,r}+c\beta_{m,c}+o\beta_{m,o}
\]

该模型在目标命中率下的满窗口等效总 Token：

\[
Q_m(r)=\frac{100\times(1+o)\times1{,}000{,}000}{P_m(r)}
\]

这里的“总 Token”包含输入和输出；缓存读取、缓存写入、未缓存输入共同构成输入。输出占比固定为近期稳健值，避免把输出结构变化误认为缓存容量变化。

### 10.4 多模型混合

卡片默认展示一个综合值时，使用最近 7 天符合归属规则的模型输入占比作为固定模型结构，并对四个缓存目标复用同一模型结构：

\[
P_{mix}(r)=\sum_m a_mP_m(r)
\]

再按混合输出占比换算总 Token。这样 85%、90%、95%、98% 四行之间的差异来自缓存命中率，而不是每行偷偷换了一套模型组合。

详情中需说明“按近期模型结构与输出占比折算”。模型结构发生显著变化时另存一次测算历史，不直接覆盖旧结果。

### 10.5 样本不足时的回退

按以下顺序处理：

1. **可识别分量模型**：使用回归换算，标记 `measured` 或 `interpolated`。
2. **只有目标附近观测**：对同一主导模型、目标附近区间的基础容量做距离加权中位数，标记 `local`。
3. **需要超出观测范围**：可依据整体模型外推，但标记 `extrapolated` 和低置信度。
4. **无法形成可靠模型或没有有效样本**：显示“样本不足”，不返回数值。

初始局部样本带宽可使用目标值上下 2.5 个百分点，并根据有效样本数扩大；不得为了凑数把 60% 命中率样本当作 98% 的直接观测。

## 11. 置信度、异常和最高值

### 11.1 结果元数据

每个目标值至少包含：

- `sampleCount`：有效区间数。
- `percentSpan`：累计有效百分比跨度。
- `coverage`：账号用量覆盖情况。
- `method`：`measured` / `interpolated` / `local` / `extrapolated`。
- `confidence`：`high` / `medium` / `low` / `insufficient`。
- `residual`：拟合误差。
- `dataRange`：实际参与测算的时间范围。

初始置信度门槛：

- 中：至少 2 个有效区间、累计增长至少 2 个百分点，且数据完整。
- 高：至少 5 个有效区间、累计增长至少 5 个百分点，拟合残差和覆盖率均达标。
- 其他：低或样本不足。

### 11.2 异常处理

以下区间不进入正常估算：

- 跨重置或账号切换。
- 额度异常回退后立即形成的不可解释区间。
- 额度增长但符合条件用量为零。
- 失败请求导致 Token 与额度快照明显错位，且无法通过邻近快照校正。
- 未知模型或缺失设备数据占主要部分。

Codex 快照可能比 Token 记录晚一个响应。实现时允许比较 0/1/2 个事件的对齐滞后，选择整体残差最小且可重复的对齐方式，不能逐区间随意挑选最好看的值。

### 11.3 历史最高值

- 只接受 `medium` 或 `high` 且 `coverage=complete` 的结果。
- `extrapolated`、`pending`、异常恢复期结果不能刷新最高值。
- 保存最高有效点估计，不使用不确定范围上界作为最高值。
- 名称为“最高观测等效容量”，不能解释为官方套餐历史上限。
- 按 `provider + account + window + usageScope + cacheTarget` 分别保存。

## 12. 持久化与重算策略

### 12.1 建议存储

```text
~/.doramonitor/quota-estimator/
├─ samples/           # 账号额度样本，按 provider/account 分文件
├─ usage/             # 本机一分钟用量桶，按日期分文件
├─ estimates.json     # 每个序列最近 30 次有效测算
├─ maxima.json        # 各序列历史最高有效估算
└─ checkpoints.json   # Codex 回补和重算水位
```

- JSONL 追加写、JSON 临时文件加 rename 原子替换。
- 原始样本和一分钟桶保留 90 天，清理只删除过期测算数据，不碰各工具原始日志。
- 每个测算序列保留最近 30 次；最高值独立长期保存。
- 文件损坏时跳过坏行并保留其他工具数据，不能让看板整体失败。

### 12.2 测算历史结构

```json
{
  "id": "稳定测算 ID",
  "provider": "kimi",
  "accountKey": "匿名账号",
  "usageScope": "all-clients",
  "window": "session",
  "cacheTarget": 0.95,
  "createdAt": "2026-10-30T12:00:00.000Z",
  "fullWindowTokens": 100000000,
  "remainingTokens": 60000000,
  "low": 80000000,
  "high": 120000000,
  "sampleCount": 6,
  "percentSpan": 8,
  "coverage": "complete",
  "confidence": "high",
  "method": "interpolated",
  "residual": 0.12,
  "dataRange": { "start": "...", "end": "..." }
}
```

### 12.3 重算时机

- 每 6 小时检查一次；存在新的完整有效区间才重算。
- 周期结束且设备数据已同步时补算一次。
- 手动刷新额度可触发样本更新，但不必每次强制重算全部历史。
- 同步到新的 peer 用量后，将受影响的 `pending` 区间重新排队。
- 算法版本变化时提升 `algorithmVersion`，由原始样本重建测算，旧版本结果不混入新序列。

## 13. API 与前端设计

### 13.1 API

优先扩展现有 `GET /api/quota`，避免维护两套当前额度接口。

新增参数：

- `provider` 继续由现有 `tool=codex|kimi-code` 映射，暂不破坏旧客户端。
- Kimi 可选 `scope=all-clients|kimi-code-only`；缺省读取设置。

响应增加独立 `capacity` 字段，原 `windows` 保持原样：

```json
{
  "tool": "kimi-code",
  "available": true,
  "windows": [],
  "capacity": {
    "provider": "kimi",
    "usageScope": "all-clients",
    "generatedAt": "...",
    "algorithmVersion": 1,
    "targets": [
      {
        "window": "session",
        "cacheHitRate": 0.85,
        "fullWindowTokens": 80000000,
        "remainingTokens": 50000000,
        "low": 70000000,
        "high": 95000000,
        "sampleCount": 5,
        "confidence": "medium",
        "method": "interpolated",
        "coverage": "complete"
      }
    ],
    "maxima": []
  }
}
```

另加 `GET /api/quota/capacity/history`，按 provider、window、scope、cacheTarget 查询最近 30 次，避免当前额度响应携带全部历史。

设置保存继续走 `GET/POST /api/settings`，只新增 `quotaEstimation.kimiCodeOnly`，不增加一批尚未证明必要的调参项。

### 13.2 额度卡片

在 `web/src/components/QuotaCard.jsx` 保留现有官方剩余百分比和重置时间，在下面增加可展开的“等效 Token 容量（推测）”区域。

5h、7d 各自展示四行：

| 缓存命中率 | 满窗口等效容量 | 当前剩余等效容量 | 置信度 |
| --- | --- | --- | --- |
| 85% | … | … | … |
| 90% | … | … | … |
| 95% | … | … | … |
| 98% | … | … | … |

交互和状态：

- Kimi 卡片提供“全部客户端 / 仅 Kimi Code”切换，保存到设置后立即按新口径加载。
- 切换口径时显示对应说明，不把两个口径的历史混在一张列表里。
- 每行可查看样本数、估算范围、方法、数据区间和最近 30 次历史。
- 展示“最高观测等效容量”及产生时间。
- `pending` 显示“等待其他设备用量同步”。
- `insufficient` 显示“样本不足”，不显示 0 Token。
- `extrapolated` 明确标记“外推”。
- 数值旁固定显示“推测”或“等效”，防止与官方额度混淆。

## 14. 建议模块改动

| 文件/模块 | 改动 |
| --- | --- |
| `src/quota-models.js` | 新增模型到额度提供方的严格分类、未知模型诊断 |
| `src/quota-sampler.js` | 新增后台采样、单写者调度、样本入库 |
| `src/quota-estimator.js` | 有效区间、基础估算、稳健拟合、缓存目标换算、置信度 |
| `src/quota-estimator-store.js` | 样本、用量桶、最近 30 次、最高值、检查点持久化 |
| `src/providers/codex.js` | 提取全部额度快照，支持一次性历史回补 |
| `src/codex-quota.js` | 在线快照写入样本库 |
| `src/quota.js` | Kimi 在线快照写入样本库 |
| `src/sync.js` | 增加一分钟测算桶、同步水位、peer 合并，不改变现有日摘要 |
| `src/settings.js` | 校验并保存 `quotaEstimation.kimiCodeOnly` |
| `src/server.js` | 扩展 quota 响应、历史接口、后台采样生命周期 |
| `web/src/components/QuotaCard.jsx` | 四档缓存命中率容量、Kimi 范围开关、状态和历史的展示 |
| `web/src/lib/backend.js` | 新参数和历史查询的数据层函数 |
| `web/src/i18n.js` | 中英文文案 |
| `test/` | 分类、区间、算法、同步、存储、API 和回归测试 |

实施后同步更新 `docs/architecture.md`、`docs/api.md`、`docs/configuration.md`、`docs/privacy.md`，确保文档描述与新行为一致。

## 15. 测试与验收

### 15.1 单元测试

1. **模型归属**
   - OMP GPT 进入 OpenAI；OMP Kimi 进入 Kimi。
   - Kimi Code DeepSeek 被两个额度提供方同时排除。
   - 未知模型不计入且产生覆盖率诊断。
   - Kimi 开关两种模式过滤准确。

2. **额度区间**
   - 同周期递增区间正确生成。
   - 重复百分比不重复计数。
   - 跨 reset、回退、缺失、零用量增长正确排除。
   - 5h 滚动下降不被当成负 Token。

3. **容量公式**
   - 固定 Token 和百分比的手算结果精确一致。
   - 当前剩余容量按剩余百分比换算。
   - 缓存命中率升高时，在缓存权重更低的拟合中容量单调增加。
   - 85/90/95/98 使用同一模型结构和输出占比。
   - 非负权重、异常值、共线特征和样本不足行为稳定。

4. **历史与最高值**
   - 每个序列最多 30 次。
   - 低置信度、外推、pending 不刷新最高值。
   - Kimi 两种 scope、不同账号和窗口的最高值互不污染。
   - 90 天清理和损坏行容错正确。

5. **同步**
   - Windows/WSL 一分钟桶幂等合并。
   - 不改变现有日摘要总量。
   - peer 水位不足时结果为 pending，补齐后自动重算。
   - 不同客户端同模型只合并应归属的 Token，不重复计数。

### 15.2 集成验收场景

- Windows Codex 与 WSL OMP 同时使用 GPT：合并后的区间 Token 等于两端之和，DeepSeek 记录不进入结果。
- Windows Kimi Code 与 WSL OMP 同时使用 Kimi：关闭开关时合并，两端切换为仅 Kimi Code 后只保留 Windows Kimi Code 的 Kimi 记录。
- Kimi Code 同时出现 Kimi 和 DeepSeek：仅 Kimi 部分进入测算。
- 同一账号额度增长但没有任何已采集目标模型用量：区间标记 `untracked_usage`，不生成异常容量。
- 构造 85/90/95/98 附近样本：四档输出与手算一致；缺少 98% 样本时明确显示外推或样本不足。
- WSL 用量晚到：先 pending，同步后数值更新，pending 版本不进入最高值。

### 15.3 项目级验证

```bash
npm test
npm run build
```

随后使用真实 Codex/Kimi 历史被动验证，不发送额外模型请求。核对同一时间段各客户端 Token 汇总、额度区间、四档容量、历史数量和最高值是否符合手算样本。

## 16. 实施顺序

### 阶段一：数据基础

- 模型分类器与 Kimi 开关。
- Codex 全快照回补、Kimi 后台采样。
- 一分钟用量桶和 Windows/WSL 同步水位。
- 样本与用量存储及测试。

### 阶段二：可解释的基础测算

- 有效区间和异常过滤。
- 基础容量、中位数、四分位范围和置信度。
- 最近 30 次与最高有效值。
- API 和额度卡片基础展示。

### 阶段三：四档缓存命中率

- 分模型、分 Token 类型稳健拟合。
- 85/90/95/98 标准负载换算。
- 局部样本回退、外推标识、模型结构与输出占比固定。
- 真实数据验证和必要参数校正。

阶段一、二先保证数据与基础估算可信，阶段三再开放四档数值；不能把阶段三建立在不完整的账号用量上。

## 17. 风险与显示边界

1. **官方机制可能变化**：额度权重、窗口规则和模型计费会调整，因此需要时间衰减、算法版本和周期性重算。
2. **Kimi 次数与 Token 口径不同**：只能给工作负载等效结果，不能宣称获得官方固定兑换率。
3. **未采集客户端会污染结果**：额度增长但本地无对应用量时必须排除或降置信度。
4. **仅 Kimi Code 模式天然可能不完整**：若其他客户端也消耗同账号 Kimi 额度，结果通常偏低，界面需固定提示。
5. **98% 样本可能稀少**：允许外推但必须标注，不能将外推值刷新最高纪录。
6. **缓存率不是唯一变量**：模型、输出占比、长上下文和服务模式都可能影响结果，因此四档比较必须固定其他负载结构。
7. **5h 滚动过期造成非单调**：只使用正向短区间，不把滚动窗口当固定周期简单处理。
8. **跨设备延迟不可避免**：通过水位、pending 和补齐后重算处理，而不是用过期数据硬算。

## 18. 需求验收对照

| 需求 | 方案对应 |
| --- | --- |
| Windows/WSL 合并 | 一分钟用量桶、设备幂等合并、同步水位与补齐重算 |
| OMP 等不同客户端使用 GPT/Kimi | 按额度提供方和模型家族归类，不按客户端限制 |
| Kimi 仅 Kimi Code 开关 | `kimiCodeOnly` 设置，独立 `usageScope`、历史和最高值 |
| 排除 DeepSeek 等无关模型 | 严格分类器，其他及未知模型默认排除 |
| 85/90/95/98 四档展示 | 固定缓存目标、分量拟合、同一模型/输出结构换算、局部回退 |
| 定期测算、30 次历史、最高纪录 | 6 小时检查、周期结束补算、每序列 30 次、仅有效结果刷新最高值 |
