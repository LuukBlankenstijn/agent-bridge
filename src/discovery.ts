import { execFile } from "node:child_process";
import { isIPv4, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { fetchCert, peerRequest, type Identity } from "./tls.js";

export interface Found {
  node: string;
  address: string;
}

const PROBE_TIMEOUT_MS = 400;
const CONCURRENCY = 128;
const MAX_HOSTS = 4096;
const AUTO_MIN_PREFIX = 22;

const hello = z.object({ node: z.string() });

function toInt(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function toIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
}

export function hostsIn(cidr: string): string[] {
  const [base, bits] = cidr.split("/");
  const prefix = Number(bits ?? 32);
  if (!isIPv4(base) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`invalid IPv4 range "${cidr}"`);
  const size = 2 ** (32 - prefix);
  if (size > MAX_HOSTS + 2) throw new Error(`range ${cidr} has ${size} addresses; scan at most ${MAX_HOSTS} at once`);
  const start = toInt(base) - (toInt(base) % size);
  if (size <= 2) return Array.from({ length: size }, (_, i) => toIp(start + i));
  return Array.from({ length: size - 2 }, (_, i) => toIp(start + 1 + i));
}

export function resolveListen(listen: string): string {
  if (isIPv4(listen) || listen.includes(":")) return listen;
  const addresses = networkInterfaces()[listen];
  const ipv4 = addresses?.find((a) => a.family === "IPv4");
  if (ipv4 === undefined) {
    throw new Error(`no network interface "${listen}" with an IPv4 address (have: ${Object.keys(networkInterfaces()).join(", ")})`);
  }
  return ipv4.address;
}

export function localRanges(listen: string): string[] {
  const ranges = new Set<string>();
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== "IPv4" || a.internal || a.cidr === null) continue;
      if (listen !== "0.0.0.0" && listen !== name && listen !== a.address) continue;
      const prefix = Number(a.cidr.split("/")[1]);
      if (prefix >= 31) continue;
      ranges.add(prefix >= AUTO_MIN_PREFIX ? a.cidr : `${a.address}/24`);
    }
  }
  return [...ranges];
}

export function expandTargets(entries: string[]): string[] {
  return entries.flatMap((entry) => (entry.includes("/") ? hostsIn(entry) : [entry]));
}

const tailscaleStatus = z.object({
  Peer: z.record(z.string(), z.object({ TailscaleIPs: z.array(z.string()).optional() })).optional(),
});

export async function tailscalePeers(): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)("tailscale", ["status", "--json"], { timeout: 3000 });
    const status = tailscaleStatus.parse(JSON.parse(stdout));
    return Object.values(status.Peer ?? {}).flatMap((peer) => (peer.TailscaleIPs ?? []).filter((ip) => isIPv4(ip)));
  } catch {
    return [];
  }
}

function portOpen(host: string, port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = new Socket();
  const done = (open: boolean) => {
    socket.destroy();
    resolve(open);
  };
  socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
  socket.once("error", () => done(false));
  socket.connect(port, host, () => done(true));
  return promise;
}

async function identify(host: string, port: number, identity: Identity): Promise<Found | undefined> {
  try {
    const endpoint = await fetchCert(`https://${host}:${port}`);
    const response = await peerRequest(endpoint, identity, "GET", "/hello");
    if (response.status !== 200) return undefined;
    const { node } = hello.parse(JSON.parse(response.body));
    return { node, address: `${host}:${port}` };
  } catch {
    return undefined;
  }
}

export async function discover(hosts: string[], defaultPort: number, identity: Identity): Promise<Found[]> {
  const queue = [...new Set(hosts)].map((entry) => {
    const match = /^([^:]+):(\d+)$/.exec(entry);
    return match ? { host: match[1], port: Number(match[2]) } : { host: entry, port: defaultPort };
  });
  const found: Found[] = [];
  const worker = async () => {
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      if (!(await portOpen(target.host, target.port))) continue;
      const machine = await identify(target.host, target.port, identity);
      if (machine !== undefined && machine.node !== identity.node) found.push(machine);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return found.sort((a, b) => a.node.localeCompare(b.node));
}
