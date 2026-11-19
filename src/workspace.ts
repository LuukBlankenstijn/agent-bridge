import type { SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { PeerError, splitAddress, type Bridge } from "./bridge.js";
import { assertName, MAX_BODY_BYTES } from "./config.js";
import type { Trust } from "./events.js";
import { newId, nodeOf, now, type Peer } from "./store.js";
import { peerRequest } from "./tls.js";

export const POST_KINDS = ["note", "request", "question", "answer"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const MODES = ["all", "mentions"] as const;
export type Mode = (typeof MODES)[number];

export interface Post {
  id: string;
  author: string;
  kind: PostKind;
  body: string;
  replyTo: string | null;
  root: string;
  to: string[];
  source: "user" | "desk" | null;
  reliesOn: string | null;
  created: string;
}

export interface PostInput {
  kind: PostKind;
  body: string;
  to?: string[];
  replyTo?: string;
  source?: "user" | "desk";
  reliesOn?: string;
}

export interface WorkspaceWake {
  agent: string;
  workspace: string;
  host: string;
  posts: Post[];
  more: number;
  skipped: boolean;
}

export interface JoinRequest {
  workspace: string;
  address: string;
  desk: string;
}

const LOOP_WINDOW_MS = 60_000;
const LOOP_LIMIT = 10;

const postInput = z.object({
  kind: z.enum(POST_KINDS),
  body: z.string().min(1),
  to: z.array(z.string()).optional(),
  replyTo: z.string().optional(),
  source: z.enum(["user", "desk"]).optional(),
  reliesOn: z.string().optional(),
});

const postSchema = z.object({
  id: z.string(),
  author: z.string(),
  kind: z.enum(POST_KINDS),
  body: z.string(),
  replyTo: z.string().nullable(),
  root: z.string(),
  to: z.array(z.string()),
  source: z.enum(["user", "desk"]).nullable(),
  reliesOn: z.string().nullable(),
  created: z.string(),
});

const RANK: Record<Trust, number> = { untrusted: 0, trusted: 1, local: 2 };

type Row = Record<string, SQLOutputValue>;

function toPost(row: Row): Post {
  return {
    id: String(row.id),
    author: String(row.author),
    kind: String(row.kind) as PostKind,
    body: String(row.body),
    replyTo: row.reply_to === null ? null : String(row.reply_to),
    root: String(row.root),
    to: JSON.parse(String(row.to_json)) as string[],
    source: row.source === null ? null : (String(row.source) as "user" | "desk"),
    reliesOn: row.relies_on === null ? null : String(row.relies_on),
    created: String(row.created),
  };
}

export class Workspaces {
  batchMs = 2_000;
  private readonly buffers = new Map<string, { posts: Post[]; timer: NodeJS.Timeout }>();
  private readonly wakes = new Map<string, { times: number[]; skipped: boolean }>();

  constructor(private readonly bridge: Bridge) {
    bridge.store.db.exec(`
      CREATE TABLE IF NOT EXISTS ws_workspaces (name TEXT PRIMARY KEY, desk TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ws_members (
        workspace TEXT NOT NULL, address TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        fingerprint TEXT, read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace, address)
      );
      CREATE TABLE IF NOT EXISTS ws_posts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL, author TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT, root TEXT NOT NULL, to_json TEXT NOT NULL,
        source TEXT, relies_on TEXT, created TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ws_follows (workspace TEXT NOT NULL, root TEXT NOT NULL, address TEXT NOT NULL,
        PRIMARY KEY (workspace, root, address));
      CREATE TABLE IF NOT EXISTS ws_remote (workspace TEXT NOT NULL, host TEXT NOT NULL, agent TEXT NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace, host, agent));
    `);
  }

  private get db() {
    return this.bridge.store.db;
  }

  private get me(): string {
    return this.bridge.identity.node;
  }

  trust(host: string, author: string): Trust {
    const of = (node: string): Trust => {
      if (node === this.me) return "local";
      const peer = this.bridge.store.peer(node);
      return peer !== undefined && this.bridge.store.level(peer.fingerprint) === "trusted" ? "trusted" : "untrusted";
    };
    const [a, b] = [of(host), of(nodeOf(author))];
    return RANK[a] <= RANK[b] ? a : b;
  }

  private async locate(ref: string): Promise<{ name: string; host: string }> {
    const at = ref.indexOf("@");
    const name = at === -1 ? ref : ref.slice(0, at);
    assertName("workspace", name);
    if (at === -1) return { name, host: this.me };
    const target = ref.slice(at + 1);
    if (target === this.me || this.bridge.store.peer(target) !== undefined) return { name, host: target };
    return { name, host: await this.bridge.contact(target) };
  }

  private hostPeer(host: string): Peer {
    const peer = this.bridge.store.peer(host);
    if (peer === undefined) throw new Error(`machine "${host}" is not known here`);
    return peer;
  }

  private async remote(host: string, op: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await peerRequest(this.hostPeer(host), this.bridge.identity, "POST", `/workspaces/${op}`, { json: body });
    const parsed: unknown = JSON.parse(response.body || "{}");
    if (response.status !== 200) {
      const error = z.object({ error: z.string() }).safeParse(parsed);
      throw new Error(error.success ? error.data.error : `HTTP ${response.status}`);
    }
    return parsed;
  }

  private hosted(name: string): { desk: string } {
    const row = this.db.prepare("SELECT desk FROM ws_workspaces WHERE name = ?").get(name);
    if (row === undefined) throw new PeerError(404, `no workspace "${name}" here`);
    return { desk: String(row.desk) };
  }

  private member(name: string, address: string): { mode: Mode; status: string; readSeq: number } | undefined {
    const row = this.db.prepare("SELECT * FROM ws_members WHERE workspace = ? AND address = ?").get(name, address);
    return row && { mode: String(row.mode) as Mode, status: String(row.status), readSeq: Number(row.read_seq) };
  }

  private requireMember(name: string, address: string): void {
    this.hosted(name);
    if (this.member(name, address)?.status !== "joined") throw new PeerError(403, `${address} is not a member of "${name}"`);
  }

  create(agent: string, name: string): string {
    assertName("workspace", name);
    const address = this.bridge.address(agent);
    const created = this.db
      .prepare("INSERT OR IGNORE INTO ws_workspaces (name, desk, created) VALUES (?, ?, ?)")
      .run(name, address, now()).changes;
    if (created === 0) throw new Error(`workspace "${name}" already exists here; join it instead`);
    this.addMember(name, address, "all", "joined", null);
    return `${name}@${this.me}`;
  }

  private addMember(name: string, address: string, mode: Mode, status: string, fingerprint: string | null): void {
    this.db
      .prepare(
        `INSERT INTO ws_members (workspace, address, mode, status, fingerprint, read_seq)
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) FROM ws_posts WHERE workspace = ?))
         ON CONFLICT (workspace, address) DO UPDATE SET status = CASE WHEN ws_members.status = 'joined' THEN 'joined' ELSE excluded.status END`,
      )
      .run(name, address, mode, status, fingerprint, name);
  }

  hostJoin(name: string, address: string, peer?: Peer): "joined" | "pending" {
    this.hosted(name);
    const level = peer === undefined ? "trusted" : this.bridge.store.level(peer.fingerprint);
    const joined = peer === undefined || (peer.verified && (level === "known" || level === "trusted"));
    this.addMember(name, address, "mentions", joined ? "joined" : "pending", peer?.fingerprint ?? null);
    const status = this.member(name, address)!.status as "joined" | "pending";
    if (status === "pending") this.bridge.emit("workspace-join", { workspace: name, address, desk: this.hosted(name).desk });
    return status;
  }

  pendingJoins(): JoinRequest[] {
    return this.db
      .prepare(`SELECT m.workspace, m.address, w.desk FROM ws_members m JOIN ws_workspaces w ON w.name = m.workspace WHERE m.status = 'pending'`)
      .all()
      .map((r) => ({ workspace: String(r.workspace), address: String(r.address), desk: String(r.desk) }));
  }

  acceptJoin(address: string): string[] {
    const rows = this.db.prepare("SELECT workspace, fingerprint FROM ws_members WHERE address = ? AND status = 'pending'").all(address);
    for (const row of rows) {
      if (row.fingerprint !== null) this.bridge.claimName(String(row.fingerprint));
      this.db.prepare("UPDATE ws_members SET status = 'joined' WHERE workspace = ? AND address = ?").run(String(row.workspace), address);
    }
    return rows.map((r) => String(r.workspace));
  }

  hostLeave(name: string, address: string): void {
    this.db.prepare("DELETE FROM ws_members WHERE workspace = ? AND address = ?").run(name, address);
    this.db.prepare("DELETE FROM ws_follows WHERE workspace = ? AND address = ?").run(name, address);
  }

  hostMode(name: string, address: string, mode: Mode): void {
    this.requireMember(name, address);
    this.db.prepare("UPDATE ws_members SET mode = ? WHERE workspace = ? AND address = ?").run(mode, name, address);
  }

  hostFollow(name: string, address: string, postId: string, on: boolean): void {
    this.requireMember(name, address);
    const root = this.post(name, postId).root;
    if (on) this.db.prepare("INSERT OR IGNORE INTO ws_follows VALUES (?, ?, ?)").run(name, root, address);
    else this.db.prepare("DELETE FROM ws_follows WHERE workspace = ? AND root = ? AND address = ?").run(name, root, address);
  }

  setDesk(name: string, agent: string): void {
    const address = agent.includes("/") ? agent : this.bridge.address(agent);
    if (this.member(name, address)?.status !== "joined") throw new Error(`${address} is not a member of "${name}"`);
    this.db.prepare("UPDATE ws_workspaces SET desk = ? WHERE name = ?").run(address, name);
  }

  private post(name: string, id: string): Post {
    const row = this.db.prepare("SELECT * FROM ws_posts WHERE workspace = ? AND id = ?").get(name, id);
    if (row === undefined) throw new PeerError(404, `no post ${id} in "${name}"`);
    return toPost(row);
  }

  hostPost(name: string, author: string, payload: unknown): Post {
    this.requireMember(name, author);
    const parsed = postInput.safeParse(payload);
    if (!parsed.success) throw new PeerError(400, parsed.error.message);
    const input = parsed.data;
    if (Buffer.byteLength(input.body) > MAX_BODY_BYTES) throw new PeerError(413, "post too large");
    const parent = input.replyTo === undefined ? undefined : this.post(name, input.replyTo);
    if (input.kind === "answer" && parent?.kind !== "question") throw new PeerError(400, "an answer must reply to a question");
    if (input.kind === "answer" && input.source === undefined) throw new PeerError(400, 'an answer needs source "user" or "desk"');
    const to = (input.to ?? []).map((t) => (t.includes("/") ? t : `${nodeOf(author)}/${t}`));
    for (const t of to) splitAddress(t);
    const id = newId();
    const post: Post = {
      id,
      author,
      kind: input.kind,
      body: input.body,
      replyTo: parent?.id ?? null,
      root: parent?.root ?? id,
      to,
      source: input.kind === "answer" ? (input.source ?? null) : null,
      reliesOn: input.kind === "answer" ? (input.reliesOn ?? null) : null,
      created: now(),
    };
    this.db
      .prepare(
        `INSERT INTO ws_posts (id, workspace, author, kind, body, reply_to, root, to_json, source, relies_on, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(post.id, name, author, post.kind, post.body, post.replyTo, post.root, JSON.stringify(to), post.source, post.reliesOn, post.created);
    const { desk } = this.hosted(name);
    const followers = [author, ...to, ...(post.kind === "question" ? [desk] : [])];
    for (const f of followers) this.db.prepare("INSERT OR IGNORE INTO ws_follows VALUES (?, ?, ?)").run(name, post.root, f);
    this.distribute(name, post, desk);
    return post;
  }

  private distribute(name: string, post: Post, desk: string): void {
    const following = new Set(
      this.db
        .prepare("SELECT address FROM ws_follows WHERE workspace = ? AND root = ?")
        .all(name, post.root)
        .map((r) => String(r.address)),
    );
    const members = this.db.prepare("SELECT address, mode FROM ws_members WHERE workspace = ? AND status = 'joined'").all(name);
    for (const m of members) {
      const address = String(m.address);
      if (address === post.author) continue;
      const wake =
        m.mode === "all" || post.to.includes(address) || following.has(address) || (post.kind === "question" && address === desk);
      const { node, agent } = splitAddress(address);
      if (node === this.me) this.notice(name, this.me, agent, post, wake);
      else {
        const peer = this.bridge.store.peer(node);
        if (peer === undefined) continue;
        void peerRequest(peer, this.bridge.identity, "POST", "/workspaces/notify", {
          json: { workspace: name, agent, post, wake },
        }).catch(() => {});
      }
    }
  }

  hostRead(name: string, address: string, all: boolean): Post[] {
    this.requireMember(name, address);
    const from = all ? 0 : this.member(name, address)!.readSeq;
    const rows = this.db.prepare("SELECT * FROM ws_posts WHERE workspace = ? AND seq > ? ORDER BY seq").all(name, from);
    this.db
      .prepare("UPDATE ws_members SET read_seq = (SELECT COALESCE(MAX(seq), 0) FROM ws_posts WHERE workspace = ?) WHERE workspace = ? AND address = ?")
      .run(name, name, address);
    return rows.map(toPost);
  }

  hostQuestions(name: string): Post[] {
    this.hosted(name);
    return this.db
      .prepare(
        `SELECT * FROM ws_posts q WHERE q.workspace = ? AND q.kind = 'question'
         AND NOT EXISTS (SELECT 1 FROM ws_posts a WHERE a.workspace = q.workspace AND a.kind = 'answer' AND a.reply_to = q.id)
         ORDER BY q.seq`,
      )
      .all(name)
      .map(toPost);
  }

  hostInfo(name: string): { desk: string; members: { address: string; mode: Mode; status: string }[] } {
    const { desk } = this.hosted(name);
    const members = this.db
      .prepare("SELECT address, mode, status FROM ws_members WHERE workspace = ? ORDER BY address")
      .all(name)
      .map((r) => ({ address: String(r.address), mode: String(r.mode) as Mode, status: String(r.status) }));
    return { desk, members };
  }

  private unreadLocal(name: string, address: string): number {
    const m = this.member(name, address);
    if (m === undefined) return 0;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM ws_posts WHERE workspace = ? AND seq > ? AND author != ?")
      .get(name, m.readSeq, address);
    return Number(row?.n ?? 0);
  }

  notice(name: string, host: string, agent: string, post: Post, wake: boolean): void {
    if (host !== this.me) {
      this.db.prepare("UPDATE ws_remote SET unread = unread + 1 WHERE workspace = ? AND host = ? AND agent = ?").run(name, host, agent);
    }
    if (!wake) return;
    const key = `${agent}\u0000${name}\u0000${host}`;
    const buffer = this.buffers.get(key);
    if (buffer !== undefined) {
      buffer.posts.push(post);
      return;
    }
    const timer = setTimeout(() => this.flush(key, agent, name, host), this.batchMs);
    timer.unref();
    this.buffers.set(key, { posts: [post], timer });
  }

  receiveNotice(peer: Peer, payload: unknown): void {
    const parsed = z.object({ workspace: z.string(), agent: z.string(), post: postSchema, wake: z.boolean() }).safeParse(payload);
    if (!parsed.success) throw new PeerError(400, parsed.error.message);
    const { workspace, agent, post, wake } = parsed.data;
    const row = this.db.prepare("SELECT 1 FROM ws_remote WHERE workspace = ? AND host = ? AND agent = ?").get(workspace, peer.node, agent);
    if (row === undefined) throw new PeerError(404, `${agent} is not in workspace ${workspace}@${peer.node}`);
    this.notice(workspace, peer.node, agent, post, wake);
  }

  private flush(key: string, agent: string, name: string, host: string): void {
    const buffer = this.buffers.get(key);
    this.buffers.delete(key);
    if (buffer === undefined) return;
    const state = this.wakes.get(agent) ?? { times: [], skipped: false };
    const cutoff = Date.now() - LOOP_WINDOW_MS;
    state.times = state.times.filter((t) => t > cutoff);
    this.wakes.set(agent, state);
    if (state.times.length >= LOOP_LIMIT) {
      state.skipped = true;
      return;
    }
    state.times.push(Date.now());
    const total = this.unread(agent).reduce((sum, u) => sum + u.unread, 0);
    const wakeEvent: WorkspaceWake = {
      agent,
      workspace: name,
      host,
      posts: buffer.posts,
      more: Math.max(0, total - buffer.posts.length),
      skipped: state.skipped,
    };
    state.skipped = false;
    this.bridge.emit("workspace", wakeEvent);
  }

  unread(agent: string): { workspace: string; unread: number }[] {
    const address = this.bridge.address(agent);
    const local = this.db
      .prepare("SELECT workspace FROM ws_members WHERE address = ? AND status = 'joined'")
      .all(address)
      .map((r) => ({ workspace: `${String(r.workspace)}@${this.me}`, unread: this.unreadLocal(String(r.workspace), address) }));
    const remote = this.db
      .prepare("SELECT workspace, host, unread FROM ws_remote WHERE agent = ?")
      .all(agent)
      .map((r) => ({ workspace: `${String(r.workspace)}@${String(r.host)}`, unread: Number(r.unread) }));
    return [...local, ...remote].filter((u) => u.unread > 0);
  }

  unreadLine(agent: string): string | undefined {
    const parts = this.unread(agent).map((u) => `${u.unread} in ${u.workspace}`);
    return parts.length === 0 ? undefined : `Unread workspace posts: ${parts.join(", ")} (read them with workspace_read).`;
  }

  async join(agent: string, ref: string): Promise<{ workspace: string; status: string }> {
    const { name, host } = await this.locate(ref);
    const address = this.bridge.address(agent);
    if (host === this.me) return { workspace: `${name}@${host}`, status: this.hostJoin(name, address) };
    this.db.prepare("INSERT OR IGNORE INTO ws_remote (workspace, host, agent) VALUES (?, ?, ?)").run(name, host, agent);
    const { status } = z.object({ status: z.string() }).parse(await this.remote(host, "join", { workspace: name, agent }));
    return { workspace: `${name}@${host}`, status };
  }

  async leave(agent: string, ref: string): Promise<void> {
    const { name, host } = await this.locate(ref);
    if (host === this.me) return this.hostLeave(name, this.bridge.address(agent));
    await this.remote(host, "leave", { workspace: name, agent });
    this.db.prepare("DELETE FROM ws_remote WHERE workspace = ? AND host = ? AND agent = ?").run(name, host, agent);
  }

  async publish(agent: string, ref: string, input: PostInput): Promise<Post> {
    const { name, host } = await this.locate(ref);
    const to = input.to?.map((t) => (t.includes("/") ? t : this.bridge.address(t)));
    const payload = { ...input, to };
    if (host === this.me) return this.hostPost(name, this.bridge.address(agent), payload);
    return postSchema.parse(await this.remote(host, "post", { workspace: name, agent, input: payload }));
  }

  async read(agent: string, ref: string, all: boolean): Promise<(Post & { trust: Trust })[]> {
    const { name, host } = await this.locate(ref);
    const posts =
      host === this.me
        ? this.hostRead(name, this.bridge.address(agent), all)
        : z.array(postSchema).parse(await this.remote(host, "read", { workspace: name, agent, all }));
    if (host !== this.me) this.db.prepare("UPDATE ws_remote SET unread = 0 WHERE workspace = ? AND host = ? AND agent = ?").run(name, host, agent);
    return posts.map((p) => ({ ...p, trust: this.trust(host, p.author) }));
  }

  async mode(agent: string, ref: string, mode: Mode): Promise<void> {
    const { name, host } = await this.locate(ref);
    if (host === this.me) return this.hostMode(name, this.bridge.address(agent), mode);
    await this.remote(host, "mode", { workspace: name, agent, mode });
  }

  async follow(agent: string, ref: string, postId: string, on: boolean): Promise<void> {
    const { name, host } = await this.locate(ref);
    if (host === this.me) return this.hostFollow(name, this.bridge.address(agent), postId, on);
    await this.remote(host, "follow", { workspace: name, agent, post: postId, on });
  }

  async list(agent: string): Promise<{ workspace: string; desk?: string; members?: unknown; unread: number; error?: string }[]> {
    const address = this.bridge.address(agent);
    const unread = new Map(this.unread(agent).map((u) => [u.workspace, u.unread]));
    const local = this.db
      .prepare("SELECT workspace FROM ws_members WHERE address = ?")
      .all(address)
      .map((r) => String(r.workspace))
      .map((name) => ({ workspace: `${name}@${this.me}`, ...this.hostInfo(name), unread: unread.get(`${name}@${this.me}`) ?? 0 }));
    const remotes = this.db.prepare("SELECT workspace, host FROM ws_remote WHERE agent = ?").all(agent);
    const remote = await Promise.all(
      remotes.map(async (r) => {
        const ref = `${String(r.workspace)}@${String(r.host)}`;
        try {
          const info = await this.remote(String(r.host), "info", { workspace: String(r.workspace), agent });
          return { workspace: ref, ...(info as object), unread: unread.get(ref) ?? 0 };
        } catch (error) {
          return { workspace: ref, unread: unread.get(ref) ?? 0, error: String(error) };
        }
      }),
    );
    return [...local, ...remote];
  }

  async questions(): Promise<{ workspace: string; post: Post }[]> {
    const local = this.db
      .prepare("SELECT name FROM ws_workspaces ORDER BY name")
      .all()
      .flatMap((r) => this.hostQuestions(String(r.name)).map((post) => ({ workspace: `${String(r.name)}@${this.me}`, post })));
    const remotes = this.db.prepare("SELECT DISTINCT workspace, host FROM ws_remote").all();
    const remote = await Promise.all(
      remotes.map(async (r) => {
        const posts = await this.remote(String(r.host), "questions", { workspace: String(r.workspace) }).catch(() => []);
        return z
          .array(postSchema)
          .catch([])
          .parse(posts)
          .map((post) => ({ workspace: `${String(r.workspace)}@${String(r.host)}`, post }));
      }),
    );
    return [...local, ...remote.flat()];
  }

  async answerAsUser(agent: string, questionId: string, text: string): Promise<{ workspace: string; post: Post }> {
    const question = (await this.questions()).find((q) => q.post.id === questionId);
    if (question === undefined) throw new Error(`no open question ${questionId}`);
    const joined = await this.join(agent, question.workspace);
    if (joined.status !== "joined") throw new Error(`${this.bridge.address(agent)} is waiting to be let into ${question.workspace}`);
    const post = await this.publish(agent, question.workspace, { kind: "answer", body: text, replyTo: questionId, source: "user" });
    return { workspace: question.workspace, post };
  }

  handlePeer(peer: Peer, op: string, payload: unknown): unknown {
    const body = z.object({ workspace: z.string(), agent: z.string().optional() }).passthrough().safeParse(payload);
    if (!body.success) throw new PeerError(400, body.error.message);
    const { workspace } = body.data;
    if (op === "questions") {
      this.requireAnyMemberFrom(workspace, peer);
      return this.hostQuestions(workspace);
    }
    if (op === "notify") {
      this.receiveNotice(peer, payload);
      return { ok: true };
    }
    const agent = body.data.agent;
    if (agent === undefined) throw new PeerError(400, "agent is required");
    assertName("agent", agent);
    const address = `${peer.node}/${agent}`;
    const extra = body.data as Record<string, unknown>;
    switch (op) {
      case "join":
        return { status: this.hostJoin(workspace, address, peer) };
      case "leave":
        this.hostLeave(workspace, address);
        return { ok: true };
      case "post":
        return this.hostPost(workspace, address, extra.input);
      case "read":
        return this.hostRead(workspace, address, extra.all === true);
      case "mode":
        this.hostMode(workspace, address, z.enum(MODES).parse(extra.mode));
        return { ok: true };
      case "follow":
        this.hostFollow(workspace, address, z.string().parse(extra.post), extra.on === true);
        return { ok: true };
      case "info":
        this.requireMember(workspace, address);
        return this.hostInfo(workspace);
      default:
        throw new PeerError(404, "not found");
    }
  }

  private requireAnyMemberFrom(name: string, peer: Peer): void {
    this.hosted(name);
    const row = this.db
      .prepare("SELECT 1 FROM ws_members WHERE workspace = ? AND status = 'joined' AND substr(address, 1, length(?) + 1) = ? || '/'")
      .get(name, peer.node, peer.node);
    if (row === undefined) throw new PeerError(403, `no agent of ${peer.node} is in "${name}"`);
  }
}
