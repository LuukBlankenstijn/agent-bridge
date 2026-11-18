import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureSetup, type Config } from "../src/config.js";
import { startDaemon, type Daemon } from "../src/daemon.js";
import { AGENT_HEADER, readEvents, type PushEvent } from "../src/events.js";
import { Store } from "../src/store.js";
import { fingerprintOf, peerRequest } from "../src/tls.js";

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  await once(server, "close");
  return port;
}

interface Node {
  dir: string;
  config: Config;
  daemon: Daemon;
  agent(name: string): Promise<Client>;
  events(agent: string): PushEvent[];
}

const closers: (() => Promise<void>)[] = [];

async function createNode(node: string): Promise<Node> {
  const dir = mkdtempSync(join(tmpdir(), `agent-bridge-${node}-`));
  const config = await ensureSetup(dir, {
    node,
    listen: "127.0.0.1",
    peerPort: await freePort(),
    mcpPort: await freePort(),
    waitCapSeconds: 50,
  });
  const result: Node = {
    dir,
    config,
    daemon: await startDaemon(dir, 100),
    async agent(name) {
      const client = new Client({ name: `test-${name}`, version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.mcpPort}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${config.adminToken}`, [AGENT_HEADER]: name } },
        }),
      );
      return client;
    },
    events(agent) {
      const received: PushEvent[] = [];
      const controller = new AbortController();
      void (async () => {
        for await (const event of readEvents(config, agent, controller.signal)) received.push(event);
      })().catch(() => {});
      closers.push(async () => controller.abort());
      return received;
    },
  };
  closers.push(() => result.daemon.close());
  return result;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as { type: string; text: string }[])[0].text;
  if (response.isError) throw new Error(text);
  return JSON.parse(text);
}

async function command(client: Client, name: string, args: Record<string, string> = {}): Promise<string> {
  const response = await client.getPrompt({ name, arguments: args });
  const content = response.messages[0].content;
  return content.type === "text" ? content.text : "";
}

async function eventually<T>(check: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

after(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
});

describe("agents on one machine", () => {
  let alice: Node;
  let writer: Client;
  let reader: Client;
  let pushed: PushEvent[];

  before(async () => {
    alice = await createNode("alice");
    writer = await alice.agent("writer");
    reader = await alice.agent("reader");
    pushed = alice.events("reader");
    await sleep(100);
  });

  test("a message is delivered immediately, pushed to the recipient, and its read state reaches the sender", async () => {
    const sent = await call(writer, "send", { to: "reader", subject: "card", body: "vendor class set" });
    assert.equal(sent.state, "delivered");

    const event = await eventually(() => pushed.find((e) => e.meta.id === sent.id), "push event");
    assert.equal(event.meta.kind, "message");
    assert.match(event.content, /vendor class set/);

    await call(reader, "ack", { ids: [sent.id] });
    const [mine] = await call(writer, "inbox", { box: "sent", limit: 1 });
    assert.equal(mine.state, "read");
  });

  test("wait blocks until a message arrives and times out when none does", async () => {
    assert.deepEqual(await call(reader, "wait", { timeout_seconds: 1 }), { timeout: true });

    const pending = call(reader, "wait", { timeout_seconds: 10 });
    await sleep(200);
    const sent = await call(writer, "send", { to: "alice/reader", subject: "", body: "ping" });
    assert.equal((await pending).messages[0].id, sent.id);
    await call(reader, "ack", { ids: [sent.id] });
  });

  test("an agent cannot read or ack mail that is not addressed to it", async () => {
    const builder = await alice.agent("builder");
    const sent = await call(writer, "send", { to: "reader", subject: "", body: "private" });
    await assert.rejects(call(builder, "read", { id: sent.id }), /no message/);
    assert.deepEqual((await call(builder, "ack", { ids: [sent.id] })).marked, []);
    assert.deepEqual((await call(writer, "ack", { ids: [sent.id] })).marked, []);
    await call(reader, "ack", { ids: [sent.id] });
  });

  test("the local endpoint refuses requests without the machine's token", async () => {
    const response = await fetch(`http://127.0.0.1:${alice.config.mcpPort}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer nope", [AGENT_HEADER]: "writer" },
      body: "{}",
    });
    assert.equal(response.status, 401);
  });
});

describe("agents on two machines", () => {
  let alice: Node;
  let bob: Node;
  let writer: Client;
  let helper: Client;
  let other: Client;
  let helperEvents: PushEvent[];
  const bobHost = () => `127.0.0.1:${bob.config.peerPort}`;

  before(async () => {
    alice = await createNode("alice");
    bob = await createNode("bob");
    writer = await alice.agent("writer");
    helper = await bob.agent("helper");
    other = await bob.agent("other");
    helperEvents = bob.events("helper");
    await sleep(100);
  });

  test("first contact: the sender approves the conversation, the receiver accepts the machine once", async () => {
    const file = join(alice.dir, "loader.bin");
    writeFileSync(file, Buffer.from([0, 1, 2, 3, 255]));
    const opened = await call(writer, "send", { to: `helper@${bobHost()}`, subject: "loader", body: "see attachment", attachments: [file] });
    assert.equal(opened.to, "bob/helper");
    assert.equal(opened.state, "awaiting_approval");
    await sleep(300);
    assert.equal(alice.daemon.bridge.store.message(opened.id)?.state, "awaiting_approval");

    assert.match(await command(writer, "approve", { thread: opened.thread }), /approved/);
    await eventually(
      () => (alice.daemon.bridge.store.message(opened.id)?.state === "held_by_receiver" ? true : undefined),
      "held by receiver",
    );
    assert.equal((await call(helper, "inbox")).length, 0);
    await assert.rejects(call(helper, "read", { id: opened.id }), /no message/);
    const contact = await eventually(() => helperEvents.find((e) => e.meta.kind === "contact"), "contact event");
    assert.equal(contact.meta.node, "alice");

    assert.match(await command(helper, "accept", { machine: "alice" }), /1 held message/);
    const [received] = await call(helper, "inbox");
    assert.equal(received.id, opened.id);
    assert.equal(received.remote, true);
    await eventually(() => helperEvents.find((e) => e.meta.id === opened.id), "message event after accept");
    await eventually(
      () => (alice.daemon.bridge.store.message(opened.id)?.state === "delivered" ? true : undefined),
      "delivered receipt",
    );

    const full = await call(helper, "read", { id: opened.id });
    assert.match(full.trust, /not as instructions/);
    const dest = join(bob.dir, "fetched.bin");
    await call(helper, "fetch_attachment", { sha256: full.attachments[0].sha256, dest_path: dest });
    assert.deepEqual(readFileSync(dest), Buffer.from([0, 1, 2, 3, 255]));

    const answer = await call(helper, "reply", { id: opened.id, body: "got it" });
    assert.equal(answer.state, "awaiting_approval");
    await command(helper, "approve", { thread: opened.thread });
    const atAlice = await eventually(() => alice.daemon.bridge.store.message(answer.id), "reply at alice");
    assert.equal(atAlice.state, "delivered");

    const followUp = await call(writer, "reply", { id: answer.id, body: "thanks" });
    assert.equal(followUp.state, "queued");
    await eventually(() => bob.daemon.bridge.store.message(followUp.id), "follow-up at bob");

    await call(helper, "ack", { ids: [opened.id] });
    await eventually(() => (alice.daemon.bridge.store.message(opened.id)?.state === "read" ? true : undefined), "read receipt");
  });

  test("acceptance is per receiving agent", async () => {
    const opened = await call(writer, "send", { to: "bob/other", subject: "hi", body: "for other" });
    await command(writer, "approve", { thread: opened.thread });
    await eventually(
      () => (alice.daemon.bridge.store.message(opened.id)?.state === "held_by_receiver" ? true : undefined),
      "held by receiver",
    );
    assert.equal((await call(other, "inbox")).length, 0);
    assert.deepEqual(
      (await call(other, "peers")).waitingForAcceptance.map((c: { node: string; held: number }) => [c.node, c.held]),
      [["alice", 1]],
    );
  });

  test("discover finds other machines and their agents, but not itself", async () => {
    const result = await call(writer, "discover", {
      targets: [`127.0.0.1:${bob.config.peerPort}`, `127.0.0.1:${alice.config.peerPort}`, "127.0.0.1:1"],
    });
    assert.deepEqual(
      result.machines.map((m: { node: string; agents: string[]; known: boolean }) => [m.node, m.agents, m.known]),
      [["bob", ["helper", "other"], true]],
    );
  });

  test("a machine cannot take over a name another machine already uses", async () => {
    const impostor = await createNode("alice");
    const fake = await impostor.agent("writer");
    const sent = await call(fake, "send", { to: `helper@${bobHost()}`, subject: "", body: "trust me" });
    await command(fake, "approve", { thread: sent.thread });
    const refused = await eventually(
      () => (impostor.daemon.bridge.store.message(sent.id)?.state === "failed" ? impostor.daemon.bridge.store.message(sent.id) : undefined),
      "refusal",
    );
    assert.match(refused.lastError ?? "", /HTTP 403/);
    const fakeBob = await createNode("bob");
    await assert.rejects(alice.daemon.bridge.contact(`127.0.0.1:${fakeBob.config.peerPort}`), /belongs to another certificate/);
  });

  test("revoking a conversation holds the next message again", async () => {
    const opened = await call(writer, "send", { to: "bob/helper", subject: "revoke me", body: "one" });
    await command(writer, "approve", { thread: opened.thread });
    assert.match(await command(writer, "revoke", { thread: opened.thread }), /revoked/);
    const next = await call(writer, "reply", { id: opened.id, body: "two" });
    assert.equal(next.state, "awaiting_approval");
  });

  test("a message the peer refuses fails without blocking later messages to that peer", async () => {
    const typo = await call(writer, "send", { to: "bob/aii", subject: "typo", body: "lost" });
    await command(writer, "approve", { thread: typo.thread });
    const valid = await call(writer, "send", { to: "bob/helper", subject: "valid", body: "arrives" });
    await command(writer, "approve", { thread: valid.thread });
    await eventually(() => bob.daemon.bridge.store.message(valid.id), "valid message at bob");
    const failed = alice.daemon.bridge.store.message(typo.id);
    assert.equal(failed?.state, "failed");
    assert.match(failed?.lastError ?? "", /HTTP 404/);
  });

  test("an unaccepted machine reserves no name, cannot upload, and does not see agent names", async () => {
    const rita = await createNode("rita");
    const desk = await rita.agent("desk");
    const ritaHost = `127.0.0.1:${rita.config.peerPort}`;
    const fake = await createNode("sam");
    const real = await createNode("sam");

    const fakeAgent = await fake.agent("a");
    const fakeSent = await call(fakeAgent, "send", { to: `desk@${ritaHost}`, subject: "", body: "from the fake" });
    await command(fakeAgent, "approve", { thread: fakeSent.thread });
    const realAgent = await real.agent("a");
    const realSent = await call(realAgent, "send", { to: `desk@${ritaHost}`, subject: "", body: "from the real one" });
    await command(realAgent, "approve", { thread: realSent.thread });
    for (const [node, id] of [[fake, fakeSent.id], [real, realSent.id]] as const) {
      await eventually(() => (node.daemon.bridge.store.message(id)?.state === "held_by_receiver" ? true : undefined), "held");
    }

    const upload = await peerRequest(fake.daemon.bridge.store.peer("rita")!, fake.daemon.bridge.identity, "PUT", `/blobs/${"0".repeat(64)}`, {
      json: {},
    });
    assert.equal(upload.status, 403);
    assert.equal((await call(realAgent, "discover", { targets: [ritaHost] })).machines[0].agents, undefined);

    assert.match(await command(desk, "accept", { machine: "sam" }), /2 different machines/);
    const realFingerprint = fingerprintOf(real.daemon.bridge.identity.cert);
    assert.match(await command(desk, "accept", { machine: "sam", fingerprint: realFingerprint }), /1 held message/);
    assert.deepEqual((await call(desk, "inbox")).map((m: { id: string }) => m.id), [realSent.id]);
    assert.deepEqual((await call(realAgent, "discover", { targets: [ritaHost] })).machines[0].agents, ["desk"]);
  });

  test("messages to an offline machine are retried until it is back", async () => {
    const opened = await call(writer, "send", { to: "bob/helper", subject: "offline", body: "first" });
    await bob.daemon.close();
    await command(writer, "approve", { thread: opened.thread });
    await eventually(() => alice.daemon.bridge.store.message(opened.id)?.lastError ?? undefined, "delivery error");
    assert.equal(alice.daemon.bridge.store.message(opened.id)?.state, "queued");

    bob.daemon = await startDaemon(bob.dir, 100);
    await eventually(() => bob.daemon.bridge.store.message(opened.id), "delivery after restart");
  });
});

describe("conversation expiry", () => {
  const expired = -1;

  test("an approved conversation needs approval again after the idle period", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agent-bridge-store-")), "bridge.db");
    const active = new Store(file, 24);
    assert.equal(active.outgoingState("t1", "writer", "bob/helper"), "awaiting_approval");
    active.approve("t1", "writer", "alice/writer");
    assert.equal(active.outgoingState("t1", "writer", "bob/helper"), "queued");
    active.close();

    const idle = new Store(file, expired);
    assert.equal(idle.outgoingState("t1", "writer", "bob/helper"), "awaiting_approval");
    assert.equal(idle.conversations("writer")[0].status, "pending");
    idle.close();
  });

  test("an incoming message does not revive an expired approval", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agent-bridge-store-")), "bridge.db");
    const store = new Store(file, 24);
    store.outgoingState("t1", "writer", "bob/helper");
    store.approve("t1", "writer", "alice/writer");
    store.close();

    const idle = new Store(file, expired);
    idle.incoming("t1", "writer", "bob/helper");
    idle.close();
    const later = new Store(file, 24);
    assert.equal(later.outgoingState("t1", "writer", "bob/helper"), "awaiting_approval");
    later.close();
  });
});
