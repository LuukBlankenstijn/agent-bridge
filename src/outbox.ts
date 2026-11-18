import { createReadStream } from "node:fs";
import { z } from "zod";
import type { Bridge, RemoteMessage } from "./bridge.js";
import { nodeOf, type Message, type Peer } from "./store.js";
import { peerRequest, type PeerResponse } from "./tls.js";

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

const RETRYABLE_CLIENT_ERRORS = new Set([401, 408, 409, 429]);

class PermanentFailure extends Error {}

const deliveryAnswer = z.object({ state: z.enum(["delivered", "held"]) });

function expectOk(response: PeerResponse, what: string): void {
  if (response.status === 200) return;
  const message = `${what} failed with HTTP ${response.status}: ${response.body.trim()}`;
  const permanent = response.status >= 400 && response.status < 500 && !RETRYABLE_CLIENT_ERRORS.has(response.status);
  throw permanent ? new PermanentFailure(message) : new Error(message);
}

export class Outbox {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private again = false;
  private readonly backoff = new Map<string, { until: number; delay: number }>();

  constructor(
    private readonly bridge: Bridge,
    private readonly intervalMs = 5_000,
  ) {
    bridge.on("queued", () => void this.run());
  }

  start(): void {
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    void this.run();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.bridge.removeAllListeners("queued");
    await this.current;
  }

  run(): Promise<void> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      do {
        this.again = false;
        await this.flush().catch((error: unknown) => console.error(`agent-bridge: outbox error: ${error}`));
      } while (this.again);
    })().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private async flush(): Promise<void> {
    const blocked = new Set<string>();
    for (const message of this.bridge.store.queued()) {
      const node = nodeOf(message.to);
      if (blocked.has(node) || !this.ready(node)) {
        blocked.add(node);
        continue;
      }
      try {
        const state = await this.deliver(this.peer(node), message);
        this.bridge.store.markSent(message.id, state);
        this.backoff.delete(node);
        if (state === "held_by_receiver") this.bridge.emit("undelivered", { message, problem: "held" });
      } catch (error) {
        if (error instanceof PermanentFailure) {
          this.bridge.store.markFailed(message.id, error.message);
          this.bridge.emit("undelivered", { message, problem: "failed", error: error.message });
          continue;
        }
        this.bridge.store.recordError(message.id, String(error));
        if (message.lastError === null) this.bridge.emit("undelivered", { message, problem: "retrying", error: String(error) });
        this.fail(node);
        blocked.add(node);
      }
    }

    for (const receipt of this.bridge.store.pendingReceipts()) {
      const node = nodeOf(receipt.from);
      if (blocked.has(node) || !this.ready(node)) continue;
      try {
        const response = await peerRequest(this.peer(node), this.bridge.identity, "POST", "/receipts", {
          json: { id: receipt.id, state: receipt.state, at: receipt.at },
        });
        expectOk(response, "receipt");
        this.bridge.store.clearReceipt(receipt.id);
      } catch (error) {
        if (error instanceof PermanentFailure) {
          this.bridge.store.clearReceipt(receipt.id);
          continue;
        }
        this.fail(node);
        blocked.add(node);
      }
    }
  }

  private peer(node: string): Peer {
    const peer = this.bridge.store.peer(node);
    if (peer === undefined) throw new Error(`machine "${node}" was forgotten`);
    return peer;
  }

  private ready(node: string): boolean {
    return (this.backoff.get(node)?.until ?? 0) <= Date.now();
  }

  private fail(node: string): void {
    const delay = Math.min((this.backoff.get(node)?.delay ?? MIN_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS);
    this.backoff.set(node, { until: Date.now() + delay, delay });
  }

  private async deliver(peer: Peer, message: Message): Promise<"delivered" | "held_by_receiver"> {
    const identity = this.bridge.identity;
    const payload: RemoteMessage = {
      id: message.id,
      thread: message.thread,
      inReplyTo: message.inReplyTo,
      from: message.from,
      to: message.to,
      subject: message.subject,
      body: message.body,
      attachments: message.attachments,
      created: message.created,
    };
    let response = await peerRequest(peer, identity, "POST", "/messages", { json: payload });
    if (response.status === 409) {
      for (const attachment of message.attachments) {
        const path = `/blobs/${attachment.sha256}`;
        const head = await peerRequest(peer, identity, "HEAD", path);
        if (head.status === 200) continue;
        const upload = await peerRequest(peer, identity, "PUT", path, {
          stream: createReadStream(this.bridge.blobs.path(attachment.sha256)),
          length: attachment.size,
        });
        expectOk(upload, `upload of ${attachment.name}`);
      }
      response = await peerRequest(peer, identity, "POST", "/messages", { json: payload });
    }
    expectOk(response, "delivery");
    const { state } = deliveryAnswer.parse(JSON.parse(response.body));
    return state === "held" ? "held_by_receiver" : "delivered";
  }
}
