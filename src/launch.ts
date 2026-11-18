import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paths } from "./config.js";

const REFUSED_CODES = ["ECONNREFUSED", "ConnectionRefused"];

export function connectionRefused(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (REFUSED_CODES.includes(String((e as NodeJS.ErrnoException).code))) return true;
  }
  return false;
}

export function startDetachedDaemon(dir: string): void {
  const bin = fileURLToPath(new URL("./bin.js", import.meta.url));
  const runtime = process.versions.bun === undefined ? process.execPath : "node";
  const log = openSync(paths(dir).log, "a");
  spawn(runtime, [bin, "daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_HOME: dir },
  })
    .on("error", () => {})
    .unref();
}
