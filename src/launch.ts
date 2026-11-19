import { spawn } from "node:child_process";
import { accessSync, constants, openSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./config.js";

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
