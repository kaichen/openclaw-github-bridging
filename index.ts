#!/usr/bin/env bun
/**
 * GitHub ↔ OpenClaw Bridge Service
 *
 * Single-file implementation. Zero external dependencies.
 * Runtime: Bun (bun:sqlite, Bun.serve, Bun.spawn, native crypto, native fetch)
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx GITHUB_WEBHOOK_SECRET=xxx bun run bridge.ts
 *
 * Environment variables:
 *   GITHUB_TOKEN            - GitHub PAT with `repo` scope (for comment writeback)
 *   GITHUB_WEBHOOK_SECRET   - Shared secret configured in GitHub org webhook
 *   BRIDGE_PORT             - (optional) HTTP port, default 3847
 *   BRIDGE_DB_PATH          - (optional) SQLite file path, default ./data/bridge.sqlite
 *   BRIDGE_WEBHOOK_PATH     - (optional) Webhook endpoint path, default /webhook/github
 *   BOT_USERNAME            - (optional) GitHub bot username, default R2D2-im
 *   OPENCLAW_BIN            - (optional) openclaw binary path, default openclaw
 *   OPENCLAW_AGENT_ID       - (optional) agent name, default swe
 *   OPENCLAW_HOME           - (optional) HOME for openclaw process, default current HOME
 *   TASK_TIMEOUT_MS         - (optional) task timeout in ms, default 1800000 (30min)
 *   POLL_INTERVAL_MS        - (optional) scheduler poll interval, default 5000
 */

import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "crypto";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const config = {
  port: parseInt(process.env.BRIDGE_PORT || "3847", 10),
  dbPath: process.env.BRIDGE_DB_PATH || "./data/bridge.sqlite",
  webhookPath: process.env.BRIDGE_WEBHOOK_PATH || "/webhook/github",
  maxBodyBytes: 1_048_576, // 1 MB

  githubToken: process.env.GITHUB_TOKEN || "",
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
  botUsername: process.env.BOT_USERNAME || "R2D2-im",

  openclawBin: process.env.OPENCLAW_BIN || "openclaw",
  openclawAgentId: process.env.OPENCLAW_AGENT_ID || "swe",
  openclawHome: process.env.OPENCLAW_HOME || process.env.HOME || "",

  taskTimeoutMs: parseInt(process.env.TASK_TIMEOUT_MS || "1800000", 10),
  gracefulKillMs: 5_000,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),

  maxStdoutBytes: 102_400, // 100 KB stored in DB
};

function validateConfig() {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is required");
  if (!config.githubWebhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
}

// ─────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────

function initDb(): Database {
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(config.dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id     TEXT NOT NULL UNIQUE,
      repo_full       TEXT NOT NULL,
      resource_type   TEXT NOT NULL,
      resource_number INTEGER NOT NULL,
      trigger_type    TEXT NOT NULL,
      triggered_by    TEXT NOT NULL,
      comment_id      INTEGER,
      status          TEXT NOT NULL DEFAULT 'queued',
      exit_code       INTEGER,
      stdout          TEXT,
      result_pr_url   TEXT,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      started_at      TEXT,
      finished_at     TEXT
    )
  `);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_delivery ON tasks(delivery_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_resource ON tasks(repo_full, resource_type, resource_number)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS event_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER REFERENCES tasks(id),
      event_type TEXT NOT NULL,
      payload    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
}

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface WebhookEvent {
  deliveryId: string;
  repoFull: string;
  resourceType: "issue" | "pull_request";
  resourceNumber: number;
  triggerType: "assignment" | "mention";
  triggeredBy: string;
  commentId: number | null;
}

interface Task {
  id: number;
  delivery_id: string;
  repo_full: string;
  resource_type: string;
  resource_number: number;
  trigger_type: string;
  triggered_by: string;
  comment_id: number | null;
  status: string;
  exit_code: number | null;
  stdout: string | null;
  result_pr_url: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// ─────────────────────────────────────────────
// HMAC Verification
// ─────────────────────────────────────────────

function verifySignature(body: Buffer, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const expected = signatureHeader.replace("sha256=", "");
  const computed = createHmac("sha256", config.githubWebhookSecret)
    .update(body)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(computed, "hex"));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// Webhook Event Parsing
// ─────────────────────────────────────────────

function parseWebhookEvent(
  eventType: string,
  deliveryId: string,
  payload: any
): WebhookEvent | null {
  // issues assigned
  if (eventType === "issues" && payload.action === "assigned") {
    const assignee = payload.assignee?.login;
    if (assignee?.toLowerCase() !== config.botUsername.toLowerCase()) return null;
    return {
      deliveryId,
      repoFull: payload.repository.full_name,
      resourceType: "issue",
      resourceNumber: payload.issue.number,
      triggerType: "assignment",
      triggeredBy: payload.sender.login,
      commentId: null,
    };
  }

  // pull_request assigned
  if (eventType === "pull_request" && payload.action === "assigned") {
    const assignee = payload.assignee?.login;
    if (assignee?.toLowerCase() !== config.botUsername.toLowerCase()) return null;
    return {
      deliveryId,
      repoFull: payload.repository.full_name,
      resourceType: "pull_request",
      resourceNumber: payload.pull_request.number,
      triggerType: "assignment",
      triggeredBy: payload.sender.login,
      commentId: null,
    };
  }

  // issue_comment created (covers both issue and PR comments)
  if (eventType === "issue_comment" && payload.action === "created") {
    const body: string = payload.comment?.body || "";
    const mentionPattern = new RegExp(`@${config.botUsername}\\b`, "i");
    if (!mentionPattern.test(body)) return null;

    // Determine if this is on a PR or an issue
    const resourceType: "issue" | "pull_request" = payload.issue?.pull_request
      ? "pull_request"
      : "issue";

    return {
      deliveryId,
      repoFull: payload.repository.full_name,
      resourceType,
      resourceNumber: payload.issue.number,
      triggerType: "mention",
      triggeredBy: payload.sender.login,
      commentId: payload.comment.id,
    };
  }

  return null;
}

// ─────────────────────────────────────────────
// Dedup + Enqueue
// ─────────────────────────────────────────────

function enqueue(db: Database, event: WebhookEvent): { status: "enqueued" | "duplicate"; taskId?: number } {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO tasks
      (delivery_id, repo_full, resource_type, resource_number, trigger_type, triggered_by, comment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    event.deliveryId,
    event.repoFull,
    event.resourceType,
    event.resourceNumber,
    event.triggerType,
    event.triggeredBy,
    event.commentId,
  );

  if (result.changes === 0) return { status: "duplicate" };

  const taskId = Number(result.lastInsertRowid);

  // Log event
  db.prepare(`INSERT INTO event_log (task_id, event_type, payload) VALUES (?, ?, ?)`)
    .run(taskId, "enqueued", JSON.stringify(event));

  return { status: "enqueued", taskId };
}

function getQueuePosition(db: Database, taskId: number): number {
  const row = db.prepare(`SELECT COUNT(*) + 1 as pos FROM tasks WHERE status = 'queued' AND id < ?`)
    .get(taskId) as { pos: number };
  return row.pos;
}

// ─────────────────────────────────────────────
// GitHub Writer
// ─────────────────────────────────────────────

async function githubComment(repoFull: string, issueNumber: number, body: string): Promise<void> {
  const url = `https://api.github.com/repos/${repoFull}/issues/${issueNumber}/comments`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.githubToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ body }),
      });
      if (resp.ok) return;
      const text = await resp.text();
      log("warn", `GitHub comment attempt ${attempt + 1} failed: ${resp.status} ${text}`);
    } catch (err: any) {
      log("warn", `GitHub comment attempt ${attempt + 1} error: ${err.message}`);
    }
    // Exponential backoff: 1s, 2s, 4s
    if (attempt < 2) await Bun.sleep(1000 * Math.pow(2, attempt));
  }
  log("error", `Failed to write GitHub comment after 3 attempts: ${repoFull}#${issueNumber}`);
}

async function writeAck(task: Task, queuePos: number): Promise<void> {
  const body = [
    `🤖 Task received. Queued at position #${queuePos}.`,
    `Trigger: ${task.trigger_type} by @${task.triggered_by}`,
  ].join("\n");
  await githubComment(task.repo_full, task.resource_number, body);
}

async function writeStarted(task: Task): Promise<void> {
  const resource = task.resource_type === "pull_request" ? "PR" : "issue";
  await githubComment(
    task.repo_full,
    task.resource_number,
    `🤖 Starting work on this ${resource} now.`,
  );
}

async function writeCompleted(task: Task, prUrl: string | null, stdout: string): Promise<void> {
  const lines = stdout.split("\n").filter(Boolean);
  const summary = lines.slice(-10).join("\n");
  const parts = ["🤖 Done."];
  if (prUrl) parts.push(`PR: ${prUrl}`);
  if (summary) parts.push("", "```", summary, "```");
  await githubComment(task.repo_full, task.resource_number, parts.join("\n"));
}

async function writeFailed(task: Task, exitCode: number | null, errorMessage: string): Promise<void> {
  const parts = [
    `🤖 Task failed${exitCode !== null ? ` (exit code ${exitCode})` : ""}.`,
    "",
    `Error: ${errorMessage.slice(0, 500)}`,
    "",
    "This issue has been released from the queue. Re-assign or @mention to retry.",
  ];
  await githubComment(task.repo_full, task.resource_number, parts.join("\n"));
}

// ─────────────────────────────────────────────
// Prompt Builder
// ─────────────────────────────────────────────

function buildPrompt(task: Task): string {
  const resourceLabel = task.resource_type === "pull_request" ? "PR" : "issue";
  const viewCmd = task.resource_type === "pull_request" ? "gh pr view" : "gh issue view";

  if (task.trigger_type === "assignment") {
    return [
      `You have been assigned to ${task.repo_full}#${task.resource_number} (${resourceLabel}).`,
      `Use \`${viewCmd} ${task.resource_number} -R ${task.repo_full}\` to get the full context, then start working.`,
      `When done, create a PR (or push to the existing PR if this is a PR assignment) and report back.`,
    ].join("\n");
  }

  // mention
  const commentRef = task.comment_id ? ` (comment #${task.comment_id})` : "";
  return [
    `You were @mentioned in ${task.repo_full}#${task.resource_number} (${resourceLabel})${commentRef}.`,
    `Use \`${viewCmd} ${task.resource_number} -R ${task.repo_full} --comments\` to read all comments and understand what is being asked.`,
    `Address the request in the mention. If coding work is needed, create a PR and report back.`,
  ].join("\n");
}

// ─────────────────────────────────────────────
// OpenClaw CLI Invocation
// ─────────────────────────────────────────────

async function callOpenClaw(task: Task): Promise<{ exitCode: number; stdout: string; prUrl: string | null }> {
  const prompt = buildPrompt(task);

  const proc = Bun.spawn(
    [config.openclawBin, "agent", "--agent", config.openclawAgentId, "--message", prompt],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: config.openclawHome },
    },
  );

  let killed = false;
  const timeout = setTimeout(() => {
    killed = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, config.gracefulKillMs);
  }, config.taskTimeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (killed) {
    throw new Error(`Task timed out after ${config.taskTimeoutMs / 60000} minutes`);
  }

  if (exitCode !== 0) {
    throw new Error(`openclaw agent exited with code ${exitCode}: ${(stderr || stdout).slice(0, 2000)}`);
  }

  const prUrl = extractPrUrl(stdout);
  // Truncate stdout for DB storage
  const truncated = stdout.length > config.maxStdoutBytes
    ? stdout.slice(-config.maxStdoutBytes)
    : stdout;

  return { exitCode, stdout: truncated, prUrl };
}

function extractPrUrl(text: string): string | null {
  const match = text.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

// ─────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────

function nextTask(db: Database): Task | null {
  const task = db.prepare(
    "SELECT * FROM tasks WHERE status = 'queued' ORDER BY id ASC LIMIT 1",
  ).get() as Task | null;

  if (!task) return null;

  // Same-resource skip: if later queued tasks exist for the same resource, skip this one
  const laterCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM tasks
     WHERE status = 'queued'
       AND repo_full = ? AND resource_type = ? AND resource_number = ?
       AND id > ?`,
  ).get(task.repo_full, task.resource_type, task.resource_number, task.id) as { cnt: number };

  if (laterCount.cnt > 0) {
    db.prepare(
      "UPDATE tasks SET status = 'skipped', finished_at = datetime('now') WHERE id = ?",
    ).run(task.id);

    db.prepare(`INSERT INTO event_log (task_id, event_type, payload) VALUES (?, ?, ?)`)
      .run(task.id, "skipped", JSON.stringify({ reason: "same_resource_later_task_exists", later_count: laterCount.cnt }));

    log("info", `Skipped task #${task.id} (${task.repo_full}#${task.resource_number}) — ${laterCount.cnt} later task(s) for same resource`);
    return nextTask(db);
  }

  return task;
}

async function schedulerLoop(db: Database): Promise<void> {
  // Crash recovery: mark orphaned running tasks as failed
  const orphaned = db.prepare("UPDATE tasks SET status = 'failed', error_message = 'Bridge restarted — task was in-flight', finished_at = datetime('now') WHERE status = 'running'").run();
  if (orphaned.changes > 0) {
    log("warn", `Crash recovery: marked ${orphaned.changes} orphaned running task(s) as failed`);
  }

  log("info", "Scheduler started");

  while (true) {
    const task = nextTask(db);

    if (!task) {
      await Bun.sleep(config.pollIntervalMs);
      continue;
    }

    log("info", `Processing task #${task.id}: ${task.repo_full}#${task.resource_number} (${task.resource_type}, ${task.trigger_type})`);

    // Mark running
    db.prepare("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?").run(task.id);
    db.prepare(`INSERT INTO event_log (task_id, event_type) VALUES (?, ?)`)
      .run(task.id, "started");

    await writeStarted(task);

    try {
      const result = await callOpenClaw(task);

      db.prepare(
        "UPDATE tasks SET status = 'completed', exit_code = ?, stdout = ?, result_pr_url = ?, finished_at = datetime('now') WHERE id = ?",
      ).run(result.exitCode, result.stdout, result.prUrl, task.id);

      db.prepare(`INSERT INTO event_log (task_id, event_type, payload) VALUES (?, ?, ?)`)
        .run(task.id, "completed", JSON.stringify({ exit_code: result.exitCode, pr_url: result.prUrl }));

      await writeCompleted(task, result.prUrl, result.stdout);
      log("info", `Task #${task.id} completed${result.prUrl ? ` — PR: ${result.prUrl}` : ""}`);
    } catch (err: any) {
      db.prepare(
        "UPDATE tasks SET status = 'failed', error_message = ?, finished_at = datetime('now') WHERE id = ?",
      ).run(err.message?.slice(0, 5000) || "Unknown error", task.id);

      db.prepare(`INSERT INTO event_log (task_id, event_type, payload) VALUES (?, ?, ?)`)
        .run(task.id, "failed", JSON.stringify({ error: err.message }));

      await writeFailed(task, task.exit_code, err.message || "Unknown error");
      log("error", `Task #${task.id} failed: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────
// Dashboard HTML
// ─────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenClaw Bridge Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 8px; font-size: 1.4em; }
  .meta { color: #8b949e; font-size: 0.85em; margin-bottom: 20px; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; min-width: 100px; }
  .stat .label { font-size: 0.75em; color: #8b949e; text-transform: uppercase; }
  .stat .value { font-size: 1.5em; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
  th { background: #21262d; text-align: left; padding: 8px 12px; font-size: 0.8em; color: #8b949e; text-transform: uppercase; }
  td { padding: 8px 12px; border-top: 1px solid #21262d; font-size: 0.85em; vertical-align: top; }
  tr:hover td { background: #1c2128; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75em; font-weight: 600; }
  .badge.queued { background: #1f6feb33; color: #58a6ff; }
  .badge.running { background: #d2992233; color: #d29922; }
  .badge.completed { background: #23863633; color: #3fb950; }
  .badge.failed { background: #da363333; color: #f85149; }
  .badge.skipped { background: #8b949e33; color: #8b949e; }
  .badge.cancelled { background: #8b949e33; color: #8b949e; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .expand { cursor: pointer; color: #58a6ff; font-size: 0.8em; }
  .stdout-box { display: none; margin-top: 6px; padding: 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; font-size: 0.8em; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }
  .empty { text-align: center; padding: 40px; color: #8b949e; }
</style>
</head>
<body>
<h1>🤖 OpenClaw Bridge</h1>
<div class="meta">Auto-refreshes every 10s · <span id="updated"></span></div>
<div class="stats" id="stats"></div>
<table>
  <thead>
    <tr>
      <th>#</th><th>Resource</th><th>Type</th><th>Trigger</th><th>Status</th><th>PR</th><th>Created</th><th>Duration</th><th>Details</th>
    </tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
<script>
function dur(start, end) {
  if (!start) return '-';
  const a = new Date(start + 'Z'), b = end ? new Date(end + 'Z') : new Date();
  const s = Math.round((b - a) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
async function refresh() {
  try {
    const r = await fetch('/api/tasks');
    const d = await r.json();
    document.getElementById('updated').textContent = 'Last update: ' + new Date().toLocaleTimeString();
    const counts = {};
    d.tasks.forEach(t => { counts[t.status] = (counts[t.status]||0) + 1; });
    document.getElementById('stats').innerHTML = ['queued','running','completed','failed','skipped'].map(s =>
      '<div class="stat"><div class="label">' + s + '</div><div class="value">' + (counts[s]||0) + '</div></div>'
    ).join('');
    const tbody = document.getElementById('tbody');
    if (!d.tasks.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">No tasks yet</td></tr>'; return; }
    tbody.innerHTML = d.tasks.map(t => {
      const res = t.resource_type === 'pull_request' ? 'PR' : 'Issue';
      const link = 'https://github.com/' + t.repo_full + '/' + (t.resource_type === 'pull_request' ? 'pull' : 'issues') + '/' + t.resource_number;
      const pr = t.result_pr_url ? '<a href="' + esc(t.result_pr_url) + '" target="_blank">View</a>' : '-';
      const details = t.stdout ? '<span class="expand" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\\'block\\'?\\'none\\':\\'block\\'">stdout</span><div class="stdout-box">' + esc(t.stdout) + '</div>' : (t.error_message ? '<span title="' + esc(t.error_message) + '">⚠️</span>' : '-');
      return '<tr>' +
        '<td>' + t.id + '</td>' +
        '<td><a href="' + link + '" target="_blank">' + esc(t.repo_full) + '#' + t.resource_number + '</a></td>' +
        '<td>' + res + '</td>' +
        '<td>' + t.trigger_type + (t.triggered_by ? ' by ' + t.triggered_by : '') + '</td>' +
        '<td><span class="badge ' + t.status + '">' + t.status + '</span></td>' +
        '<td>' + pr + '</td>' +
        '<td>' + (t.created_at || '') + '</td>' +
        '<td>' + dur(t.started_at, t.finished_at) + '</td>' +
        '<td>' + details + '</td></tr>';
    }).join('');
  } catch(e) { console.error('refresh failed', e); }
}
refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

// ─────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────

function log(level: "info" | "warn" | "error", msg: string): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (level === "error") console.error(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`);
}

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────

function startServer(db: Database): void {
  Bun.serve({
    port: config.port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // ── Dashboard ──
      if (req.method === "GET" && path === "/") {
        return new Response(DASHBOARD_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── Tasks API ──
      if (req.method === "GET" && path === "/api/tasks") {
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const tasks = db.prepare(
          "SELECT * FROM tasks ORDER BY id DESC LIMIT ?",
        ).all(limit);
        return Response.json({ tasks, count: tasks.length });
      }

      // ── Health check ──
      if (req.method === "GET" && path === "/health") {
        const queuedCount = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'queued'").get() as { cnt: number }).cnt;
        const runningCount = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running'").get() as { cnt: number }).cnt;
        return Response.json({ status: "ok", queued: queuedCount, running: runningCount });
      }

      // ── Webhook ──
      if (req.method === "POST" && path === config.webhookPath) {
        return handleWebhook(req, db);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  log("info", `Bridge server listening on http://localhost:${config.port}`);
  log("info", `Webhook endpoint: ${config.webhookPath}`);
  log("info", `Dashboard: http://localhost:${config.port}/`);
}

async function handleWebhook(req: Request, db: Database): Promise<Response> {
  // Content-Type check
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return new Response("Bad Request: expected application/json", { status: 400 });
  }

  // Event header
  const eventType = req.headers.get("x-github-event");
  if (!eventType) {
    return new Response("Bad Request: missing X-GitHub-Event", { status: 400 });
  }

  // Size check
  const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
  if (contentLength > config.maxBodyBytes) {
    return new Response("Payload Too Large", { status: 413 });
  }

  // Read body
  const bodyBuffer = Buffer.from(await req.arrayBuffer());
  if (bodyBuffer.length > config.maxBodyBytes) {
    return new Response("Payload Too Large", { status: 413 });
  }

  // HMAC signature verification
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifySignature(bodyBuffer, signature)) {
    log("warn", `Webhook signature verification failed from ${req.headers.get("cf-connecting-ip") || "unknown"}`);
    return new Response("Unauthorized", { status: 401 });
  }

  // Delivery ID
  const deliveryId = req.headers.get("x-github-delivery");
  if (!deliveryId) {
    return new Response("Bad Request: missing X-GitHub-Delivery", { status: 400 });
  }

  // Event type filter
  const allowedEvents = ["issues", "pull_request", "issue_comment"];
  if (!allowedEvents.includes(eventType)) {
    return new Response("OK (ignored event)", { status: 200 });
  }

  // Parse payload
  let payload: any;
  try {
    payload = JSON.parse(bodyBuffer.toString("utf-8"));
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400 });
  }

  // Parse event
  const event = parseWebhookEvent(eventType, deliveryId, payload);
  if (!event) {
    return new Response("OK (filtered)", { status: 200 });
  }

  // Enqueue
  const result = enqueue(db, event);
  if (result.status === "duplicate") {
    log("info", `Duplicate delivery: ${deliveryId}`);
    return new Response("OK (duplicate)", { status: 200 });
  }

  log("info", `Enqueued task #${result.taskId}: ${event.repoFull}#${event.resourceNumber} (${event.resourceType}, ${event.triggerType}) by ${event.triggeredBy}`);

  // Async ack — don't block webhook response
  const taskId = result.taskId!;
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task;
  const pos = getQueuePosition(db, taskId);
  writeAck(task, pos).catch(err => log("error", `Failed to write ack: ${err.message}`));

  return new Response("Accepted", { status: 202 });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

function main() {
  validateConfig();
  const db = initDb();

  log("info", "GitHub ↔ OpenClaw Bridge starting...");
  log("info", `Bot username: ${config.botUsername}`);
  log("info", `OpenClaw agent: ${config.openclawAgentId}`);
  log("info", `Task timeout: ${config.taskTimeoutMs / 60000} minutes`);
  log("info", `DB: ${config.dbPath}`);

  startServer(db);

  // Start scheduler in background (never returns)
  schedulerLoop(db).catch(err => {
    log("error", `Scheduler crashed: ${err.message}`);
    process.exit(1);
  });
}

main();
