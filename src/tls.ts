import { request } from "node:https";
import type { Readable } from "node:stream";
import { connect } from "node:tls";
import { generate } from "selfsigned";

export interface PinnedEndpoint {
  url: string;
  cert: string;
  fingerprint: string;
}

export interface Identity {
  node: string;
  peerPort: number;
  cert: string;
  key: string;
}

export interface PeerResponse {
  status: number;
  body: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export async function generateIdentity(node: string): Promise<{ cert: string; key: string }> {
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate);
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 20);
  const pems = await generate([{ name: "commonName", value: `agent-bridge ${node}` }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    notBeforeDate,
    notAfterDate,
  });
  return { cert: pems.cert, key: pems.private };
}

export function pemOf(raw: Buffer): string {
  return `-----BEGIN CERTIFICATE-----\n${raw.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
}

export function fetchCert(url: string): Promise<PinnedEndpoint> {
  const { hostname, port } = new URL(url);
  const { promise, resolve, reject } = Promise.withResolvers<PinnedEndpoint>();
  const socket = connect({ host: hostname, port: Number(port || 443), rejectUnauthorized: false }, () => {
    const cert = socket.getPeerCertificate();
    socket.end();
    resolve({ url, cert: pemOf(cert.raw), fingerprint: cert.fingerprint256 });
  });
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error(`timeout connecting to ${url}`)));
  socket.on("error", reject);
  return promise;
}

export function peerRequest(
  endpoint: PinnedEndpoint,
  identity: Identity,
  method: string,
  path: string,
  options: { json?: unknown; stream?: Readable; length?: number } = {},
): Promise<PeerResponse> {
  const headers: Record<string, string | number> = {
    "x-agent-bridge-node": identity.node,
    "x-agent-bridge-port": identity.peerPort,
  };
  const payload = options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json));
  if (payload) {
    headers["content-type"] = "application/json";
    headers["content-length"] = payload.length;
  }
  if (options.length !== undefined) headers["content-length"] = options.length;

  const { promise, resolve, reject } = Promise.withResolvers<PeerResponse>();
  const req = request(
    new URL(path, endpoint.url),
    {
      method,
      headers,
      cert: identity.cert,
      key: identity.key,
      ca: endpoint.cert,
      timeout: REQUEST_TIMEOUT_MS,
      checkServerIdentity: (_host, cert) =>
        cert.fingerprint256 === endpoint.fingerprint
          ? undefined
          : new Error(`certificate fingerprint mismatch: got ${cert.fingerprint256}`),
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    },
  );
  req.on("timeout", () => req.destroy(new Error(`timeout talking to ${endpoint.url}`)));
  req.on("error", reject);
  if (options.stream) {
    options.stream.on("error", (error) => req.destroy(error));
    options.stream.pipe(req);
  } else {
    req.end(payload);
  }
  return promise;
}
