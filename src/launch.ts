import { spawn } from "node:child_process";
import { accessSync, constants, openSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { paths, VERSION, type Config } from "./config.js";

const REFUSED_CODES = ["ECONNREFUSED", "ConnectionRefused"];

export function connectionRefused(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (REFUSED_CODES.includes(String((e as NodeJS.ErrnoException).code))) return true;
  }
  return false;
}

function installedCommand(): string | undefined {
  if (process.platform === "win32") return undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "agent-bridge");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export function startDetachedDaemon(dir: string, ownInstall = false): void {
  const installed = ownInstall ? undefined : installedCommand();
  const ownBin = fileURLToPath(new URL("./bin.js", import.meta.url));
  const runtime = process.versions.bun === undefined ? process.execPath : "node";
  const [command, args] = installed === undefined ? [runtime, [ownBin, "daemon"]] : [installed, ["daemon"]];
  const log = openSync(paths(dir).log, "a");
  spawn(command, args, {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_HOME: dir },
  })
    .on("error", () => {})
    .unref();
}

export function isOlder(version: string, than: string): boolean {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

const START_TIMEOUT_MS = 15_000;
const REPLACE_ATTEMPTS = 3;

async function runningVersion(config: Config): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.mcpPort}/version`, {
      headers: { authorization: `Bearer ${config.adminToken}` },
    });
    if (!response.ok) return "0.0.0";
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "version" in body && typeof body.version === "string" ? body.version : "0.0.0";
  } catch {
    return undefined;
  }
}

async function waitFor(config: Config, dir: string, up: boolean): Promise<string | undefined> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const version = await runningVersion(config);
    if ((version !== undefined) === up) return version;
    await sleep(150);
  }
  throw new Error(`the agent-bridge daemon did not ${up ? "start" : "stop"}; see ${paths(dir).log}`);
}

export async function ensureDaemon(config: Config, dir: string): Promise<void> {
  let version = await runningVersion(config);
  if (version === undefined) {
    startDetachedDaemon(dir);
    version = await waitFor(config, dir, true);
  }
  for (let attempt = 0; attempt < REPLACE_ATTEMPTS && isOlder(version!, VERSION); attempt++) {
    await fetch(`http://127.0.0.1:${config.mcpPort}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.adminToken}` },
    }).catch(() => {});
    await waitFor(config, dir, false);
    startDetachedDaemon(dir, true);
    version = await waitFor(config, dir, true);
  }
}
