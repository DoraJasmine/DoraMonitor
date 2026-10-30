# 多设备同步（Sync）

DoraMonitor 支持把本机用量摘要同步到一台中心节点（SSH 服务器或 WebDAV 网盘），
并拉取其他设备的摘要，在仪表盘上以"设备页签"合并展示。**同步的是聚合用量和额度
元数据，不是原始会话数据**——不包含任何提示词、代码或凭据。看板使用日粒度汇总，
等效额度测算另用一分钟 Token 桶和百分比样本。

## 1. 总览

```
设备 A (windows-pc) ──上传 A.json──▶  中心目录 ~/.kimi-status-sync/
设备 B (ubuntu)     ──上传 B.json──▶        ├─ A.json
                                            └─ B.json
仪表盘（任一设备）──PROPFIND/ls + 下载 peers──▶ 合并展示「设备」页签
```

- 配置存于 `~/.doramonitor/config.json` 的 `sync` 段（默认关闭）。
  字段与校验见[配置与设置](./configuration.md)。
- 后端二选一：`backend: "ssh"`（默认）或 `"webdav"`。
- 远端目录名固定 `ai-usage-monitor`（`REMOTE_DIR`），位于 `remotePath` 之下。
- 本地对端缓存：`~/.doramonitor/remote-cache/<设备名>.json`
  （设备名中 `[^a-zA-Z0-9_-]` 替换为 `_`）。

## 2. 摘要格式（日汇总 + 测算元数据）

每个设备在远端就是一个 `<device>.json`：

```json
{
  "version": 1,
  "device": "windows-pc",
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

- `SUMMARY_VERSION = 1`；`buildSummary(device, records, codexQuota)` 生成。
- `kind === "event"` 的记录（tool.call 事件）**不进摘要**。
- 桶内累加四类 token（i/o/cr/cc）、请求数、credits。
- `codexQuota` 是可选的最新 Codex 额度快照；旧版本对端会忽略该字段。
  看板在本机和所有对端中采用 `fetchedAt` 最新的快照。
- `quotaUsage` 是按 `device + 分钟 + 工具 + 模型` 聚合的四类 Token 桶，另带 `c` 字段保存
  刊例价等效人民币，保证跨设备价值口径一致；`usageWaterMark` 表示本端用量覆盖到哪个时间，
  `quotaSamples` 携带近 35 天双窗口百分比变化点和手动锚点，避免每次同步重复上传全部
  90 天原始样本；本机原始采样频率与历史保留不受影响。
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

## 6. 触发时机与缓存策略

| 触发方 | 行为 |
| --- | --- |
| 仪表盘「立即同步」按钮 | `POST /api/sync`：强制 collect → 上传本机摘要 → 在线拉取 peers；失败时降级 |
| CLI daemon | 每 `max(60, syncInterval)` 秒（默认 300s）执行一次强制 collect + runSync；成功后写 `~/.doramonitor/sync.state` |
| `doramonitor sync` 子命令 | 手动一次性同步（未启用配置时提示并退出码 1） |
| **仪表盘普通请求** | **永不联网**——只读 `remote-cache/` 磁盘缓存（`peerRecordsCached()`），标注 `fromCache: true` |

在线拉取失败时：`runSync` 返回 `fromCache: true` 并用磁盘缓存兜底；页脚与设备
页签会体现缓存状态。

## 7. 界面呈现

- 仪表盘顶部出现「设备」页签行（仅当 `sync.enabled` 且拉到 devices）：
  合并视图 / 本机 / 各 peer；选 peer 时 `/api/summary?device=<name>` 只聚合该
  设备的记录。
- 合并视图下聚合缓存 key 包含 peer 数量——peers 集合变化自动失效。
- peer 设备不可达时页签仍显示（来自缓存），数据标注为缓存态。

## 8. 安全说明

- 同步内容 = 每日 Token 汇总 + 一分钟测算 Token 桶 + 模型名 + 设备名 + 额度百分比样本。
  无提示词、代码、项目名、会话正文、凭据或文件路径。
- SSH 走你的既有凭据体系（免密公钥）；WebDAV 密码存于本机 `config.json`
  （明文，受文件系统权限保护——与 kimi-code 自身存储凭据的方式同级）。
- 上传前 `deviceName` 做清洗（非法字符 → `_`），防止路径拼接类问题。

## 9. 通信拓扑与 Windows/WSL

### 9.1 是否需要中转服务器

当前版本**需要中转存储，但不是设备直连，也不需要部署 DoraMonitor 中心计算服务**：

- SSH 模式：使用你可访问的 SSH 服务器上的目录，上传/下载通过 SCP；
- WebDAV 模式：使用支持 WebDAV 的网盘或服务器目录；
- 每台设备上传自己的 `<deviceName>.json`，再下载其他设备摘要到本地 `remote-cache/`；
- 看板合并和额度估算都在本机执行，中转载体不计算用量；
- 普通看板请求不访问中转，只读本地缓存，因此中转暂时不可用不会清空已有页面。

设备之间不直接通信，不需要互相开放端口，也不是 P2P。

### 9.2 不同机器与同一机器 Windows/WSL

- 不同 Windows/Linux/macOS 机器：双方都能访问同一 SSH 或 WebDAV 中转目录即可；
- 同一机器 Windows 与 WSL：同样可以使用上述中转，但两端是独立设备身份；
- 必须为 Windows 和 WSL 配置不同的 `sync.deviceName`，例如 `desktop-win` 与 `desktop-wsl`；若都使用相同 hostname，会争用并覆盖同一个远端 `<deviceName>.json`；
- 两端还应使用各自实际产生的数据与独立 local/peer 视角，不能把同一设备文件重复上传成两个来源。

未来计划的本地目录传输和账号隔离增强见[未来功能计划](./future-roadmap.md)。
