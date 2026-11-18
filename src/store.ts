import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export type MessageState =
  | "awaiting_approval"
  | "queued"
  | "held_by_receiver"
  | "held"
  | "delivered"
  | "read"
  | "failed";
export type ConversationStatus = "pending" | "approved" | "revoked" | "expired";

export interface Attachment {
  name: string;
  sha256: string;
  size: number;
}

export interface Message {
  id: string;
  thread: string;
  inReplyTo: string | null;
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments: Attachment[];
  created: string;
  state: MessageState;
  readAt: string | null;
  lastError: string | null;
}

export interface Conversation {
  thread: string;
  agent: string;
  peer: string;
  status: ConversationStatus;
  created: string;
  lastActivity: string;
}

export interface Peer {
  node: string;
  url: string;
  cert: string;
  fingerprint: string;
  trusted: boolean;
  firstSeen: string;
}

export interface ContactRequest {
  node: string;
  fingerprint: string;
  held: number;
  created: string;
}

export interface Receipt {
  id: string;
  from: string;
  state: "delivered" | "read";
  at: string;
}

export function newId(): string {
  return randomBytes(6).toString("hex");
}

export function now(): string {
  return new Date().toISOString();
}

export function nodeOf(address: string): string {
  return address.split("/")[0];
}

type Row = Record<string, SQLOutputValue>;

const OF_NODE = (column: string) => `substr(${column}, 1, length(?) + 1) = ? || '/'`;

function toMessage(row: Row): Message {
  return {
    id: String(row.id),
    thread: String(row.thread),
    inReplyTo: row.in_reply_to === null ? null : String(row.in_reply_to),
    from: String(row.from_addr),
    to: String(row.to_addr),
    subject: String(row.subject),
    body: String(row.body),
    attachments: JSON.parse(String(row.attachments)) as Attachment[],
    created: String(row.created),
    state: String(row.state) as MessageState,
    readAt: row.read_at === null ? null : String(row.read_at),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

function toPeer(row: Row): Peer {
  return {
    node: String(row.node),
    url: String(row.url),
    cert: String(row.cert),
    fingerprint: String(row.fingerprint),
    trusted: row.trusted === 1,
    firstSeen: String(row.first_seen),
  };
}

function toConversation(row: Row): Conversation {
  return {
    thread: String(row.thread),
    agent: String(row.agent),
    peer: String(row.peer),
    status: String(row.status) as ConversationStatus,
    created: String(row.created),
    lastActivity: String(row.last_activity),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly idleHours: number,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread TEXT NOT NULL,
        in_reply_to TEXT,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        attachments TEXT NOT NULL,
        created TEXT NOT NULL,
        state TEXT NOT NULL,
        read_at TEXT,
        receipt_pending INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sender_fp TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_to ON messages (to_addr, state);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread);
      CREATE TABLE IF NOT EXISTS conversations (
        thread TEXT NOT NULL,
        agent TEXT NOT NULL,
        peer TEXT NOT NULL,
        status TEXT NOT NULL,
        created TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        PRIMARY KEY (thread, agent, peer)
      );
      CREATE TABLE IF NOT EXISTS peers (
        fingerprint TEXT PRIMARY KEY,
        node TEXT NOT NULL,
        url TEXT NOT NULL,
        cert TEXT NOT NULL,
        trusted INTEGER NOT NULL,
        first_seen TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS trusted_node ON peers (node) WHERE trusted = 1;
      CREATE TABLE IF NOT EXISTS contacts (
        agent TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created TEXT NOT NULL,
        PRIMARY KEY (agent, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  insertMessage(m: Message, senderFingerprint: string | null = null): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
         (id, thread, in_reply_to, from_addr, to_addr, subject, body, attachments, created, state, read_at, sender_fp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.thread,
        m.inReplyTo,
        m.from,
        m.to,
        m.subject,
        m.body,
        JSON.stringify(m.attachments),
        m.created,
        m.state,
        m.readAt,
        senderFingerprint,
      );
    return result.changes > 0;
  }

  message(id: string): Message | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row && toMessage(row);
  }

  received(address: string, unreadOnly: boolean, limit: number): Message[] {
    const states = unreadOnly ? "('delivered')" : "('delivered', 'read')";
    return this.db
      .prepare(`SELECT * FROM messages WHERE to_addr = ? AND state IN ${states} ORDER BY rowid DESC LIMIT ?`)
      .all(address, limit)
      .map(toMessage);
  }

  sent(address: string, limit: number): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE from_addr = ? ORDER BY rowid DESC LIMIT ?")
      .all(address, limit)
      .map(toMessage);
  }

  unread(address: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE to_addr = ? AND state = 'delivered' ORDER BY rowid")
      .all(address)
      .map(toMessage);
  }

  markRead(address: string, ids: string[], localNode: string): string[] {
    const marked: string[] = [];
    const update = this.db.prepare(
      `UPDATE messages SET state = 'read', read_at = ?, receipt_pending = ?
       WHERE id = ? AND to_addr = ? AND state = 'delivered'`,
    );
    for (const id of ids) {
      const remote = nodeOf(this.message(id)?.from ?? localNode) !== localNode;
      if (update.run(now(), remote ? 1 : 0, id, address).changes > 0) marked.push(id);
    }
    return marked;
  }

  queued(): Message[] {
    return this.db.prepare("SELECT * FROM messages WHERE state = 'queued' ORDER BY rowid").all().map(toMessage);
  }

  markSent(id: string, state: "delivered" | "held_by_receiver"): void {
    this.db.prepare("UPDATE messages SET state = ?, last_error = NULL WHERE id = ? AND state = 'queued'").run(state, id);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare("UPDATE messages SET state = 'failed', last_error = ? WHERE id = ? AND state = 'queued'").run(error, id);
  }

  recordError(id: string, error: string): void {
    this.db.prepare("UPDATE messages SET last_error = ? WHERE id = ?").run(error, id);
  }

  hasAttachment(address: string, sha256: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM messages, json_each(messages.attachments) AS a
           WHERE (to_addr = ? OR from_addr = ?) AND json_extract(a.value, '$.sha256') = ? LIMIT 1`,
        )
        .get(address, address, sha256) !== undefined
    );
  }

  pendingReceipts(): Receipt[] {
    return this.db
      .prepare("SELECT id, from_addr, state, read_at, created FROM messages WHERE receipt_pending = 1 ORDER BY rowid")
      .all()
      .map((row) => ({
        id: String(row.id),
        from: String(row.from_addr),
        state: row.state === "read" ? "read" : "delivered",
        at: String(row.read_at ?? row.created),
      }));
  }

  clearReceipt(id: string): void {
    this.db.prepare("UPDATE messages SET receipt_pending = 0 WHERE id = ?").run(id);
  }

  applyReceipt(peerNode: string, id: string, state: "delivered" | "read", at: string): void {
    const from = state === "read" ? "('held_by_receiver', 'delivered')" : "('held_by_receiver')";
    this.db
      .prepare(
        `UPDATE messages SET
           state = CASE WHEN ? = 'delivered' AND attachments != '[]' THEN 'queued' ELSE ? END,
           read_at = CASE WHEN ? = 'read' THEN ? ELSE read_at END
         WHERE id = ? AND state IN ${from} AND ${OF_NODE("to_addr")}`,
      )
      .run(state, state, state, at, id, peerNode, peerNode);
  }

  heldFrom(address: string, fingerprint: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE to_addr = ? AND state = 'held' AND sender_fp = ? ORDER BY rowid")
      .all(address, fingerprint)
      .map(toMessage);
  }

  release(id: string): void {
    this.db.prepare("UPDATE messages SET state = 'delivered', receipt_pending = 1 WHERE id = ? AND state = 'held'").run(id);
  }

  private expireIdle(): void {
    const cutoff = new Date(Date.now() - this.idleHours * 3600_000).toISOString();
    this.db
      .prepare("UPDATE conversations SET status = 'expired' WHERE status = 'approved' AND last_activity < ?")
      .run(cutoff);
  }

  private conversation(thread: string, agent: string, peer: string): Conversation | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE thread = ? AND agent = ? AND peer = ?")
      .get(thread, agent, peer);
    return row && toConversation(row);
  }

  isApproved(thread: string, agent: string, peer: string): boolean {
    this.expireIdle();
    return this.conversation(thread, agent, peer)?.status === "approved";
  }

  outgoingState(thread: string, agent: string, peer: string): "queued" | "awaiting_approval" {
    if (this.isApproved(thread, agent, peer)) {
      this.db
        .prepare("UPDATE conversations SET last_activity = ? WHERE thread = ? AND agent = ? AND peer = ?")
        .run(now(), thread, agent, peer);
      return "queued";
    }
    this.db
      .prepare(
        `INSERT INTO conversations (thread, agent, peer, status, created, last_activity)
         VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (thread, agent, peer) DO UPDATE SET status = 'pending', last_activity = excluded.last_activity`,
      )
      .run(thread, agent, peer, now(), now());
    return "awaiting_approval";
  }

  incoming(thread: string, agent: string, peer: string): void {
    this.expireIdle();
    this.db
      .prepare(
        `INSERT INTO conversations (thread, agent, peer, status, created, last_activity)
         VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (thread, agent, peer) DO UPDATE SET last_activity = excluded.last_activity`,
      )
      .run(thread, agent, peer, now(), now());
  }

  approve(thread: string, agent: string, address: string): Conversation[] {
    const approved = this.db
      .prepare("UPDATE conversations SET status = 'approved', last_activity = ? WHERE thread = ? AND agent = ? RETURNING *")
      .all(now(), thread, agent)
      .map(toConversation);
    const release = this.db.prepare(
      "UPDATE messages SET state = 'queued' WHERE thread = ? AND from_addr = ? AND to_addr = ? AND state = 'awaiting_approval'",
    );
    for (const c of approved) release.run(thread, address, c.peer);
    return approved;
  }

  revoke(thread: string, agent: string, address: string): number {
    const revoked = this.db
      .prepare("UPDATE conversations SET status = 'revoked' WHERE thread = ? AND agent = ? RETURNING peer")
      .all(thread, agent);
    const hold = this.db.prepare(
      "UPDATE messages SET state = 'awaiting_approval' WHERE thread = ? AND from_addr = ? AND to_addr = ? AND state = 'queued'",
    );
    for (const row of revoked) hold.run(thread, address, String(row.peer));
    return revoked.length;
  }

  conversations(agent: string): Conversation[] {
    this.expireIdle();
    return this.db
      .prepare("SELECT * FROM conversations WHERE agent = ? ORDER BY last_activity DESC")
      .all(agent)
      .map(toConversation);
  }

  awaitingApproval(thread: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread = ? AND state = 'awaiting_approval'")
      .get(thread);
    return Number(row?.n ?? 0);
  }

  peer(node: string): Peer | undefined {
    const row = this.db.prepare("SELECT * FROM peers WHERE node = ? AND trusted = 1").get(node);
    return row && toPeer(row);
  }

  peerByFingerprint(fingerprint: string): Peer | undefined {
    const row = this.db.prepare("SELECT * FROM peers WHERE fingerprint = ?").get(fingerprint);
    return row && toPeer(row);
  }

  peers(): Peer[] {
    return this.db.prepare("SELECT * FROM peers WHERE trusted = 1 ORDER BY node").all().map(toPeer);
  }

  untrustedCount(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM peers WHERE trusted = 0").get()?.n ?? 0);
  }

  addPeer(peer: Omit<Peer, "firstSeen">): void {
    this.db
      .prepare("INSERT INTO peers (fingerprint, node, url, cert, trusted, first_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .run(peer.fingerprint, peer.node, peer.url, peer.cert, peer.trusted ? 1 : 0, now());
  }

  trustPeer(fingerprint: string): void {
    this.db.prepare("UPDATE peers SET trusted = 1 WHERE fingerprint = ?").run(fingerprint);
  }

  setPeerUrl(fingerprint: string, url: string): void {
    this.db.prepare("UPDATE peers SET url = ? WHERE fingerprint = ?").run(url, fingerprint);
  }

  forgetPeer(node: string): boolean {
    this.db
      .prepare(
        `UPDATE messages SET state = 'awaiting_approval' WHERE state = 'queued'
         AND thread IN (SELECT thread FROM conversations WHERE ${OF_NODE("peer")})`,
      )
      .run(node, node);
    this.db.prepare(`UPDATE conversations SET status = 'revoked' WHERE ${OF_NODE("peer")}`).run(node, node);
    this.db.prepare("DELETE FROM contacts WHERE fingerprint IN (SELECT fingerprint FROM peers WHERE node = ?)").run(node);
    return this.db.prepare("DELETE FROM peers WHERE node = ?").run(node).changes > 0;
  }

  approvedWithNode(node: string): boolean {
    this.expireIdle();
    return (
      this.db.prepare(`SELECT 1 FROM conversations WHERE status = 'approved' AND ${OF_NODE("peer")}`).get(node, node) !==
      undefined
    );
  }

  contactAccepted(agent: string, fingerprint: string): boolean {
    const row = this.db.prepare("SELECT status FROM contacts WHERE agent = ? AND fingerprint = ?").get(agent, fingerprint);
    return row?.status === "accepted";
  }

  acceptedByAnyone(fingerprint: string): boolean {
    return this.db.prepare("SELECT 1 FROM contacts WHERE fingerprint = ? AND status = 'accepted'").get(fingerprint) !== undefined;
  }

  requestContact(agent: string, fingerprint: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO contacts (agent, fingerprint, status, created) VALUES (?, ?, 'pending', ?)")
        .run(agent, fingerprint, now()).changes > 0
    );
  }

  acceptContact(agent: string, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT INTO contacts (agent, fingerprint, status, created) VALUES (?, ?, 'accepted', ?)
         ON CONFLICT (agent, fingerprint) DO UPDATE SET status = 'accepted'`,
      )
      .run(agent, fingerprint, now());
  }

  contactRequests(agent: string, address: string): ContactRequest[] {
    return this.db
      .prepare(
        `SELECT p.node, c.fingerprint, c.created,
           (SELECT COUNT(*) FROM messages m WHERE m.to_addr = ? AND m.state = 'held' AND m.sender_fp = c.fingerprint) AS held
         FROM contacts c JOIN peers p ON p.fingerprint = c.fingerprint
         WHERE c.agent = ? AND c.status = 'pending' ORDER BY c.created`,
      )
      .all(address, agent)
      .map((row) => ({
        node: String(row.node),
        fingerprint: String(row.fingerprint),
        held: Number(row.held),
        created: String(row.created),
      }));
  }

  acceptedContacts(agent: string): string[] {
    return this.db
      .prepare(
        `SELECT p.node FROM contacts c JOIN peers p ON p.fingerprint = c.fingerprint
         WHERE c.agent = ? AND c.status = 'accepted' ORDER BY p.node`,
      )
      .all(agent)
      .map((row) => String(row.node));
  }

  touchAgent(name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO agents (name, first_seen) VALUES (?, ?)").run(name, now());
  }

  agentExists(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM agents WHERE name = ?").get(name) !== undefined;
  }

  agents(): string[] {
    return this.db.prepare("SELECT name FROM agents ORDER BY name").all().map((row) => String(row.name));
  }
}
