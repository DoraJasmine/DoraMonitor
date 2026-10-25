# 会话管理

会话管理是 DoraMonitor 中唯一会**修改** Kimi Code 数据的功能（归档/恢复/删除），
也是隐私要求最严格的部分（预览功能直接面对会话内容）。本文说明其全部行为与
安全设计。实现位于 `src/sessions.js`（约 710 行），HTTP 入口见
[API 参考](./api.md)第 10–14 节。

## 1. 目录模型

```
~/.kimi-code/
├─ workspaces.json                     # 工作区注册表（name、lastOpenedAt…）
├─ session_index.jsonl                  # 全局会话索引（每行一个 JSON）
└─ sessions/
   ├─ wd_<name>_<hash>/                 # 工作区目录（正则 ^wd_[A-Za-z0-9._-]+$）
   │  └─ session_<uuid>/                # 会话目录（正则 ^session_[0-9a-fA-F-]{8,}$）
   │     ├─ state.json                  # 会话元数据
   │     └─ agents/main/wire.jsonl      # wire 事件流
   └─ .kcd-archive/                     # 归档根（DoraMonitor 自建）
      └─ wd_<name>_<hash>/session_<uuid>/
```

- 归档目录名固定为 `sessions/.kcd-archive/`（`ARCHIVE_DIR`）。
- 工作区显示名：优先 `workspaces.json` 的 `info.name`，否则从
  `wd_<name>_<hash>` 中提取可读名（`humanizeWorkspace`）。

## 2. 列表（listSessions）

- 工作区集合 = 活动目录（匹配正则、跳过 `.kcd-archive`）∪ 归档目录下的工作区；
  每个工作区统计 `activeCount / archivedCount / empty`。
- 每个会话读取 `state.json`，**只取** `{title, workDir, createdAt, updatedAt,
  isCustomTitle}`——`lastPrompt` 与自定义 blob 等内容字段**从不进入内存**。
- `updatedAt` 缺失时回退目录 mtime；体积用栈遍历估算（bytes + files，
  `dirSizeApprox`）。
- 会话按 `updatedAt || createdAt` 降序；`status` 参数决定列活动还是归档
  （互斥，避免同一会话出现两次）。
- workspace 过滤参数不匹配正则 → `{error: "invalid_workspace"}`。

## 3. 归档 / 恢复 / 删除

| 操作 | 行为 |
| --- | --- |
| 归档 `archiveSession` | 活动目录 → `sessions/.kcd-archive/<wd>/<session>`；`rename` 失败（跨设备）回退 copy+delete；目标已存在抛 `exists`（HTTP 409）；随后清理全局索引 |
| 恢复 `unarchiveSession` | 反向移动；并补写 `session_index.jsonl` 最小条目 `{sessionId, sessionDir, workDir}` |
| 删除会话 `deleteSession` | **必须 `confirm: true`**；statusHint 优先定位，否则先活动后归档；整目录递归删除 + 清理索引对应行 |
| 删除空工作区 `deleteWorkspace` | 见下 |

索引清理（`scrubSessionIndex`）：逐行匹配 `"sessionId":"<id>"`（两种空格风格）
或行内包含 `/<id>"` / `\<id>"`（路径形式），命中即删行并重写文件（保留尾换行）。

**删除空工作区的三道闸门**：

1. 仍有活动或归档会话 → 拒绝（HTTP 409 `not_empty`，附计数）；
2. 目录里有**非会话残留文件**且未传 `force: true` → 拒绝（409，附 ≤10 个残留名）；
3. 通过后删除活动目录与归档目录，并更新 `workspaces.json`：从 `workspaces`
   移除该 id、加入 `deleted_workspace_ids` 数组（写失败静默忽略）。

**路径安全**：所有路径先经两个正则校验（工作区/会话 id 形状），再
`path.resolve` 后强制 `startsWith(root + sep)`，越界抛 `path_escape`（HTTP 400）。
`workspaces.json` 的删除记录（`deleted_workspace_ids`）让 Kimi Code 侧不再复活
已删工作区。

## 4. 安全文本预览（getSessionPreview）

预览从 wire.jsonl **重建**一段可读对话，但有多层限制与脱敏。

### 4.1 wire 文件候选顺序

`agents/main/wire.jsonl` → `wire.jsonl` → `agents/<任意>/wire.jsonl`。

### 4.2 重建的事件（哪些进预览、哪些不进）

| 事件 | 处理 |
| --- | --- |
| `context.append_message` | 首选用户/系统消息来源；`role === "tool"` 跳过 |
| `turn.steer` / `turn.prompt` | 仅作为用户消息的回退来源 |
| `context.append_loop_event` 内 `content.part`（`type === "text"`） | 重组 assistant 回复（按 `stepUuid` 或 `turnId:step` 分桶）；**think / tool_use 部分被隐藏** |
| `step.end` | flush 当前助手分桶 |

- 工具调用详情、工具参数、blob 附件**一概不进预览**。
- 相邻同角色且文本完全相同的消息合并去重（`turn.prompt` 与
  `append_message` 常常重复记录同一条输入）。

### 4.3 脱敏与净化

- 疑似密钥模式（`/api[_-]?key|sk-[a-zA-Z0-9]{12,}|BEGIN (RSA |OPENSSH )?PRIVATE KEY/i`）
  → 整段替换为 `[redacted: possible secret content]`。
- 文本净化：去 NUL、孤立代理对 → U+FFFD、除 `\n\t` 外的控制字符移除，
  超长截断加 `…`。

### 4.4 上限

| 限制 | 值 |
| --- | --- |
| 最大消息数 | 80（`PREVIEW_MAX_MESSAGES`） |
| 单条最大字符 | 2500（`PREVIEW_MAX_CHARS`） |
| `truncated` 触发 | 消息达 80 条，或 wire 行数 > 8000 |

### 4.5 响应形状

```json
{
  "workspaceId": "wd_...", "sessionId": "session_...", "status": "active",
  "title": "...", "workDir": "...", "createdAt": "...", "updatedAt": "...",
  "messageCount": 12, "truncated": false,
  "messages": [ { "role": "user", "time": 0, "text": "..." } ]
}
```

## 5. 与采集层联动

任何会话写操作（归档/恢复/删除/删工作区）成功后，服务端调用
`invalidateCollect()`——下次 `/api/summary` 会全量重扫，保证会话移动后用量统计
不重不漏（wire 文件的归属路径变了，但内容没变；fork 去重签名仍生效）。
