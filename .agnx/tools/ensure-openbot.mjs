#!/usr/bin/env node
/**
 * 场景：短跑 sidecar — 确保 OpenBot（CopilotKit）整仓的 app + server 已起在指定端口。
 *
 * 用法：node .agnx/tools/ensure-openbot.mjs \
 *         [--port <n>] [--work-dir <dataRoot>] [--force-restart] [--supervised]
 *
 * 上游事实（见 EMBED.md）：
 *   - app（React/Vite 构建产物）由 `app/serve.ts` 走 Bun 服务，并内建把 `/api` 反代到 server；
 *   - server 走 Bun（Hono），读 `<repo>/.env`，必需 DATABASE_URL 与 Intelligence 三件套；
 *   - 上游默认端口 APP_PORT=3010 / SERVER_PORT=3001。
 *
 * 本脚本只做「启动参数 / 端口 / 登录注入」三件事，不改上游任何源码：
 *   - 对外端口 = --port（Agnx 分配的 8101），由 `bun app/serve.ts` 直接监听；
 *   - server 内部端口取 APP_PORT+2（8103）避开同批子应用 8100–8104 的占用；
 *   - TRUSTED_ORIGINS 现算现注入，保证 cookie 域与实际访问 origin 一致。
 *
 * stdout 最后一行：单行 JSON { ok, port, origin, reused, pid, ... }；失败 { ok:false, error } 且 exit 1。
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, constants as fsConstants, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 上游整仓根 = <appRoot>（`.agnx/` 与 `app/` 同级） */
const appRoot = path.resolve(__dirname, "../..");
const defaultPort = 8101;

/** 本机 Bun（上游 packageManager=bun；server 用 Bun.serve 与 Bun 专属 API，Node 跑不了）。 */
const BUN_CANDIDATES = [
  process.env.OPENBOT_BUN,
  path.join(process.env.HOME || "", ".bun/bin/bun"),
  "/opt/homebrew/bin/bun",
  "/usr/local/bin/bun",
].filter(Boolean);

function trace(phase, fields) {
  process.stderr.write(`[ensure-openbot] ${JSON.stringify({ phase, ...fields })}\n`);
}

function parseArgs(argv) {
  let workDir = process.env.AGNX_APP_DATA_ROOT || "";
  let port = defaultPort;
  let forceRestart = false;
  let supervised = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--work-dir" || arg === "--workDir") && next) {
      workDir = String(next).trim();
      i += 1;
    } else if (arg === "--port" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) port = n;
      i += 1;
    } else if (arg === "--force-restart" || arg === "--forceRestart") {
      forceRestart = true;
    } else if (arg === "--supervised") {
      supervised = true;
    }
  }
  return {
    workDir: workDir || path.join(appRoot, ".agnx-runtime"),
    port,
    forceRestart,
    supervised,
  };
}

function fingerprint(cfg) {
  return JSON.stringify({ appRoot, port: cfg.port });
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeState(statePath, payload) {
  await writeFile(statePath, JSON.stringify(payload, null, 2), "utf8");
}

function httpStatus(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
  });
}

/**
 * 端口是否已被 OpenBot 自己占着。
 * app 是静态 HTML，「标题」是它唯一可自证的标识（上游 scripts/start.sh 的 identifies_as_openbot 同款判据）。
 */
async function identifiesAsOpenBot(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 2500 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 8000) req.destroy();
      });
      res.on("end", () => resolve(/<title>[^<]*OpenBot/i.test(body)));
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function serverHealthy(port) {
  return (await httpStatus(`http://127.0.0.1:${port}/health`)) === 200;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

function stopPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return;
  try {
    process.kill(n, "SIGTERM");
  } catch {
    // 已退出
  }
}

async function stopGroup(state) {
  stopPid(state?.pid);
  stopPid(state?.serverPid);
  await new Promise((resolve) => setTimeout(resolve, 600));
}

async function pathExists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBun() {
  for (const candidate of BUN_CANDIDATES) {
    if (await pathExists(candidate)) return candidate;
  }
  const found = spawnSync("sh", ["-lc", "command -v bun"], { encoding: "utf8" });
  const bin = found.status === 0 ? found.stdout.trim() : "";
  return bin || null;
}

/** 读 `<repo>/.env` 里的一行（server 与 app 都靠它）。 */
async function readEnvFile() {
  const envPath = path.join(appRoot, ".env");
  const text = await readFile(envPath, "utf8").catch(() => "");
  const map = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

/**
 * 库是否已迁移：直接问 PostgreSQL 有没有上游 server 启动就必须读的 `agent_profiles` 表。
 * 缺失就执行上游自己的 `drizzle-kit migrate`（只建表，不改上游文件）。
 * 返回 "ready" | "migrated" | "failed"；探测不到（如本机没有 psql）则跳过，交给 server 自己报错。
 */
async function ensureDatabaseMigrated(bun, databaseUrl) {
  let hasTable = null;
  const psql = spawnSync("sh", ["-lc", "command -v psql"], { encoding: "utf8" });
  if (psql.status === 0) {
    const probe = spawnSync(
      "sh",
      ["-c", `psql "$DATABASE_URL" -tAc "select to_regclass('public.agent_profiles') is not null"`],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      },
    );
    if (probe.status === 0) hasTable = probe.stdout.trim() === "t";
  }
  if (hasTable === true) return "ready";
  trace("db-migrate", { reason: hasTable === false ? "agent_profiles 缺失" : "无法探测，预跑一次迁移" });
  const result = spawnSync(
    bun,
    ["--env-file=../.env", "node_modules/drizzle-kit/bin.cjs", "migrate", "--config=drizzle.config.ts"],
    { cwd: path.join(appRoot, "server"), encoding: "utf8", timeout: 600_000 },
  );
  if (result.status !== 0) {
    trace("db-migrate-failed", { stderr: String(result.stderr || result.stdout || "").slice(-1200) });
    return "failed";
  }
  return "migrated";
}

/**
 * 端口上的监听者 PID（lsof）。
 *
 * 状态文件只记在「上一次用的 workDir」里；Agnx 换数据根、或有人手动改过 --work-dir 时，
 * 新 workDir 读不到它。force-restart 必须仍能收拾掉端口上的旧 OpenBot，否则会一直误判。
 */
function listeningPids(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) return [];
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 1);
}

/** 数据/配置根下的 `.env` 模板（不含任何真密钥）。 */
const ENV_TEMPLATE = `# OpenBot × Agnx 子应用运行配置（本地单用户、无 Docker）
# 由 .agnx/tools/ensure-openbot.mjs 在首次启动时生成；上游 .env.example 未改动。
DATABASE_URL=postgresql://openbot:openbot@127.0.0.1:5432/openbot_agnx
KEY_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
PORT=3001
SERVER_PORT=3001
APP_PORT=3010
TENANT_PACKAGE_DIR=../examples/fintech
OPENBOT_SINGLE_USER=true
TRUSTED_ORIGINS=http://localhost:8101,http://127.0.0.1:8101
AGENT_COMPUTER_URL=http://127.0.0.1:4100
INTELLIGENCE_API_URL=https://api.intelligence.copilotkit.ai
INTELLIGENCE_GATEWAY_WS_URL=wss://realtime.intelligence.copilotkit.ai
# 必填：npx --yes copilotkit@latest login && npx --yes copilotkit@latest project select
INTELLIGENCE_API_KEY=
`;

/** <appRoot>/.env 不存在时从模板补一份，并把缺失项如实记进 warnings。 */
async function ensureEnvFile(warnings) {
  const envPath = path.join(appRoot, ".env");
  if (await pathExists(envPath)) return;
  await writeFile(envPath, ENV_TEMPLATE, "utf8");
  warnings.push(`已生成 ${envPath}，请按注释补齐 INTELLIGENCE_API_KEY`);
}

async function waitFor(check, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * 拉起上游进程并重定向到日志文件。
 *
 * 用文件而不是管道：ensure 结束时父进程退出，若靠管道收日志，上游一旦写满管道缓冲区就会
 * EAGAIN 卡死。日志落在 `<workDir>/logs/`，失败时从文件尾部取证据。
 */
/**
 * 拉起上游进程并重定向到日志文件。
 *
 * 用文件而不是管道：ensure 结束后父进程退出，上游若仍握着管道写端，调用方的
 * `ensure | tail` 会一直等 EOF 不返回。日志落在 `<workDir>/logs/`，失败时从文件尾部取证据。
 *
 * 启动失败（端口被抢、bun 路径不对）必须能听见：等一小会儿看进程有没有立刻退出，
 * 退出就把状态码交回去，而不是轮到上游健康检查超时再说。
 */
async function spawnDetached(command, args, { cwd, env, logFile }) {
  const logFd = openSync(logFile, "w");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  const early = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, error });
    });
  });
  return { child, earlyExit: early };
}

async function tail(filePath, maxBytes = 4000) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.slice(-maxBytes).trim();
  } catch {
    return "";
  }
}

/**
 * 内部端口：app 对直接监听 --port，server 用 --port+2。
 * 同批子应用占 8100–8112，固定 3001 会与别的开放端口撞车，而 .env 的 SERVER_PORT 又是上游
 * app/serve.ts 唯一的反代目标，所以这里由 .env 决定并做一次实际占用探测。
 *
 * 端口纪律（2026-10-19 修正）：原先取 externalPort+2 = 8103，而 8103 已分配给 bytebot 子应用，
 * 会把兄弟子应用顶掉。现改为从 8199 起的独立内部段，与 8100–8119 的对外端口池完全隔离。
 */
function pickServerPort(_externalPort) {
  return 8199;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const warnings = [];
  await mkdir(cfg.workDir, { recursive: true });
  const statePath = path.join(cfg.workDir, "openbot.json");
  const logDir = path.join(cfg.workDir, "logs");
  await mkdir(logDir, { recursive: true });
  const wantedFp = fingerprint(cfg);
  const origin = `http://127.0.0.1:${cfg.port}`;

  const bun = await resolveBun();
  if (!bun) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "未找到 bun（上游 packageManager=bun@1.3，server 依赖 Bun.serve）。请先安装 bun：https://bun.sh",
      }),
    );
    process.exitCode = 1;
    return;
  }

  const distEntry = path.join(appRoot, "app", "dist", "index.html");
  if (!(await pathExists(distEntry))) {
    // 首次安装/清缓存后自愈：跑上游自己的构建命令，不改上游脚本本身。
    trace("build-app", { appRoot });
    const gen = spawnSync(bun, ["run", "generate:app-config"], {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    const built = spawnSync(bun, ["--bun", "node_modules/vite/bin/vite.js", "build"], {
      cwd: path.join(appRoot, "app"),
      encoding: "utf8",
      timeout: 900_000,
    });
    if (!(await pathExists(distEntry))) {
      console.log(
        JSON.stringify({
          ok: false,
          error: `缺少 app/dist 且自动构建失败（generate:app-config exit=${gen.status}，vite build exit=${built.status}）：${String(
            built.stderr || gen.stderr || "",
          ).slice(-600)}`,
        }),
      );
      process.exitCode = 1;
      return;
    }
    warnings.push("app/dist 缺失，已由 ensure 自动构建");
  }

  const existing = await readState(statePath);
  const serverPort = pickServerPort(cfg.port);

  // ---- 复用：端口上就是 OpenBot，且 server 也健康 ----
  if (!cfg.forceRestart && (await identifiesAsOpenBot(cfg.port)) && (await serverHealthy(serverPort))) {
    trace("reuse", { port: cfg.port, serverPort, pid: existing?.pid ?? null });
    console.log(
      JSON.stringify({
        ok: true,
        reused: true,
        port: cfg.port,
        pid: isPidAlive(existing?.pid) ? existing.pid : null,
        serverPid: isPidAlive(existing?.serverPid) ? existing.serverPid : null,
        origin,
        serverOrigin: `http://127.0.0.1:${serverPort}`,
        appRoot,
        warnings,
      }),
    );
    return;
  }

  // ---- force-restart / 指纹变了：先收旧进程 ----
  if (existing) {
    trace("stop-previous", { pid: existing.pid ?? null, serverPid: existing.serverPid ?? null });
    await stopGroup(existing);
  }
  if (cfg.forceRestart && (await identifiesAsOpenBot(cfg.port))) {
    // 端口上仍是 OpenBot，但状态文件不在本 workDir：按端口收，并连带其 server。
    const orphans = listeningPids(cfg.port);
    trace("stop-orphan", { port: cfg.port, pids: orphans });
    for (const pid of orphans) stopPid(pid);
    for (const pid of listeningPids(serverPort)) stopPid(pid);
    await waitFor(async () => !(await portInUse(cfg.port)), 10_000, 300);
  }
  // 端口刚空出来也可能有 server 侧残留（收 app 不一定连带走 server）。
  if (await portInUse(serverPort)) {
    const leftovers = listeningPids(serverPort);
    trace("stop-leftover-server", { port: serverPort, pids: leftovers });
    for (const pid of leftovers) stopPid(pid);
    await waitFor(async () => !(await portInUse(serverPort)), 10_000, 300);
  }

  // ---- 端口被别的程序（不是 OpenBot）占着：如实报错，不去抢 ----
  if (await portInUse(cfg.port)) {
    if (await identifiesAsOpenBot(cfg.port)) {
      console.log(
        JSON.stringify({
          ok: false,
          error: `端口 ${cfg.port} 上是另一个 OpenBot 实例（server 端口 ${serverPort} 不健康，且状态文件不在当前 work-dir）。请加 --force-restart 重建`,
        }),
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify({
        ok: false,
        error: `端口 ${cfg.port} 已被其他程序占用（不是 OpenBot），拒绝抢占`,
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (await portInUse(serverPort)) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `OpenBot server 内部端口 ${serverPort} 已被占用，无法启动`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  await ensureEnvFile(warnings);
  const fileEnv = await readEnvFile();
  if (!fileEnv.DATABASE_URL) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `缺少 ${path.join(appRoot, ".env")} 里的 DATABASE_URL（OpenBot 依赖 PostgreSQL + pgvector）`,
      }),
    );
    process.exitCode = 1;
    return;
  }
  // 库未迁移时上游 server 会在查表阶段失败；这里先探一次，必要时跑上游的 drizzle 迁移。
  const migrated = await ensureDatabaseMigrated(bun, fileEnv.DATABASE_URL);
  if (migrated === "failed") {
    console.log(
      JSON.stringify({
        ok: false,
        error: "数据库迁移失败：请确认 PostgreSQL 已启动、已安装 pgvector，并检查 DATABASE_URL",
      }),
    );
    process.exitCode = 1;
    return;
  }
  if (migrated === "migrated") warnings.push("数据库表缺失，已自动执行 drizzle 迁移");

  if (!fileEnv.INTELLIGENCE_API_KEY) {
    console.log(
      JSON.stringify({
        ok: false,
        error:
          "OpenBot 需要 CopilotKit Intelligence 项目键才能启动 server（上游硬性要求）。" +
          `请执行：npx --yes copilotkit@latest login && npx --yes copilotkit@latest project select，` +
          `把得到的 cpk-... 写入 ${path.join(appRoot, ".env")} 的 INTELLIGENCE_API_KEY= 后重试。`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const baseEnv = {
    ...process.env,
    APP_PORT: String(cfg.port),
    SERVER_PORT: String(serverPort),
    PORT: String(serverPort),
    // 只做登录/来源注入：上游要求 cookie 签发域与实际访问 origin 一致。
    TRUSTED_ORIGINS: `${origin},http://localhost:${cfg.port}`,
    NODE_ENV: process.env.NODE_ENV || "development",
  };

  // ---- 1) server（Bun + Hono + CopilotKit runtime） ----
  const serverArgs = ["--env-file=../.env", "src/index.ts"];
  const serverLog = path.join(logDir, "server.log");
  const serverSpawn = await spawnDetached(bun, serverArgs, {
    cwd: path.join(appRoot, "server"),
    env: baseEnv,
    logFile: serverLog,
  });
  if (serverSpawn.earlyExit) {
    const log = await tail(serverLog);
    console.log(
      JSON.stringify({
        ok: false,
        error: `OpenBot server 启动即退出（${JSON.stringify(serverSpawn.earlyExit)}）：${log.slice(-600)}`,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const serverReady = await waitFor(() => serverHealthy(serverPort), 120_000, 500);
  if (!serverReady) {
    stopPid(serverSpawn.child.pid);
    const log = await tail(serverLog);
    // 上游常见的确定性失败：pgvector 缺失 / 迁移未跑。
    const hint = /relation .* does not exist|extension .*vector/i.test(log)
      ? "；数据库尚未迁移或未装 pgvector（brew install pgvector）"
      : /Intelligence is required|INTELLIGENCE_API_KEY/i.test(log)
        ? "；CopilotKit Intelligence 未配置：npx --yes copilotkit@latest login && project select"
        : "";
    console.log(
      JSON.stringify({
        ok: false,
        error: `OpenBot server 启动超时（端口 ${serverPort}）${hint}：${log.slice(-600)}`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  // ---- 2) app（Bun 静态服务 + /api 反代） ----
  const appLog = path.join(logDir, "app.log");
  const appSpawn = await spawnDetached(bun, ["serve.ts"], {
    cwd: path.join(appRoot, "app"),
    env: baseEnv,
    logFile: appLog,
  });
  if (appSpawn.earlyExit) {
    stopPid(serverSpawn.child.pid);
    const log = await tail(appLog);
    console.log(
      JSON.stringify({
        ok: false,
        error: `OpenBot app 启动即退出（${JSON.stringify(appSpawn.earlyExit)}）：${log.slice(-600)}`,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const appReady = await waitFor(() => identifiesAsOpenBot(cfg.port), 60_000, 400);
  if (!appReady) {
    stopPid(appSpawn.child.pid);
    stopPid(serverSpawn.child.pid);
    const log = await tail(appLog);
    console.log(
      JSON.stringify({
        ok: false,
        error: `OpenBot app 启动超时（端口 ${cfg.port}）：${log.slice(-600)}`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const state = {
    fingerprint: wantedFp,
    port: cfg.port,
    serverPort,
    pid: appSpawn.child.pid ?? null,
    serverPid: serverSpawn.child.pid ?? null,
    appRoot,
    bun,
    logs: { app: appLog, server: serverLog },
    warnings,
    updatedAt: Date.now(),
  };
  await writeState(statePath, state);
  try {
    // 兼容惯例：<workDir>/openbot.json 已有全部字段；再落一份纯 pid 便于人工诊断。
    await writeFile(path.join(cfg.workDir, "openbot.pids"), `${state.pid ?? ""}\n${state.serverPid ?? ""}\n`, "utf8");
  } catch {
    // pid 文件只是诊断便利，写失败不影响服务
  }
  trace("started", { port: cfg.port, serverPort, pid: state.pid, serverPid: state.serverPid });

  console.log(
    JSON.stringify({
      ok: true,
      reused: false,
      port: cfg.port,
      pid: state.pid,
      serverPid: state.serverPid,
      origin,
      serverOrigin: `http://127.0.0.1:${serverPort}`,
      appRoot,
      warnings,
    }),
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
