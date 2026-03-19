import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHmac, randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface TestConfig {
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
}

interface GitHubCommentRecord {
  path: string;
  issueNumber: number;
  body: string;
}

interface StartedProcess {
  config: TestConfig;
  configPath: string;
  githubComments: GitHubCommentRecord[];
  workdir: string;
  stop: () => Promise<void>;
}

const activeStops: Array<() => Promise<void>> = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  while (activeStops.length > 0) {
    const stop = activeStops.pop();
    if (stop) await stop();
  }
});

describe("bridge integration", () => {
  test("loads JSON config and writes mention ack with quoted excerpt", async () => {
    const bridge = await startBridge({
      openclawBin: "/usr/bin/true",
      pollIntervalMs: 250,
    });

    const payload = {
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 101 },
      comment: {
        id: 5001,
        body: "@R2D2-im please take this\nsecond line\nthird line\nfourth line",
      },
      sender: { login: "alice" },
    };

    const response = await sendWebhook(bridge.config, "issue_comment", payload);
    expect(response.status).toBe(202);

    const task = await waitForTask(bridge.config.port, taskItem => taskItem.resource_number === 101 && taskItem.status === "completed");
    expect(task.trigger_type).toBe("mention");

    await waitFor(() => bridge.githubComments.filter(comment => comment.issueNumber === 101).length >= 3, "mention comments");
    const ack = bridge.githubComments.find(comment =>
      comment.issueNumber === 101 && comment.body.includes("Task received."),
    );

    expect(ack).toBeDefined();
    expect(ack?.body).toContain("Context:");
    expect(ack?.body).toContain("> @R2D2-im please take this");
    expect(ack?.body).toContain("> second line");
    expect(ack?.body).toContain("> third line");
    expect(ack?.body).not.toContain("fourth line");
  });

  test("records failed exit code and writes failed comment with exit code", async () => {
    const bridge = await startBridge({
      openclawBin: "/usr/bin/false",
      pollIntervalMs: 250,
    });

    const payload = {
      action: "assigned",
      repository: { full_name: "acme/widgets" },
      issue: { number: 102 },
      assignee: { login: "R2D2-im" },
      sender: { login: "bob" },
    };

    const response = await sendWebhook(bridge.config, "issues", payload);
    expect(response.status).toBe(202);

    const task = await waitForTask(bridge.config.port, taskItem => taskItem.resource_number === 102 && taskItem.status === "failed");
    expect(task.exit_code).toBe(1);
    expect(String(task.error_message)).toContain("exited with code 1");

    await waitFor(() => bridge.githubComments.filter(comment => comment.issueNumber === 102).length >= 3, "failed comments");
    const failedComment = bridge.githubComments.find(comment =>
      comment.issueNumber === 102 && comment.body.includes("Task failed"),
    );

    expect(failedComment).toBeDefined();
    expect(failedComment?.body).toContain("Task failed (exit code 1).");
  });

  test("returns skip_reason for superseded queued tasks", async () => {
    const bridge = await startBridge({
      openclawBin: "/usr/bin/true",
      pollIntervalMs: 5000,
    });

    const payloadA = {
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 103 },
      comment: { id: 7001, body: "@R2D2-im first request" },
      sender: { login: "carol" },
    };
    const payloadB = {
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 103 },
      comment: { id: 7002, body: "@R2D2-im second request" },
      sender: { login: "dave" },
    };

    const [respA, respB] = await Promise.all([
      sendWebhook(bridge.config, "issue_comment", payloadA),
      sendWebhook(bridge.config, "issue_comment", payloadB),
    ]);

    expect(respA.status).toBe(202);
    expect(respB.status).toBe(202);

    const tasks = await waitForTasks(
      bridge.config.port,
      current => current.filter(taskItem => taskItem.resource_number === 103).length === 2
        && current.some(taskItem => taskItem.status === "skipped")
        && current.some(taskItem => taskItem.status === "completed"),
    );

    const skipped = tasks.find(taskItem => taskItem.resource_number === 103 && taskItem.status === "skipped");
    expect(skipped).toBeDefined();
    expect(skipped?.skip_reason).toBe("same_resource_later_task_exists");
  });

  test("rejects webhook requests with invalid signature", async () => {
    const bridge = await startBridge({
      openclawBin: "/usr/bin/true",
      pollIntervalMs: 250,
    });

    const payload = {
      action: "assigned",
      repository: { full_name: "acme/widgets" },
      issue: { number: 104 },
      assignee: { login: "R2D2-im" },
      sender: { login: "eve" },
    };

    const response = await sendWebhook(bridge.config, "issues", payload, { invalidSignature: true });
    expect(response.status).toBe(401);

    await Bun.sleep(200);
    const tasks = await getTasks(bridge.config.port);
    expect(tasks.find(taskItem => taskItem.resource_number === 104)).toBeUndefined();
    expect(bridge.githubComments).toHaveLength(0);
  });
});

async function startBridge(overrides: Partial<TestConfig>): Promise<StartedProcess> {
  const workdir = mkdtempSync(join(tmpdir(), "openclaw-bridge-test-"));
  const githubPort = await getFreePort();
  const bridgePort = await getFreePort();
  const githubComments: GitHubCommentRecord[] = [];
  const githubServer = Bun.serve({
    port: githubPort,
    fetch: async request => {
      const body = await request.json() as { body?: string };
      const match = new URL(request.url).pathname.match(/\/issues\/(\d+)\/comments$/);
      githubComments.push({
        path: new URL(request.url).pathname,
        issueNumber: match ? Number(match[1]) : -1,
        body: body.body || "",
      });
      return Response.json({ id: githubComments.length }, { status: 201 });
    },
  });

  const config: TestConfig = {
    port: bridgePort,
    dbPath: join(workdir, "bridge.sqlite"),
    webhookPath: "/hooks",
    maxBodyBytes: 1_048_576,
    githubApiBaseUrl: `http://127.0.0.1:${githubPort}`,
    githubToken: "test-token",
    githubWebhookSecret: "test-secret",
    botUsername: "R2D2-im",
    openclawBin: "/usr/bin/true",
    openclawAgentId: "swe",
    openclawHome: workdir,
    taskTimeoutMs: 5_000,
    gracefulKillMs: 100,
    pollIntervalMs: 250,
    maxStdoutBytes: 102_400,
    ...overrides,
  };

  const configPath = join(workdir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const proc = Bun.spawn(
    [process.execPath, "run", "index.ts", "--config", configPath],
    {
      cwd: "/Users/kaichen/workspace/openclaw-github-bridge",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
      },
    },
  );

  const stdoutPromise = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("");
  const stderrPromise = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");

  const stop = async () => {
    try {
      proc.kill();
    } catch {}
    try {
      await proc.exited;
    } catch {}
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    githubServer.stop(true);
    rmSync(workdir, { recursive: true, force: true });
  };

  activeStops.push(stop);

  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${config.port}/health`);
      return response.ok;
    }, "bridge health");
  } catch (err) {
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    await stop();
    throw new Error(`Bridge failed to start.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n${String(err)}`);
  }

  return { config, configPath, githubComments, workdir, stop };
}

async function sendWebhook(
  config: TestConfig,
  eventType: string,
  payload: Record<string, JsonValue>,
  options: { invalidSignature?: boolean } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = options.invalidSignature
    ? "sha256=invalid"
    : `sha256=${createHmac("sha256", config.githubWebhookSecret).update(body).digest("hex")}`;

  return fetch(`http://127.0.0.1:${config.port}${config.webhookPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
    },
    body,
  });
}

async function getTasks(port: number): Promise<Array<Record<string, any>>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks`);
  const data = await response.json() as { tasks: Array<Record<string, any>> };
  return data.tasks;
}

async function waitForTask(
  port: number,
  predicate: (task: Record<string, any>) => boolean,
): Promise<Record<string, any>> {
  let lastTasks: Array<Record<string, any>> = [];
  await waitFor(async () => {
    lastTasks = await getTasks(port);
    return lastTasks.some(predicate);
  }, "task state");

  const found = lastTasks.find(predicate);
  if (!found) throw new Error("Expected task was not found");
  return found;
}

async function waitForTasks(
  port: number,
  predicate: (tasks: Array<Record<string, any>>) => boolean,
): Promise<Array<Record<string, any>>> {
  let lastTasks: Array<Record<string, any>> = [];
  await waitFor(async () => {
    lastTasks = await getTasks(port);
    return predicate(lastTasks);
  }, "tasks state");
  return lastTasks;
}

async function waitFor(
  predicate: (() => boolean | Promise<boolean>),
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate port"));
        return;
      }

      const { port } = address;
      server.close(closeErr => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolvePort(port);
      });
    });
    server.on("error", reject);
  });
}
