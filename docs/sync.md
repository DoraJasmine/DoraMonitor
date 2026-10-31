# 多设备同步（Sync）

DoraMonitor 支持把本机用量摘要同步到 SSH 服务器、WebDAV 网盘或本地共享目录，
并拉取其他设备的摘要，在仪表盘上以"设备页签"合并展示。**同步的是聚合用量和额度
元数据，不是原始会话数据**——不包含任何提示词、代码或凭据。看板使用日粒度汇总，
等效额度测算另用一分钟 Token 桶和百分比样本。

## 1. 总览

```
设备 A (windows-pc) ──上传 A.json──▶  共享目录 .../ai-usage-monitor/
设备 B (ubuntu)     ──上传 B.json──▶        ├─ A.json
                                            └─ B.json
仪表盘（任一设备）──列举 + 下载 peers──▶ 合并展示「设备」页签
```

- 配置存于 `~/.doramonitor/config.json` 的 `sync` 段（默认关闭）。
  字段与校验见[配置与设置](./configuration.md)。
- 后端三选一：`backend: "ssh"`（默认）、`"webdav"` 或 `"local"`。
- 共享摘要目录名固定 `ai-usage-monitor`（`REMOTE_DIR`），位于各后端的配置根路径之下。
- 本地对端缓存：`~/.doramonitor/remote-cache/<设备名>.json`
  （设备名中 `[^a-zA-Z0-9_-]` 替换为 `_`）。
- 「同步」页顶部显示已保存配置、本机设备、最近成功时间、失败原因和对端设备。
  `GET /api/sync` 只返回这些状态与非敏感配置摘要；`POST /api/sync` 仍用于立即同步。
- 每次手动或后台同步都会原子更新 `~/.doramonitor/sync.state`。其中 `lastAttemptAt`
  是最近尝试，`lastSync` 是最近上传成功；失败不会抹掉上次成功时间。

## 2. 摘要格式（日汇总 + 测算元数据）

每个设备在远端就是一个 `<device>.json`：

```json
{
  "version": 2,
  "device": "windows-pc",
  "deviceId": "本机持久化的随机安装 ID",
  "generatedAt": 1761000000000,
  "updatedRange": { "start": "2026-10-01", "end": "2026-10-24" },
  "codexQuota": {
    "available": true,
    "fetchedAt": "2026-10-24T12:00:00.000Z",
    "windows": [
      { "kind": "session", "label": "5-hour", "usedPercent": 42, "resetsAt": "2026-10-24T17:00:00.000Z" },
      { "kind": "weekly", "label": "Weekly", "usedPercent": 18, "resetsAt": "2026-10-31T00:00:00.000Z" }
    ]
  },
  "days": {
    "2026-10-24": {
      "kimi-code": {
        "kimi-k3": { "i": 12000, "o": 3000, "cr": 98000, "cc": 1200, "req": 42, "credits": 0 },
        "kimi-k2.7-code": { "...": "同结构" }
      },
      "codex": { "...": "按 tool → model 两层分桶" }
    }
  }
}
```

要点：

- `SUMMARY_VERSION = 2`；`buildSummary(device, records, codexQuota)` 生成。旧 v1 摘要仍可读取。
- `deviceId` 是 `~/.doramonitor/device-id` 中持久化的随机安装 ID，用于区分同名安装；旧摘要没有该字段时仍可读取。
- `kind === "event"` 的记录（tool.call 事件）**不进摘要**。
- 桶内累加四类 token（i/o/cr/cc）、请求数、credits。
- `codexQuota` 是可选的最新 Codex 额度快照；旧版本对端会忽略该字段。
  看板在本机和所有对端中采用 `fetchedAt` 最新的快照。
- `quotaUsage` 是按 `device + 分钟 + 工具 + 模型` 聚合的四类 Token 桶，另带 `c` 字段保存
  刊例价等效人民币，保证跨设备价值口径一致；`usageWaterMark` 表示本端用量覆盖到哪个时间，
  `quotaSamples` 携带近 35 天双窗口百分比变化点和手动锚点，避免每次同步重复上传全部
  90 天原始样本；v2 同时携带 `quotaProvider` 与兼容 `provider`，读取时统一规范化；
  本机原始采样频率与历史保留不受影响。
  三者只用于等效额度测算，不改变原有日汇总口径；旧对端没有这些字段时测算会降级。

## 3. 对端记录还原（summaryToRecords）

拉取到 peer 摘要后，还原成与本地记录同形的"合成记录"参与聚合：

- 时间取**当天本地 12:00**——保证落在正确的日界内，且不影响"最近请求"列表的
  时序观感。
- `requests = b.req`：保留原始请求次数（本地记录每条算 1 次，peer 日汇总是
  N 次，聚合器会尊重记录自带的 requests 值——有测试守护）。
- **credits > 0 时 `costCny = 0`**：credits 本身就是计费量，不再估算费用；
  否则用本地价格表 `costForUsage` 正常计价。
- 记录带 `device` 与 `peer: true` 标记，用于设备页签与过滤。

## 4. SSH 后端

- 连接参数：`BatchMode=yes`（绝不交互式要密码，必须配好免密）、
  `ConnectTimeout=10`、`StrictHostKeyChecking=accept-new`；非 22 端口加 `-p`；
  `identityFile` 支持 `~` 展开。
- 上传：`ssh mkdir -p <remoteBase>` → `scp <tmp文件> <remoteBase>/<device>.json`
  （ssh 30s / scp 60s 超时；tmp 文件 `dora-sync-<pid>.json`）。
- 拉取：`ls -1 <dir>/*.json` 列出后排除自身文件，逐个 scp 下载到 mkdtemp
  （`dora-peers-*`），单个文件损坏只跳过不影响其他设备。
- **远端 HOME 解析**：`remotePath` 以 `~` 开头时，通过
  `ssh <host> printf %s $HOME` 查询**远端**的 HOME 再拼接——避免把 Windows
  本地路径（如 `C:\Users\...`）泄漏进 scp 目标。

Windows 免密配置（`scripts/install-windows.ps1` 自动做）：生成
`~/.ssh/id_ed25519`（Win32-OpenSSH 的空口令参数怪癖：`-N '""'`），公钥追加到
远端 `authorized_keys`。

## 5. WebDAV 后端

- Basic auth；15s AbortController 超时。
- 上传：`MKCOL`（201/204/405 皆视为目录已就绪）→ `PUT`（200/201/204）。
- 拉取：`PROPFIND`（200/207）→ 正则解析 `<href>` → 逐个 `GET`。
- 适合无 SSH 的场景（坚果云、Nextcloud 等 WebDAV 网盘）。

### 5.1 本地目录后端

- `backend: "local"`，`local.path` 必须是两端都能访问的**绝对路径**，实际摘要写入其下的 `ai-usage-monitor/`；
- 上传使用设备级写入锁、随机临时文件加 `rename`，读取只接收完整 `.json` 文件；单个坏文件会被隔离，异常遗留的锁一分钟后可恢复；
- 上传前检查共享目录内的 `device + deviceId`。同名但安装 ID 不同的摘要返回 `duplicate_device_name`，不覆盖、不自动合并；
- 适用于同一机器的 Windows/WSL、共享挂载盘或已同步到各机器的文件夹；它不是 P2P，也不负责让两台机器自动发现彼此；
- 共享目录不可用时沿用 `remote-cache`，不会清空已有对端数据。

## 6. 触发时机与缓存策略

| 触发方 | 行为 |
| --- | --- |
| 仪表盘「立即同步」按钮 | `POST /api/sync`：强制 collect → 上传本机摘要 → 在线拉取 peers；失败时降级 |
| 「同步」页「保存并立即同步」 | 先持久化当前表单，再执行同一 `POST /api/sync` 流程 |
| CLI daemon | 每分钟读取最新设置，按 `max(60, syncInterval)` 秒（默认 300s）执行强制 collect + runSync；修改配置无需重启 |
| `doramonitor sync` 子命令 | 手动一次性同步（未启用配置时提示并退出码 1） |
| **仪表盘普通请求** | **永不联网**——只读 `remote-cache/` 磁盘缓存（`peerRecordsCached()`），标注 `fromCache: true` |

在线拉取失败时：`runSync` 返回 `fromCache: true` 并用磁盘缓存兜底；页脚与设备
页签会体现缓存状态。

## 7. 界面呈现

- 「同步」页可设置启用状态、设备名、同步周期和 SSH/WebDAV/本地目录后端；WebDAV 密码只返回
  `hasPassword`，留空保存会保留原密码。设备名冲突和连接错误直接显示在表单中。
- 仪表盘顶部出现「设备」页签行（仅当 `sync.enabled` 且拉到 devices）：
  合并视图 / 本机 / 各 peer；选 peer 时 `/api/summary?device=<name>` 只聚合该
  设备的记录。
- 合并视图下聚合缓存 key 包含 peer 数量——peers 集合变化自动失效。
- peer 设备不可达时页签仍显示（来自缓存），数据标注为缓存态。

## 8. 安全说明

- 同步内容 = 每日 Token 汇总 + 一分钟测算 Token 桶 + 模型名 + 设备名 + 额度百分比样本。
  无提示词、代码、会话正文、凭据或文件路径；工作区目录名随 v4 `wsNames` 同步
  （2026-11-01 所有者修订：仅用于自建通道的合并视图展示）。
- SSH 走你的既有凭据体系（免密公钥）；WebDAV 密码存于本机 `config.json`
  （明文，受文件系统权限保护——与 kimi-code 自身存储凭据的方式同级）。
- Local 后端生成文件名时清洗 `deviceName`（非法字符 → `_`），并以 `deviceId` 防止同名安装互相覆盖。

## 9. 通信拓扑与 Windows/WSL

### 9.1 是否需要中转服务器

**需要共享存储，但不需要部署 DoraMonitor 中心计算服务；同机 Windows/WSL 也不需要服务器**：

- SSH 模式：使用你可访问的 SSH 服务器上的目录，上传/下载通过 SCP；
- WebDAV 模式：使用支持 WebDAV 的网盘或服务器目录；
- Local 模式：使用两端都能访问的本地或挂载目录，不开放端口，也不需要公网服务器；
- 每台设备上传自己的 `<deviceName>.json`，再下载其他设备摘要到本地 `remote-cache/`；
- 看板合并和额度估算都在本机执行，共享存储不计算用量；
- 普通看板请求不访问共享存储，只读本地缓存，因此共享存储暂时不可用不会清空已有页面。

设备之间不直接通信，不需要互相开放端口，也不是 P2P。

### 9.2 不同机器与同一机器 Windows/WSL

- 不同 Windows/Linux/macOS 机器：使用共同可访问的 SSH、WebDAV 或挂载目录；
- 同一机器 Windows 与 WSL：推荐 Local 模式，两端是独立设备身份；
- 必须为 Windows 和 WSL 配置不同的 `sync.deviceName`，例如 `desktop-win` 与 `desktop-wsl`；同名且 `deviceId` 不同会被拒绝，返回 `duplicate_device_name`；
- 不要把一端的 `~/.doramonitor/device-id` 复制到另一端，也不要把同一设备文件重复上传成两个来源。

例如 Windows 端配置：

```json
{
  "sync": {
    "enabled": true,
    "backend": "local",
    "deviceName": "desktop-win",
    "local": { "path": "D:\\DoraSync" }
  }
}
```

WSL 端指向同一个实际目录：

```json
{
  "sync": {
    "enabled": true,
    "backend": "local",
    "deviceName": "desktop-wsl",
    "local": { "path": "/mnt/d/DoraSync" }
  }
}
```

两端都会读写 `D:\DoraSync\ai-usage-monitor`，其他工具、账号和额度页面的结构不变。
