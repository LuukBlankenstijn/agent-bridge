import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { z } from "zod";
import { BlobRejected } from "./blobs.js";
import { PeerError, peerUrl, type Bridge } from "./bridge.js";
import { assertName, MAX_BODY_BYTES } from "./config.js";
import type { Peer } from "./store.js";
import { pemOf } from "./tls.js";

const MAX_JSON_BYTES = 6 * MAX_BODY_BYTES + 64 * 1024;

const receipt = z.object({ id: z.string(), state: z.enum(["delivered", "read"]), at: z.iso.datetime() });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new PeerError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PeerError(400, "invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown = { ok: true }): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function identify(bridge: Bridge, req: IncomingMessage): Peer {
  const cert = (req.socket as TLSSocket).getPeerCertificate();
  if (!cert?.raw) throw new PeerError(401, "a client certificate is required");
  const node = String(req.headers["x-agent-bridge-node"] ?? "");
  const port = Number(req.headers["x-agent-bridge-port"]);
  try {
    assertName("node", node);
  } catch (error) {
    throw new PeerError(400, String(error));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PeerError(400, "invalid x-agent-bridge-port");
  if (node === bridge.identity.node) throw new PeerError(403, `node name "${node}" is this machine's own name`);
  return bridge.learnPeer(node, cert.fingerprint256, pemOf(cert.raw), peerUrl(req.socket.remoteAddress ?? "", port), false);
}

async function handle(bridge: Bridge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "https://peer");

  if (req.method === "GET" && pathname === "/hello") {
    const fingerprint = (req.socket as TLSSocket).getPeerCertificate()?.fingerprint256;
    const caller = fingerprint === undefined ? undefined : bridge.store.peerByFingerprint(fingerprint);
    const ownMachine = caller !== undefined && caller.trusted && bridge.store.alwaysAccepts(caller.fingerprint);
    send(res, 200, { node: bridge.identity.node, agents: ownMachine ? bridge.store.agents() : bridge.store.listedAgents() });
    return;
  }
  const peer = identify(bridge, req);
  const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(pathname);
  const mayUpload = peer.trusted && (bridge.store.alwaysAccepts(peer.fingerprint) || bridge.store.approvedWithNode(peer.node));
  if (blob && !mayUpload) throw new PeerError(403, "attachments are accepted only in accepted conversations");
  if (blob && req.method === "HEAD") {
    res.writeHead(bridge.blobs.has(blob[1]) ? 200 : 404).end();
    return;
  }
  if (blob && req.method === "PUT") {
    await bridge.blobs.receive(blob[1], req).catch((error: unknown) => {
      throw error instanceof BlobRejected ? new PeerError(400, error.message) : error;
    });
    send(res, 200);
    return;
  }
  if (req.method === "POST" && pathname === "/messages") {
    send(res, 200, { state: bridge.receive(peer, await readJson(req)) });
    return;
  }
  if (req.method === "POST" && pathname === "/receipts") {
    if (!peer.trusted) throw new PeerError(403, "receipts are accepted only from known machines");
    const parsed = receipt.safeParse(await readJson(req));
    if (!parsed.success) throw new PeerError(400, parsed.error.message);
    bridge.store.applyReceipt(peer.node, parsed.data.id, parsed.data.state, parsed.data.at);
    send(res, 200);
    return;
  }
  throw new PeerError(404, "not found");
}

export function startPeerServer(bridge: Bridge, host: string, port: number): Promise<Server> {
  const server = createServer(
    { cert: bridge.identity.cert, key: bridge.identity.key, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      handle(bridge, req, res).catch((error: unknown) => {
        const status = error instanceof PeerError ? error.status : 500;
        if (!res.headersSent) send(res, status, { error: error instanceof Error ? error.message : String(error) });
        else res.destroy();
      });
    },
  );
  const { promise, resolve, reject } = Promise.withResolvers<Server>();
  server.once("error", reject);
  server.listen(port, host, () => resolve(server));
  return promise;
}
