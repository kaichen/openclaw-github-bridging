#!/usr/bin/env bun
/**
 * GitHub ↔ OpenClaw Bridge Service
 *
 * Single-file implementation. Zero external dependencies.
 * Runtime: Bun (bun:sqlite, Bun.serve, Bun.spawn, native crypto, native fetch)
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx GITHUB_WEBHOOK_SECRET=xxx bun run index.ts
 *   bun run index.ts --config ./config.json
 *   bun run index.ts ./config.json
 *
 * Environment variables:
 *   GITHUB_TOKEN            - GitHub PAT with `repo` scope (for comment writeback)
 *   GITHUB_WEBHOOK_SECRET   - Shared secret configured in GitHub org webhook
  *   BRIDGE_PORT             - (optional) HTTP port, default 3847
 *   BRIDGE_DB_PATH          - (optional) SQLite file path, default ./data/bridge.sqlite
 *   BRIDGE_WEBHOOK_PATH     - (optional) Webhook endpoint path, default /hooks
 *   BRIDGE_MAX_BODY_BYTES   - (optional) Max webhook payload bytes, default 1048576
 *   GITHUB_API_BASE_URL     - (optional) GitHub API base URL, default https://api.github.com
 *   BOT_USERNAME            - (optional) GitHub bot username, default R2D2-im
 *   OPENCLAW_BIN            - (optional) openclaw binary path, default openclaw
 *   OPENCLAW_AGENT_ID       - (optional) agent name, default swe
  *   OPENCLAW_HOME           - (optional) HOME for openclaw process, default current HOME
  *   TASK_TIMEOUT_MS         - (optional) task timeout in ms, default 1800000 (30min)
 *   GRACEFUL_KILL_MS        - (optional) grace period after SIGTERM, default 5000
 *   POLL_INTERVAL_MS        - (optional) scheduler poll interval, default 5000
 *   MAX_STDOUT_BYTES        - (optional) stdout bytes stored per task, default 102400
 */

import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "crypto";
import { mkdirSync, existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

interface FileConfig {
  port?: number;
  dbPath?: string;
  webhookPath?: string;
  maxBodyBytes?: number;
  githubApiBaseUrl?: string;
  githubToken?: string;
  githubWebhookSecret?: string;
  botUsername?: string;
  openclawBin?: string;
  openclawAgentId?: string;
  openclawHome?: string;
  taskTimeoutMs?: number;
  gracefulKillMs?: number;
  pollIntervalMs?: number;
  maxStdoutBytes?: number;
}

interface AppConfig {
  port: number;
  dbPath: string;
  webhookPath: string;
  maxBodyBytes: number;
  githubApiBaseUrl: string;
  githubToken: string;
  githubWebhookSecret: string;
  botUsername: string;
  openclawBin: string;
  openclawAgentId: string;
  openclawHome: string;
  taskTimeoutMs: number;
  gracefulKillMs: number;
  pollIntervalMs: number;
  maxStdoutBytes: number;
  configSource: string;
}

const FILE_CONFIG_KEYS = new Set<keyof FileConfig>([
  "port",
  "dbPath",
  "webhookPath",
  "maxBodyBytes",
  "githubApiBaseUrl",
  "githubToken",
  "githubWebhookSecret",
  "botUsername",
  "openclawBin",
  "openclawAgentId",
  "openclawHome",
  "taskTimeoutMs",
  "gracefulKillMs",
  "pollIntervalMs",
  "maxStdoutBytes",
]);

const config = loadConfig(Bun.argv, process.env);

function loadConfig(argv: string[], env: NodeJS.ProcessEnv): AppConfig {
  const cli = parseCliArgs(argv.slice(2));
  const fileConfig = cli.configPath ? readConfigFile(cli.configPath) : {};
  const appConfig: AppConfig = {
    port: readNumberConfig("port", fileConfig.port, env.BRIDGE_PORT, 3847),
    dbPath: readStringConfig("dbPath", fileConfig.dbPath, env.BRIDGE_DB_PATH, "./data/bridge.sqlite"),
    webhookPath: readStringConfig("webhookPath", fileConfig.webhookPath, env.BRIDGE_WEBHOOK_PATH, "/hooks"),
    maxBodyBytes: readNumberConfig("maxBodyBytes", fileConfig.maxBodyBytes, env.BRIDGE_MAX_BODY_BYTES, 1_048_576),
    githubApiBaseUrl: readStringConfig("githubApiBaseUrl", fileConfig.githubApiBaseUrl, env.GITHUB_API_BASE_URL, "https://api.github.com"),
    githubToken: readStringConfig("githubToken", fileConfig.githubToken, env.GITHUB_TOKEN, ""),
    githubWebhookSecret: readStringConfig("githubWebhookSecret", fileConfig.githubWebhookSecret, env.GITHUB_WEBHOOK_SECRET, ""),
    botUsername: readStringConfig("botUsername", fileConfig.botUsername, env.BOT_USERNAME, "R2D2-im"),
    openclawBin: readStringConfig("openclawBin", fileConfig.openclawBin, env.OPENCLAW_BIN, "openclaw"),
    openclawAgentId: readStringConfig("openclawAgentId", fileConfig.openclawAgentId, env.OPENCLAW_AGENT_ID, "swe"),
    openclawHome: readStringConfig("openclawHome", fileConfig.openclawHome, env.OPENCLAW_HOME ?? env.HOME, ""),
    taskTimeoutMs: readNumberConfig("taskTimeoutMs", fileConfig.taskTimeoutMs, env.TASK_TIMEOUT_MS, 1_800_000),
    gracefulKillMs: readNumberConfig("gracefulKillMs", fileConfig.gracefulKillMs, env.GRACEFUL_KILL_MS, 5_000),
    pollIntervalMs: readNumberConfig("pollIntervalMs", fileConfig.pollIntervalMs, env.POLL_INTERVAL_MS, 5_000),
    maxStdoutBytes: readNumberConfig("maxStdoutBytes", fileConfig.maxStdoutBytes, env.MAX_STDOUT_BYTES, 102_400),
    configSource: cli.configPath ? `json:${resolve(cli.configPath)}` : "env",
  };

  validateConfig(appConfig);
  return appConfig;
}

function parseCliArgs(args: string[]): { configPath: string | null } {
  let configPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--config") {
      const next = args[index + 1];
      if (!next) throw new Error("--config requires a path");
      if (configPath) throw new Error("config path specified more than once");
      configPath = next;
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      if (configPath) throw new Error("config path specified more than once");
      const inlinePath = arg.slice("--config=".length);
      if (!inlinePath) throw new Error("--config requires a path");
      configPath = inlinePath;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (configPath) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    configPath = arg;
  }

  return { configPath };
}

function readConfigFile(path: string): FileConfig {
  const resolvedPath = resolve(path);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf-8"));
  } catch (err: any) {
    throw new Error(`Failed to read config file ${resolvedPath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${resolvedPath} must contain a JSON object`);
  }

  for (const key of Object.keys(parsed)) {
    if (!FILE_CONFIG_KEYS.has(key as keyof FileConfig)) {
      throw new Error(`Unsupported config key in ${resolvedPath}: ${key}`);
    }
  }

  return parsed as FileConfig;
}

function readStringConfig(
  name: string,
  fileValue: unknown,
  envValue: string | undefined,
  defaultValue: string,
): string {
  if (fileValue !== undefined) {
    if (typeof fileValue !== "string") {
      throw new Error(`Config field "${name}" must be a string`);
    }
    return fileValue;
  }

  if (envValue !== undefined) return envValue;
  return defaultValue;
}

function readNumberConfig(
  name: string,
  fileValue: unknown,
  envValue: string | undefined,
  defaultValue: number,
): number {
  if (fileValue !== undefined) {
    if (typeof fileValue !== "number" || !Number.isFinite(fileValue)) {
      throw new Error(`Config field "${name}" must be a finite number`);
    }
    return fileValue;
  }

  if (envValue !== undefined) {
    const parsed = Number(envValue);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Environment variable for "${name}" must be a finite number`);
    }
    return parsed;
  }

  return defaultValue;
}

function validateConfig(config: AppConfig) {
  if (!config.githubToken) throw new Error("githubToken/GITHUB_TOKEN is required");
  if (!config.githubWebhookSecret) throw new Error("githubWebhookSecret/GITHUB_WEBHOOK_SECRET is required");
  if (!/^https?:\/\//.test(config.githubApiBaseUrl)) {
    throw new Error("githubApiBaseUrl must start with http:// or https://");
  }
  if (!config.webhookPath.startsWith("/")) throw new Error('webhookPath must start with "/"');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }

  for (const [name, value] of [
    ["maxBodyBytes", config.maxBodyBytes],
    ["taskTimeoutMs", config.taskTimeoutMs],
    ["gracefulKillMs", config.gracefulKillMs],
    ["pollIntervalMs", config.pollIntervalMs],
    ["maxStdoutBytes", config.maxStdoutBytes],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
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

interface AckContext {
  commentExcerpt: string | null;
}

interface TaskExecutionSuccess {
  kind: "completed";
  exitCode: number;
  stdout: string;
  prUrl: string | null;
}

interface TaskExecutionFailure {
  kind: "failed";
  reason: "non_zero_exit" | "timeout" | "binary_not_found" | "spawn_error";
  exitCode: number | null;
  errorMessage: string;
  stdout: string | null;
  stderr: string | null;
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

function buildCommentExcerpt(text: string | null | undefined): string | null {
  if (!text) return null;

  const excerpt = text
    .split("\n")
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, 3)
    .map(line => line.slice(0, 120))
    .join("\n");

  return excerpt || null;
}

function extractAckContext(event: WebhookEvent, payload: any): AckContext {
  if (event.triggerType !== "mention") {
    return { commentExcerpt: null };
  }

  return {
    commentExcerpt: buildCommentExcerpt(payload.comment?.body),
  };
}

// ─────────────────────────────────────────────
// GitHub Writer
// ─────────────────────────────────────────────

async function githubComment(repoFull: string, issueNumber: number, body: string): Promise<void> {
  const baseUrl = config.githubApiBaseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/repos/${repoFull}/issues/${issueNumber}/comments`;
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

async function writeAck(task: Task, queuePos: number, ack: AckContext): Promise<void> {
  const body = [
    `🤖 Task received. Queued at position #${queuePos}.`,
    `Trigger: ${task.trigger_type} by @${task.triggered_by}`,
  ];

  if (ack.commentExcerpt) {
    body.push("", "Context:", `> ${ack.commentExcerpt.replace(/\n/g, "\n> ")}`);
  }

  await githubComment(task.repo_full, task.resource_number, body.join("\n"));
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

async function callOpenClaw(task: Task): Promise<TaskExecutionSuccess> {
  const prompt = buildPrompt(task);

  let proc;
  try {
    proc = Bun.spawn(
      [config.openclawBin, "agent", "--agent", config.openclawAgentId, "--message", prompt],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: config.openclawHome },
      },
    );
  } catch (err: any) {
    throw buildSpawnFailure(err);
  }

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
  const truncatedStdout = truncateText(stdout, config.maxStdoutBytes);
  const truncatedStderr = truncateText(stderr, 4000);

  if (killed) {
    throw {
      kind: "failed",
      reason: "timeout",
      exitCode: exitCode ?? null,
      errorMessage: `Task timed out after ${config.taskTimeoutMs / 60000} minutes`,
      stdout: truncatedStdout || null,
      stderr: truncatedStderr || null,
    } satisfies TaskExecutionFailure;
  }

  if (exitCode !== 0) {
    const reason = inferFailureReason(exitCode, stderr || stdout);
    const detail = truncateText(stderr || stdout, 2000) || "Process exited without output";
    throw {
      kind: "failed",
      reason,
      exitCode,
      errorMessage: `openclaw agent exited with code ${exitCode}: ${detail}`,
      stdout: truncatedStdout || null,
      stderr: truncatedStderr || null,
    } satisfies TaskExecutionFailure;
  }

  const prUrl = extractPrUrl(stdout);
  return { kind: "completed", exitCode, stdout: truncatedStdout, prUrl };
}

function extractPrUrl(text: string): string | null {
  const match = text.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

function truncateText(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  return text.slice(-maxBytes);
}

function inferFailureReason(exitCode: number, output: string): TaskExecutionFailure["reason"] {
  const normalized = output.toLowerCase();
  if (exitCode === 127 || normalized.includes("enoent") || normalized.includes("not found")) {
    return "binary_not_found";
  }
  return "non_zero_exit";
}

function buildSpawnFailure(err: any): TaskExecutionFailure {
  const raw = String(err?.message || err || "Unknown spawn error");
  const normalized = raw.toLowerCase();
  const reason = normalized.includes("enoent") || normalized.includes("not found")
    ? "binary_not_found"
    : "spawn_error";

  return {
    kind: "failed",
    reason,
    exitCode: null,
    errorMessage: reason === "binary_not_found"
      ? `openclaw binary not found: ${raw}`
      : `failed to start openclaw agent: ${raw}`,
    stdout: null,
    stderr: null,
  };
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
      const failure = normalizeTaskFailure(err);
      db.prepare(
        "UPDATE tasks SET status = 'failed', exit_code = ?, stdout = ?, error_message = ?, finished_at = datetime('now') WHERE id = ?",
      ).run(
        failure.exitCode,
        failure.stdout,
        failure.errorMessage.slice(0, 5000),
        task.id,
      );

      db.prepare(`INSERT INTO event_log (task_id, event_type, payload) VALUES (?, ?, ?)`)
        .run(task.id, "failed", JSON.stringify({
          reason: failure.reason,
          exit_code: failure.exitCode,
          error: failure.errorMessage,
          stderr: failure.stderr,
        }));

      await writeFailed(task, failure.exitCode, failure.errorMessage);
      log("error", `Task #${task.id} failed (${failure.reason}): ${failure.errorMessage}`);
    }
  }
}

function normalizeTaskFailure(err: unknown): TaskExecutionFailure {
  if (err && typeof err === "object" && "kind" in err && (err as TaskExecutionFailure).kind === "failed") {
    return err as TaskExecutionFailure;
  }

  const errorMessage = err instanceof Error ? err.message : String(err || "Unknown error");
  return {
    kind: "failed",
    reason: "spawn_error",
    exitCode: null,
    errorMessage,
    stdout: null,
    stderr: null,
  };
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
      const skipped = t.skip_reason ? '<span title="' + esc(t.skip_reason) + '">skipped: ' + esc(t.skip_reason) + '</span>' : '';
      const failed = t.error_message ? '<span title="' + esc(t.error_message) + '">⚠️' + (t.exit_code !== null && t.exit_code !== undefined ? ' exit ' + t.exit_code : '') + '</span>' : '';
      const stdout = t.stdout ? '<span class="expand" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\\'block\\'?\\'none\\':\\'block\\'">stdout</span><div class="stdout-box">' + esc(t.stdout) + '</div>' : '';
      const detailParts = [skipped, failed, stdout].filter(Boolean);
      const details = detailParts.length ? detailParts.join('<br>') : '-';
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
          `SELECT
             tasks.*,
             (
               SELECT json_extract(event_log.payload, '$.reason')
               FROM event_log
               WHERE event_log.task_id = tasks.id AND event_log.event_type = 'skipped'
               ORDER BY event_log.id DESC
               LIMIT 1
             ) AS skip_reason
           FROM tasks
           ORDER BY id DESC
           LIMIT ?`,
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

  const ack = extractAckContext(event, payload);

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
  writeAck(task, pos, ack).catch(err => log("error", `Failed to write ack: ${err.message}`));

  return new Response("Accepted", { status: 202 });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

function main() {
  const db = initDb();

  log("info", "GitHub ↔ OpenClaw Bridge starting...");
  log("info", `Config source: ${config.configSource}`);
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
