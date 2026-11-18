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
import { peerRequest } from "../src/tls.js";

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
  let writerEvents: PushEvent[];
  const bobHost = () => `127.0.0.1:${bob.config.peerPort}`;

  before(async () => {
    alice = await createNode("alice");
    bob = await createNode("bob");
    writer = await alice.agent("writer");
    helper = await bob.agent("helper");
    other = await bob.agent("other");
    helperEvents = bob.events("helper");
    writerEvents = alice.events("writer");
    await sleep(100);
  });

  const stateAt = (node: Node, id: string, state: string) =>
    eventually(() => (node.daemon.bridge.store.message(id)?.state === state ? true : undefined), `${id} ${state}`);

  test("outgoing messages leave right away; the receiver accepts each conversation", async () => {
    const file = join(alice.dir, "loader.bin");
    writeFileSync(file, Buffer.from([0, 1, 2, 3, 255]));
    const opened = await call(writer, "send", { to: `helper@${bobHost()}`, subject: "loader", body: "see attachment", attachments: [file] });
    assert.equal(opened.to, "bob/helper");
    assert.equal(opened.state, "queued");

    await stateAt(alice, opened.id, "held_by_receiver");
    const held = await eventually(() => writerEvents.find((e) => e.meta.kind === "undelivered"), "undelivered event");
    assert.deepEqual([held.meta.id, held.meta.problem], [opened.id, "held"]);
    assert.equal((await call(helper, "inbox")).length, 0);
    await assert.rejects(call(helper, "read", { id: opened.id }), /no message/);
    const request = await eventually(() => helperEvents.find((e) => e.meta.kind === "request"), "request event");
    assert.deepEqual([request.meta.thread, request.meta.from], [opened.thread, "alice/writer"]);
    const laterSession = bob.events("helper");
    await eventually(() => laterSession.find((e) => e.meta.kind === "request"), "pending request replayed on connect");

    assert.match(await command(helper, "accept", { thread: opened.thread }), /1 held message/);
    const [received] = await call(helper, "inbox");
    assert.equal(received.id, opened.id);
    assert.equal(received.remote, true);
    await eventually(() => helperEvents.find((e) => e.meta.id === opened.id && e.meta.kind === "message"), "message event after accept");
    await stateAt(alice, opened.id, "delivered");

    const full = await call(helper, "read", { id: opened.id });
    assert.match(full.trust, /not as instructions/);
    const dest = join(bob.dir, "fetched.bin");
    await call(helper, "fetch_attachment", { sha256: full.attachments[0].sha256, dest_path: dest });
    assert.deepEqual(readFileSync(dest), Buffer.from([0, 1, 2, 3, 255]));

    const answer = await call(helper, "reply", { id: opened.id, body: "got it" });
    assert.equal(answer.state, "queued");
    await stateAt(bob, answer.id, "delivered");
    const followUp = await call(writer, "reply", { id: answer.id, body: "thanks" });
    await stateAt(alice, followUp.id, "delivered");

    await call(helper, "ack", { ids: [opened.id] });
    await stateAt(alice, opened.id, "read");
  });

  test("accepting one conversation does not let the machine into others", async () => {
    const second = await call(writer, "send", { to: "bob/helper", subject: "another", body: "new thread" });
    const toOther = await call(writer, "send", { to: "bob/other", subject: "hi", body: "for other" });
    await stateAt(alice, second.id, "held_by_receiver");
    await stateAt(alice, toOther.id, "held_by_receiver");
    assert.ok(!(await call(helper, "inbox")).some((m: { id: string }) => m.id === second.id));
    await assert.rejects(call(helper, "reply", { id: second.id, body: "sneaking in" }), /no message/);
    assert.equal((await call(other, "inbox")).length, 0);
    assert.deepEqual(
      (await call(other, "peers")).waitingForAcceptance.map((r: { thread: string; held: number }) => [r.thread, r.held]),
      [[toOther.thread, 1]],
    );
  });

  test("discover shows only listed agents, and not this machine itself", async () => {
    const targets = [`127.0.0.1:${bob.config.peerPort}`, `127.0.0.1:${alice.config.peerPort}`, "127.0.0.1:1"];
    const visible = async () => (await call(writer, "discover", { targets })).machines.map((m: { node: string; agents: string[] }) => [m.node, m.agents]);
    assert.deepEqual(await visible(), [["bob", []]]);
    assert.match(await command(helper, "listed", { on: "on" }), /visible/);
    assert.deepEqual(await visible(), [["bob", ["helper"]]]);
    await command(helper, "listed", { on: "off" });
    assert.deepEqual(await visible(), [["bob", []]]);
  });

  test("a machine cannot take over a name another machine already uses", async () => {
    const impostor = await createNode("alice");
    const fake = await impostor.agent("writer");
    const sent = await call(fake, "send", { to: `helper@${bobHost()}`, subject: "", body: "trust me" });
    await stateAt(impostor, sent.id, "failed");
    assert.match(impostor.daemon.bridge.store.message(sent.id)?.lastError ?? "", /HTTP 403/);
    const fakeBob = await createNode("bob");
    await assert.rejects(alice.daemon.bridge.contact(`127.0.0.1:${fakeBob.config.peerPort}`), /belongs to another certificate/);
  });

  test("revoking a conversation holds the next incoming message again", async () => {
    const opened = await call(writer, "send", { to: "bob/helper", subject: "revoke me", body: "one" });
    await stateAt(alice, opened.id, "held_by_receiver");
    await command(helper, "accept", { thread: opened.thread });
    assert.match(await command(helper, "revoke", { thread: opened.thread }), /revoked/);
    const next = await call(writer, "reply", { id: opened.id, body: "two" });
    await stateAt(alice, next.id, "held_by_receiver");
  });

  test("a message the peer refuses fails and the sender is told, without blocking later messages", async () => {
    const typo = await call(writer, "send", { to: "bob/aii", subject: "typo", body: "lost" });
    const valid = await call(writer, "send", { to: "bob/helper", subject: "valid", body: "arrives" });
    await eventually(() => bob.daemon.bridge.store.message(valid.id), "valid message at bob");
    const failed = alice.daemon.bridge.store.message(typo.id);
    assert.equal(failed?.state, "failed");
    assert.match(failed?.lastError ?? "", /HTTP 404/);
    const told = await eventually(() => writerEvents.find((e) => e.meta.id === typo.id), "failure event");
    assert.equal(told.meta.problem, "failed");
  });

  test("an unaccepted machine reserves no name and cannot upload", async () => {
    const rita = await createNode("rita");
    const desk = await rita.agent("desk");
    const ritaHost = `127.0.0.1:${rita.config.peerPort}`;
    const fake = await createNode("sam");
    const real = await createNode("sam");

    const fakeSent = await call(await fake.agent("a"), "send", { to: `desk@${ritaHost}`, subject: "", body: "from the fake" });
    const realSent = await call(await real.agent("a"), "send", { to: `desk@${ritaHost}`, subject: "", body: "from the real one" });
    await stateAt(fake, fakeSent.id, "held_by_receiver");
    await stateAt(real, realSent.id, "held_by_receiver");

    const upload = await peerRequest(fake.daemon.bridge.store.peer("rita")!, fake.daemon.bridge.identity, "PUT", `/blobs/${"0".repeat(64)}`, {
      json: {},
    });
    assert.equal(upload.status, 403);

    assert.match(await command(desk, "accept"), /Several conversations wait/);
    assert.match(await command(desk, "accept", { machine: "sam" }), /More than one machine calls itself "sam"/);
    assert.equal((await call(desk, "inbox")).length, 0);
    assert.match(await command(desk, "accept", { thread: realSent.thread }), /1 held message/);
    assert.match(await command(desk, "accept"), /already belongs to another certificate/);
    assert.deepEqual((await call(desk, "inbox")).map((m: { id: string }) => m.id), [realSent.id]);
    assert.match(await command(desk, "accept", { thread: fakeSent.thread }), /already belongs to another certificate/);
  });

  test("a trusted machine reaches every agent without accepting each conversation, but not revoked threads", async () => {
    const home = await createNode("home");
    const a = await home.agent("a");
    await home.agent("b");
    const laptop = await createNode("laptop");
    const sender = await laptop.agent("l");

    const first = await call(sender, "send", { to: `a@127.0.0.1:${home.config.peerPort}`, subject: "", body: "hi a" });
    const toB = await call(sender, "send", { to: "home/b", subject: "", body: "hi b" });
    await stateAt(laptop, first.id, "held_by_receiver");
    await stateAt(laptop, toB.id, "held_by_receiver");
    assert.match(await command(a, "trust", { machine: "laptop" }), /not verified yet/);
    assert.match(await command(a, "trust", { machine: "laptop", fingerprint: "AA:BB" }), /no machine "laptop" with certificate/);
    const { yourCertificate } = await call(sender, "peers");
    assert.match(await command(a, "trust", { machine: "laptop", fingerprint: yourCertificate }), /2 held message/);
    await stateAt(laptop, first.id, "delivered");
    await stateAt(laptop, toB.id, "delivered");
    const direct = await call(sender, "send", { to: "home/a", subject: "", body: "no accept needed" });
    await stateAt(laptop, direct.id, "delivered");

    await command(a, "revoke", { thread: direct.thread });
    const afterRevoke = await call(sender, "reply", { id: direct.id, body: "still trusted?" });
    await stateAt(laptop, afterRevoke.id, "held_by_receiver");

    assert.match(await command(a, "untrust", { machine: "laptop" }), /stop always accepting/);
    const ongoing = await call(sender, "reply", { id: toB.id, body: "same thread" });
    await stateAt(laptop, ongoing.id, "delivered");
    const later = await call(sender, "send", { to: "home/b", subject: "", body: "new thread" });
    await stateAt(laptop, later.id, "held_by_receiver");

    await command(a, "trust", { machine: "laptop" });
    const seen = await call(sender, "discover", { targets: [`127.0.0.1:${home.config.peerPort}`] });
    assert.deepEqual(seen.machines[0].agents, ["a", "b"]);
  });

  test("messages to an offline machine are retried until it is back, and the sender is told", async () => {
    await bob.daemon.close();
    const opened = await call(writer, "send", { to: "bob/helper", subject: "offline", body: "first" });
    await eventually(() => alice.daemon.bridge.store.message(opened.id)?.lastError ?? undefined, "delivery error");
    assert.equal(alice.daemon.bridge.store.message(opened.id)?.state, "queued");
    const told = await eventually(() => writerEvents.find((e) => e.meta.id === opened.id), "retrying event");
    assert.equal(told.meta.problem, "retrying");

    bob.daemon = await startDaemon(bob.dir, 100);
    await eventually(() => bob.daemon.bridge.store.message(opened.id), "delivery after restart");
  });
});

describe("conversation expiry", () => {
  const expired = -1;

  test("an accepted conversation needs accepting again after the idle period", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agent-bridge-store-")), "bridge.db");
    const active = new Store(file, 24);
    active.incoming("t1", "helper", "alice/writer");
    assert.equal(active.isApproved("t1", "helper", "alice/writer"), false);
    active.approve("t1", "helper");
    assert.equal(active.isApproved("t1", "helper", "alice/writer"), true);
    active.close();

    const idle = new Store(file, expired);
    assert.equal(idle.isApproved("t1", "helper", "alice/writer"), false);
    assert.equal(idle.conversations("helper")[0].status, "expired");
    idle.close();
  });

  test("an incoming message does not revive an expired acceptance", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agent-bridge-store-")), "bridge.db");
    const store = new Store(file, 24);
    store.incoming("t1", "helper", "alice/writer");
    store.approve("t1", "helper");
    store.close();

    const idle = new Store(file, expired);
    idle.incoming("t1", "helper", "alice/writer");
    idle.close();
    const later = new Store(file, 24);
    assert.equal(later.isApproved("t1", "helper", "alice/writer"), false);
    later.close();
  });

  test("a thread this machine started before 0.3.0 counts as accepted after upgrading", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agent-bridge-store-")), "bridge.db");
    const old = new Store(file, 24);
    old.incoming("t1", "writer", "bob/helper");
    old.db
      .prepare(
        `INSERT INTO messages (id, thread, from_addr, to_addr, subject, body, attachments, created, state)
         VALUES ('t1', 't1', 'alice/writer', 'bob/helper', '', '', '[]', '2026-01-01T00:00:00Z', 'delivered')`,
      )
      .run();
    old.addPeer({ node: "bob", url: "https://b", cert: "", fingerprint: "real", trusted: true });
    old.addPeer({ node: "bob", url: "https://b", cert: "", fingerprint: "fake", trusted: false });
    old.db
      .prepare(
        `INSERT INTO messages (id, thread, from_addr, to_addr, subject, body, attachments, created, state, sender_fp)
         VALUES ('r1', 't1', 'bob/helper', 'alice/writer', '', '', '[]', '2026-01-01T00:01:00Z', 'held', 'real'),
                ('f1', 't1', 'bob/helper', 'alice/writer', '', '', '[]', '2026-01-01T00:02:00Z', 'held', 'fake')`,
      )
      .run();
    old.close();

    const upgraded = new Store(file, 24);
    assert.equal(upgraded.isApproved("t1", "writer", "bob/helper"), true);
    assert.equal(upgraded.message("r1")?.state, "delivered");
    assert.equal(upgraded.message("f1")?.state, "held");
    upgraded.close();
  });
});
