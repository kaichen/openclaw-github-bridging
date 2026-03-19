# GitHub ↔ OpenClaw Bridge：方案设计（v2 - CLI 路径）

前置文档：[问题定义](./github-openclaw-bridge-problem-definition.md)

## 变更记录

- v1：OpenClaw 调用走 HTTP API `POST /v1/responses`（streaming SSE）
- v2：改为 `openclaw agent` CLI 调用。理由见"选型对比"章节。
- **v3：任务单元从 issue 改为 event（每条 comment 独立成任务）。** 去重键改用 `X-GitHub-Delivery` UUID。

## 选型对比：HTTP API vs CLI vs Hooks

调研了 OpenClaw 三种外部调用方式后的结论：

| 维度 | HTTP API `/v1/responses` | CLI `openclaw agent` | Hooks `/hooks/agent` |
|------|---------------------------|------------------------|----------------------|
| 额外配置 | 需 enable endpoint | 不需要 | 需 enable hooks |
| 调用形态 | HTTP 长连接（SSE） | 子进程 spawn | HTTP 短连接 |
| 同步/异步 | 同步（连接保持到完成） | 同步（进程活到完成） | 异步（fire-and-forget） |
| 完成判断 | 解析 SSE `response.completed` | exit code 0 | 无法获知 |
| 失败判断 | 解析 SSE `response.failed` | exit code 非零 | 无法获知 |
| 获取输出 | SSE delta 累积 | stdout | 无法获取 |
| 实现复杂度 | 中（SSE 解析器） | 低（spawn + wait） | 低（但无法串行调度） |

**排除 Hooks：** 异步 fire-and-forget，Bridge 拿不到执行结果，无法判断完成/失败，直接破坏 G3（串行调度）和 G4（实时回写）。

**选择 CLI 而非 HTTP API：** 两者走的是同一个 Gateway codepath（文档原文确认）。CLI 省掉了 SSE 解析、endpoint enable 配置，完成/失败判断靠 exit code 更直接。唯一代价是丢失 streaming 中间进度，但核心需求只要求 ack + started + completed 三个节点，CLI 完全满足。

## 技术选型

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 语言/运行时 | Bun + TypeScript | 性能好，SQLite 内建 |
| 持久化 | SQLite（via `bun:sqlite`） | 零外部依赖，Bun 原生支持，单文件持久化 |
| OpenClaw 调用 | **`openclaw agent` CLI（`Bun.spawn`）** | 无需额外配置，exit code 判断完成/失败，stdout 获取输出 |
| 公网穿透 | Cloudflare Tunnel（`cloudflared`，launchctl 常驻） | 已可用 |
| GitHub 交互 | GitHub REST API v3（直接 fetch） | webhook 接收 + comment 回写 |
| 进程管理 | launchctl plist | 与 cloudflared 保持一致 |
| 监控 | 静态 HTML + SQLite 直读 | 无服务端渲染，浏览器直接看 |

## 架构总览

```
GitHub (org-level webhook)
    │
    │  HTTPS POST (X-Hub-Signature-256)
    ▼
Cloudflare Tunnel (bridge.your-domain.com/hooks)
    │
    │  HTTP → localhost:3847
    ▼
┌─────────────────────────────────────────────┐
│  Bridge Service (Bun + TS)                  │
│                                             │
│  ┌──────────┐   ┌──────────┐   ┌────────┐  │
│  │ Webhook  │──▶│  Dedup   │──▶│ SQLite │  │
│  │ Receiver │   │ + Enqueue│   │ Queue  │  │
│  └──────────┘   └──────────┘   └───┬────┘  │
│       │                            │        │
│       │ ack comment                │ poll   │
│       ▼                            ▼        │
│  ┌──────────┐              ┌────────────┐   │
│  │ GitHub   │◀─────────────│ Scheduler  │   │
│  │ Writer   │  status      │ (serial)   │   │
│  └──────────┘  updates     └─────┬──────┘   │
│                                  │          │
│                                  │ Bun.spawn│
│                                  │ openclaw │
│                                  │ agent    │
│                                  ▼          │
│                         OpenClaw Gateway    │
│                         (local daemon)      │
└─────────────────────────────────────────────┘
```

## 代码组织与逻辑模块

当前实现保持**单文件 `index.ts`** 作为唯一 canonical implementation。下面按逻辑模块描述职责边界，而不是要求当前代码已经拆成多文件。

### 1. Webhook Receiver

监听 `POST /hooks`，职责：

**签名验证：** 用 `X-Hub-Signature-256` header 和预配置的 webhook secret 做 HMAC-SHA256 验证。验证失败返回 `401`。

**事件过滤：** 处理三类 webhook 事件，其余返回 `200` 忽略。

| webhook event header | action | 触发条件 | resource_type | 提取信息 |
|---------------------|--------|---------|---------------|---------|
| `issues` | `assigned` | assignee = R2D2 | `"issue"` | repo, number, sender |
| `pull_request` | `assigned` | assignee = R2D2 | `"pull_request"` | repo, number, sender |
| `issue_comment` | `created` | body 含 @R2D2 | 由 `issue.pull_request` 字段判断 | repo, number, comment_id, sender |

**`issue_comment` 的 resource_type 判断：** GitHub 的 `issue_comment` 事件同时覆盖 issue comment 和 PR comment。payload 中 `issue.pull_request` 字段存在则为 PR，否则为 issue。

**响应：** 验证通过后立即返回 `202 Accepted`，异步处理后续逻辑。

**GitHub webhook 订阅事件（org level）：**
- `Issues`（issue assignment）
- `Pull requests`（PR assignment）
- `Issue comments`（issue 和 PR 的普通 comment @mention）

**未来扩展：** 加 `discussion_comment` 事件即可支持 Discussion。但注意 Discussion 与 issue/PR 编号空间独立，`resource_type` 字段已预留区分能力。

### 2. Dedup + Enqueue

**v3 变更：任务单元从 issue 改为 event。**

**去重键：** `X-GitHub-Delivery` UUID（GitHub 每次 webhook 投递的唯一标识，重发时复用同一 ID）

**去重方式：** `delivery_id` 字段加 UNIQUE 约束，`INSERT OR IGNORE` 天然幂等。

**去重范围：** 只防 GitHub 网络重发。同一 issue 的多条 @mention comment 各自独立入队。assign + @mention 同时到达也各自独立入队。

**入队：** 插入 SQLite `tasks` 表，状态为 `queued`。

**触发 ack：** 入队成功后，调用 GitHub Writer 在 issue 上写 comment。对于 `mention` 事件，ack 中 quote 原始 comment 的前几行，让团队知道 agent 在响应哪条指令；`assignment` 事件保持简洁 ack，不伪造 comment 引用。

```typescript
function enqueue(event: WebhookEvent): "enqueued" | "duplicate" {
  const result = db.run(
    `INSERT OR IGNORE INTO tasks
     (delivery_id, repo_full, resource_type, resource_number, trigger_type, triggered_by, comment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    event.deliveryId, event.repoFull, event.resourceType, event.resourceNumber,
    event.triggerType, event.triggeredBy, event.commentId,
  );
  if (result.changes === 0) return "duplicate";
  return "enqueued";
}
```

### 3. SQLite Schema

**设计原则：表只管调度与生命周期，不缓存 GitHub 数据。**

title、body、issue_key 等信息不存表里。理由：
- webhook 快照立刻过时，issue 可能在 agent 执行前被编辑
- agent 执行时应通过 gh CLI 拉取最新完整上下文（所有 comment、label、linked PR）
- 表的职责是队列管理，不是数据缓存

表只保留调度必需的**路由字段**（repo_full、issue_number、trigger_type、comment_id）和**结果字段**。

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id     TEXT NOT NULL UNIQUE,    -- GitHub X-GitHub-Delivery UUID（幂等键）
  repo_full       TEXT NOT NULL,           -- "consenlabs/wallet-backend"
  resource_type   TEXT NOT NULL,           -- "issue" | "pull_request" | 未来 "discussion"
  resource_number INTEGER NOT NULL,        -- issue/PR/discussion 编号
  trigger_type    TEXT NOT NULL,           -- "assignment" | "mention"
  triggered_by    TEXT NOT NULL,           -- GitHub username（用于 ack 回写）
  comment_id      INTEGER,                -- mention 事件的 comment ID（assignment 为 null）
  status          TEXT NOT NULL DEFAULT 'queued',
                                           -- queued | running | completed | failed | skipped | cancelled
  exit_code       INTEGER,                -- CLI 退出码
  stdout          TEXT,                    -- CLI stdout（截断到 100KB）
  result_pr_url   TEXT,                   -- 从 stdout 提取的 PR URL
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  finished_at     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_delivery ON tasks(delivery_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_resource ON tasks(repo_full, resource_type, resource_number);

CREATE TABLE IF NOT EXISTS event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER REFERENCES tasks(id),
  event_type TEXT NOT NULL,
  payload    TEXT,                      -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**queue_pos 动态计算：**
```sql
SELECT COUNT(*) + 1 FROM tasks WHERE status = 'queued' AND id < ?
```

**Prompt 构建策略：**

Bridge 不预构建 prompt 内容。只传路由信息给 agent，agent 自行 fetch：

| resource_type | trigger_type | agent 收到的指令 |
|--------------|-------------|-----------------|
| issue | assignment | "你被 assign 到 {repo_full}#{number}（issue），用 `gh issue view` 获取详情并开始工作" |
| issue | mention | "你在 {repo_full}#{number}（issue）的 comment #{comment_id} 中被 @mention，用 `gh issue view` 获取上下文" |
| pull_request | assignment | "你被 assign 到 {repo_full}#{number}（PR），用 `gh pr view` 获取详情并开始工作" |
| pull_request | mention | "你在 {repo_full}#{number}（PR）的 comment #{comment_id} 中被 @mention，用 `gh pr view` 获取上下文" |

### 4. Scheduler

**状态枚举：** `queued | running | completed | failed | skipped | cancelled`

**核心机制：同 resource 冗余跳过。**

当 scheduler 取到一个任务时，检查同一 resource（`repo_full + resource_type + resource_number`）后面是否还有 queued 任务。如果有，跳过当前任务标记 `skipped`，直到取到该 resource 的最后一个 queued 任务。

原因：agent 每次 fetch 最新状态，最后一个任务执行时能看到该 resource 上的全部 comment。前面的任务被"包含"了。

```
队列示例：
#1 issue-42 assignment  (queued)   ← skip（#3、#4 更新）
#2 repo-B#7 mention     (queued)   ← 正常执行
#3 issue-42 mention     (queued)   ← skip（#4 更新）
#4 issue-42 mention     (queued)   ← 实际执行（同 resource 最后一个）
#5 repo-C#9 assignment  (queued)   ← 正常执行
```

```typescript
function nextTask(): Task | null {
  const task = db.query(
    "SELECT * FROM tasks WHERE status = 'queued' ORDER BY id ASC LIMIT 1"
  ).get();

  if (!task) return null;

  // 同 resource 后面是否还有 queued 任务
  const laterCount = db.query(
    `SELECT COUNT(*) as cnt FROM tasks
     WHERE status = 'queued'
       AND repo_full = ? AND resource_type = ? AND resource_number = ?
       AND id > ?`,
    task.repo_full, task.resource_type, task.resource_number, task.id
  ).get().cnt;

  if (laterCount > 0) {
    db.run(
      "UPDATE tasks SET status = 'skipped', finished_at = datetime('now') WHERE id = ?",
      task.id
    );
    // 不写 GitHub comment，避免刷屏。入队时的 ack 已经写过了。
    return nextTask();
  }

  return task;
}

async function schedulerLoop() {
  while (true) {
    const task = nextTask();

    if (!task) {
      await Bun.sleep(5_000);
      continue;
    }

    db.run("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?", task.id);
    await githubWriter.comment(task, "started");

    try {
      const result = await callOpenClaw(task);
      db.run(
        "UPDATE tasks SET status = 'completed', exit_code = ?, stdout = ?, result_pr_url = ?, finished_at = datetime('now') WHERE id = ?",
        result.exitCode, result.stdout, result.prUrl, task.id
      );
      await githubWriter.comment(task, "completed", result);
    } catch (err) {
      db.run(
        "UPDATE tasks SET status = 'failed', error_message = ?, finished_at = datetime('now') WHERE id = ?",
        err.message, task.id
      );
      await githubWriter.comment(task, "failed", err);
    }
  }
}
```

**跳过规则细节：**
- 跳过时不写 GitHub comment（入队时已 ack），只记 event_log
- 不同 resource 之间不受影响
- 正在 running 的任务完成后，如果又有新的 queued 任务进来，正常按规则处理
- dashboard 展示 skipped 状态及原因

### 5. OpenClaw 调用（CLI）

这是 v2 与 v1 的核心差异。

```typescript
async function callOpenClaw(task: Task): Promise<TaskExecutionSuccess> {
  const prompt = buildPrompt(task);

  const proc = Bun.spawn(
    ["openclaw", "agent", "--agent", config.openclawAgentId, "--message", prompt],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: config.openclawHome },
    }
  );

  // 超时控制：30 分钟
  let killed = false;
  const timeout = setTimeout(() => {
    killed = true;
    proc.kill("SIGTERM");
    // 给 5 秒优雅退出，然后强杀
    setTimeout(() => proc.kill("SIGKILL"), 5_000);
  }, config.taskTimeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (killed) {
    throw { kind: "failed", reason: "timeout", exitCode, errorMessage: "...", stdout, stderr };
  }

  if (exitCode !== 0) {
    throw { kind: "failed", reason: "non_zero_exit", exitCode, errorMessage: "...", stdout, stderr };
  }

  const prUrl = extractPrUrl(stdout);
  return { kind: "completed", exitCode, stdout, prUrl };
}
```

**G1-G5 在 CLI 路径下的保障方式：**

**G1（事件驱动接收）：** 不受影响——这是 webhook receiver 层的事，跟 OpenClaw 调用方式无关。

**G2（持久化 FIFO 队列）：** 不受影响——队列在 SQLite 中，跟调用方式无关。

**G3（串行调度）：** `await proc.exited` 是阻塞的。Scheduler 的 while 循环在 `callOpenClaw` 返回之前不会继续，自然保证一次只跑一个任务。比 HTTP API 更直观——没有 SSE stream 要消费，进程退出即完成。

**G4（实时回写 GitHub）：** 三个关键节点都能保障：
- **ack**：webhook 入队后立即写 comment（跟调用方式无关）
- **started**：进程 spawn 前写 comment
- **completed/failed**：`proc.exited` 返回后，根据 exit code 判断成功/失败，写 comment

CLI 路径放弃的是"执行过程中的中间进度更新"——因为 agent 可能跑 20 分钟，期间 GitHub issue 上没有动态。如果未来需要这个能力，可以 pipe stdout 逐行读取，定期写 progress comment。但这是增强项，不是核心需求。

**G5（去重与幂等）：** 不受影响——去重在入队层，跟调用方式无关。

**超时控制：** `setTimeout` + `proc.kill("SIGTERM")`，给 5 秒 graceful shutdown，然后 `SIGKILL`。比 HTTP API 的 `AbortController` 更可控——直接杀进程，不存在连接挂死的问题。

**失败结果结构化：** Bridge 内部将失败区分为至少 `non_zero_exit`、`timeout`、`binary_not_found`、`spawn_error` 四类。`exit_code`、截断后的 `stdout`、`error_message` 都会落库，便于 GitHub 回写和 dashboard 排障。

**Crash recovery：** Bridge 重启时，检查 SQLite 中 `status = 'running'` 的任务。CLI 路径下，Bridge 崩溃意味着子进程也会被系统回收（父进程退出，子进程收到 SIGHUP）。所以 `running` 的任务可以安全标记为 `failed`。

**Prompt 构建：** Bridge 只传路由指令，不传 issue 内容。`--message` 的值是一句简短的路由信息（如"你被 assign 到 consenlabs/wallet-backend#42，用 gh CLI 获取详情并开始工作"），agent 自己负责 fetch 最新的 issue 上下文。

**PR URL 提取：** agent 的 stdout 是非结构化文本。用正则匹配 `https://github.com/.*/pull/\\d+` 提取 PR URL。

### 6. GitHub Writer

（与 v1 相同，无变化）

通过 GitHub REST API 在 issue/PR 上写 comment。

**四个 comment 模板：**

入队时（ack）：
```
🤖 Task received. Queued at position #{pos}.
Trigger: {assignment|mention} by @{sender}

Context:
> {mention comment excerpt...}   // 仅 mention 事件
```

开始执行时：
```
🤖 Starting work on this issue now.
```

完成时：
```
🤖 Done. PR: {pr_url}

Summary: {stdout 的最后若干行，截断到合理长度}
```

失败时：
```
🤖 Task failed (exit code {code}).

Error: {error_message}

This issue has been released from the queue. Re-assign or @mention to retry.
```

### 7. 监控 Dashboard

（与 v1 相同，无变化）

静态 HTML 文件，Bridge 提供 `GET /` 返回 HTML，`GET /api/tasks` 返回 JSON。
页面 JS 每 10 秒 fetch 刷新。每条任务可展开查看 stdout；`/api/tasks` 直接返回 `skip_reason` 和 `exit_code`，避免前端自行推断。

## Cloudflare Tunnel 配置

### cloudflared 配置文件

```yaml
# ~/.cloudflared/config.yml
tunnel: <TUNNEL_UUID>
credentials-file: ~/.cloudflared/<TUNNEL_UUID>.json

ingress:
  # 只路由 webhook 路径，dashboard 不暴露到公网
  - hostname: bridge.your-domain.com
    path: /hooks
    service: http://localhost:3847
  - service: http_status:404
```

### launchctl plist（cloudflared）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cloudflare.tunnel.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/cloudflared-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cloudflared-bridge.err</string>
</dict>
</plist>
```

### launchctl plist（Bridge Service）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.consenlabs.openclaw-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/agent/.bun/bin/bun</string>
    <string>run</string>
    <string>/Users/agent/openclaw-bridge/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/agent/openclaw-bridge</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_TOKEN</key>
    <string>__REPLACE__</string>
    <key>GITHUB_WEBHOOK_SECRET</key>
    <string>__REPLACE__</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/openclaw-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openclaw-bridge.err</string>
</dict>
</plist>
```

注意：v2 不再需要 `OPENCLAW_TOKEN` 环境变量。CLI 调用走的是 Gateway 本地 daemon，认证由 OpenClaw 自身的 credential store 处理。

## GitHub Webhook 配置

**级别：** Org level（consenlabs org）

**URL：** `https://bridge.your-domain.com/hooks`

**Content type：** `application/json`

**Secret：** 生成一个随机 secret，同时配在 GitHub 和 Bridge 的环境变量中

**Events（只勾选）：**
- `Issues`（issue assignment）
- `Pull requests`（PR assignment）
- `Issue comments`（issue 和 PR 的普通 comment @mention）

**由 Bridge 做二次过滤：** org 下所有 repo 的事件都会发过来，Bridge 在代码层面判断 assignee 或 @mention 是否是 R2D2 的 username，不是则忽略。

## 配置项总览

```typescript
// env.ts
export const config = {
  // Bridge
  port: 3847,
  dbPath: "./data/bridge.sqlite",
  webhookPath: "/hooks",
  maxBodyBytes: 1_048_576,             // 1MB payload 上限

  // GitHub
  githubToken: process.env.GITHUB_TOKEN!,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  botUsername: "R2D2-im",

  // OpenClaw CLI
  openclawBin: "openclaw",             // 或绝对路径
  openclawAgentId: "swe",
  openclawHome: "/Users/agent",        // HOME 目录，openclaw 从此读取 config

  // Scheduler
  taskTimeoutMs: 30 * 60 * 1000,       // 30 分钟超时
  gracefulKillMs: 5_000,               // SIGTERM 后等待时间
  pollIntervalMs: 5_000,               // 无任务时轮询间隔
};
```

## 当前文件结构

```
openclaw-bridge/
├── index.ts                  # 当前单文件 canonical implementation
├── design.md
├── package.json
├── tsconfig.json
├── bun.lock
└── data/                     # 运行时自动创建
    └── bridge.sqlite
```

## 错误处理策略

| 场景 | 处理 |
|------|------|
| Webhook 签名验证失败 | 返回 401，记日志，不入队 |
| GitHub API 调用失败 | 重试 3 次，exponential backoff。仍失败则只记日志，不阻塞队列 |
| OpenClaw CLI 不可执行（ENOENT） | 标记 `failed`，reason = `binary_not_found`，error_message 记录诊断信息并回写 GitHub |
| OpenClaw CLI 非零退出 | 标记 `failed`，reason = `non_zero_exit`，记录 exit code + stderr/stdout 摘要并回写 GitHub |
| OpenClaw 执行超时（30 min） | SIGTERM → 等 5 秒 → SIGKILL，标记 `failed`，reason = `timeout`，回写 GitHub |
| Bridge 崩溃重启 | launchctl KeepAlive 自动重启。启动时扫描 `status = 'running'` 的任务标记为 `failed`（子进程随父进程退出已被系统回收） |
| 重复 webhook（GitHub 重发） | 去重逻辑拦截，幂等 |
| stdout 过大 | 截断到最后 100KB 存入 SQLite，避免 DB 膨胀 |

## 安全防护

Cloudflare Tunnel 将 Bridge 的 webhook 端口暴露到公网。以下为三层纵深防护方案。

### 第一层：Cloudflare（网络层）

Tunnel 自带 DDoS 防护（免费，默认开启），在请求到达 Bridge 之前已过滤大量恶意流量。

**推荐配置：**

- **Rate Limiting：** 在 Cloudflare dashboard 对 webhook 路径设限，建议 60 req/min。GitHub org webhook 正常流量远低于此。
- **IP Access Rule：** 只允许 GitHub webhook 出口 IP 段访问。GitHub 的 hook IP 段通过 `https://api.github.com/meta` 的 `hooks` 字段获取，可定期同步到 Cloudflare IP Access Rule。
- **固定路径：** webhook URL 固定为 `/hooks`。由于不再依赖隐藏路径降低暴露面，生产环境应更依赖 Cloudflare rate limit、GitHub IP allowlist 与 HMAC 签名校验。

### 第二层：Bridge Webhook Receiver（应用层）

请求到达 Bridge 后，在解析 payload 之前逐步拦截：

```
请求到达
  │
  ├─ Content-Type != application/json？ → 400
  ├─ X-GitHub-Event header 不存在？ → 400
  ├─ Content-Length > 1MB？ → 413
  ├─ X-Hub-Signature-256 header 不存在？ → 401
  ├─ HMAC-SHA256 签名验证失败？ → 401
  │   （必须使用 crypto.timingSafeEqual 做 constant-time comparison，防止 timing attack）
  │
  └─ 通过 → 解析 payload，进入事件过滤
```

签名验证是核心防线。GitHub 用 webhook secret 对完整 request body 做 HMAC-SHA256，结果放在 `X-Hub-Signature-256` header 中（格式 `sha256=<hex>`）。Bridge 用同一个 secret 重算并比对。攻击者不知道 secret 就无法伪造有效请求。

### 第三层：入队前校验（逻辑层）

签名验证通过后，仍需在逻辑层过滤无关事件：

- `X-GitHub-Event` 不在白名单（`issues`、`pull_request`、`issue_comment`）→ 返回 200 忽略
- event action 不在白名单（`assigned`、`created`）→ 返回 200 忽略
- assignee / @mention 不是 `config.botUsername` → 返回 200 忽略
- `delivery_id` 已存在于 SQLite → 重复投递，返回 200 忽略（幂等）

### Webhook Secret 管理

secret 泄露会使签名验证失效。管理要求：

- secret 只存在两处：GitHub org webhook 配置 + M1 Max 上的 launchctl plist 环境变量
- plist 文件权限设为 `600`（`chmod 600 bridge.plist`），只有运行用户可读
- secret 不进 git、不进日志、不出现在 error message 中
- 建议定期轮换：在 GitHub 和 Bridge 同时更新。GitHub 支持同时配置两个 secret 做平滑切换

### Dashboard 访问控制

监控 dashboard（`GET /` 和 `GET /api/tasks`）不应暴露到公网。两种处理方式：

- **方案 A（推荐）：** Cloudflare Tunnel ingress 只路由 webhook 路径到 Bridge，dashboard 路径不配置路由。dashboard 只能通过 Tailscale 内网访问 `http://localhost:3847`。
- **方案 B：** dashboard 路径也通过 Tunnel 暴露，但在 Cloudflare Access 上加认证（如 email OTP 或 GitHub OAuth）。

推荐方案 A，最小暴露面。

## 前置条件

开始实现前需确认/准备：

1. 远端 M1 Max 上 `openclaw` CLI 可用且 Gateway daemon 运行中
2. `openclaw agent --agent swe --message "ping"` 能正常执行并返回
3. R2D2 GitHub account 的 PAT（需要 `repo` scope）
4. 在 consenlabs org 创建 webhook 的管理员权限
5. Cloudflare Tunnel 已创建并绑定域名
6. 远端 M1 Max 上已安装 Bun

注意：v2 不再需要单独配置 `gateway.http.endpoints.responses.enabled`，也不需要管理 Gateway token。

## OpenClaw Heartbeat 处理

实施 Bridge 后，OpenClaw 原有的 heartbeat polling 应当关闭或大幅降低频率，避免与 Bridge 重复触发。

- 第一阶段：heartbeat interval 调到 24h（等于关闭），所有任务走 Bridge
- 确认 Bridge 稳定后：彻底关闭 heartbeat channel

## 未来增强（不在 v2 scope 内）

1. **中间进度更新：** pipe stdout 逐行读取，每 N 行或每 M 分钟写一次 progress comment 到 GitHub
2. **优先级队列：** 给特定 repo 或特定 label 的 issue 加权重，调整出队顺序
3. **可控并发：** 按 repo 隔离，不同 repo 的任务可以并发（需要 OpenClaw 支持多 agent session）
4. **HTTP API 回退：** 如果未来需要 streaming 进度或更细粒度的 session 控制，可以切回 HTTP API，Scheduler 层接口不变
