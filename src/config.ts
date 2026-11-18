import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { generateIdentity } from "./tls.js";

export interface Config {
  node: string;
  listen: string;
  peerPort: number;
  mcpPort: number;
  conversationIdleHours: number;
  waitCapSeconds: number;
  discover?: string[];
  adminToken: string;
}

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function assertName(kind: string, name: string): void {
  if (!NAME.test(name)) {
    throw new Error(`invalid ${kind} name "${name}": use letters, digits, "-" or "_"`);
  }
}

export function toName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 64);
  return name || "agent";
}

export function defaultAgentName(directory = process.cwd()): string {
  return toName(basename(directory));
}

export function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
  if (!supported) {
    throw new Error(`agent-bridge needs Node.js >= 22.13 (found ${process.versions.node})`);
  }
}

export function dataDir(): string {
  if (process.env.AGENT_BRIDGE_HOME) return process.env.AGENT_BRIDGE_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "agent-bridge");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-bridge");
}

export function paths(dir = dataDir()) {
  const identity = join(dir, "identity");
  return {
    dir,
    identity,
    config: join(identity, "config.json"),
    cert: join(identity, "cert.pem"),
    key: join(identity, "key.pem"),
    db: join(dir, "bridge.db"),
    blobs: join(dir, "blobs"),
    log: join(dir, "daemon.log"),
  };
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function ensureSetup(dir = dataDir(), overrides: Partial<Config> = {}): Promise<Config> {
  const p = paths(dir);
  if (!existsSync(p.config)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const config: Config = {
      node: toName(hostname()),
      listen: "0.0.0.0",
      peerPort: 8766,
      mcpPort: 8767,
      conversationIdleHours: 24,
      waitCapSeconds: 25,
      discover: [],
      adminToken: newToken(),
      ...overrides,
    };
    const staging = join(dir, `.identity-${newToken().slice(0, 8)}`);
    mkdirSync(staging, { mode: 0o700 });
    const identity = await generateIdentity(config.node);
    writeFileSync(join(staging, "key.pem"), identity.key, { mode: 0o600 });
    writeFileSync(join(staging, "cert.pem"), identity.cert);
    writeFileSync(join(staging, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(staging, p.identity);
    } catch {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return loadConfig(dir);
}

export function loadConfig(dir = dataDir()): Config {
  return JSON.parse(readFileSync(paths(dir).config, "utf8")) as Config;
}

export function saveConfig(config: Config, dir = dataDir()): void {
  const file = paths(dir).config;
  writeFileSync(`${file}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
