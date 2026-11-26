import type { Bridge } from "./bridge.js";
import { saveConfig } from "./config.js";
import { resolveListen } from "./discovery.js";
import { MACHINE_LEVELS, type MachineLevel } from "./store.js";
import { SUBCOMMANDS } from "./usage.js";

export interface Completion {
  label: string;
  value: string;
  description: string;
}

const LEVEL_DESCRIPTIONS: Record<MachineLevel, string> = {
  unknown: "forget it; each new conversation needs accept",
  known: "accept its conversations automatically; messages stay information",
  trusted: "your own machine: its agents are treated as colleagues",
  blocked: "refuse everything from it",
};

function help(): string {
  return ["Usage:", ...Object.values(SUBCOMMANDS).map((s) => `  /bridge ${s.usage}  — ${s.description}`)].join("\n");
}

function machines(bridge: Bridge, agent: string): string {
  const address = bridge.address(agent);
  const lines = [`You are ${address}.`, "", "Machines:"];
  const peers = bridge.store.peers();
  for (const p of peers) lines.push(`  ${p.node}  ${bridge.store.level(p.fingerprint)}  ${p.url}  ${p.fingerprint}`);
  if (peers.length === 0) lines.push("  none yet");
  const waiting = bridge.store.conversationRequests(address);
  if (waiting.length > 0) {
    lines.push("", "Waiting for you to accept:");
    for (const r of waiting) lines.push(`  thread ${r.thread} from ${r.from} (${r.fingerprint}), "${r.subject}", ${r.held} held`);
  }
  return lines.join("\n");
}

function accept(bridge: Bridge, agent: string, target: string | undefined): string {
  const address = bridge.address(agent);
  const waiting = bridge.store.conversationRequests(address);
  const byThread = target !== undefined && waiting.some((r) => r.thread === target);
  const matching = waiting.filter((r) => target === undefined || byThread || r.node === target);
  if (!byThread && target !== undefined && new Set(matching.map((r) => r.fingerprint)).size > 1) {
    return `More than one machine calls itself "${target}"; accept by thread id after checking the certificate:\n${machines(bridge, agent)}`;
  }
  const threads = byThread ? [target!] : [...new Set(matching.map((r) => r.thread))];
  if (threads.length === 0) return `Nothing ${target ? `from "${target}" ` : ""}is waiting for ${address}.`;
  if (target === undefined && threads.length > 1) {
    return `Several conversations are waiting; give a thread id or machine name.\n${machines(bridge, agent)}`;
  }
  return threads
    .map((thread) => {
      try {
        const { peers, released } = bridge.accept(agent, thread);
        return `Accepted thread ${thread} with ${peers.join(", ")}; ${released} held message(s) delivered.`;
      } catch (error) {
        return `Could not accept thread ${thread}: ${error instanceof Error ? error.message : error}`;
      }
    })
    .join("\n");
}

function machine(bridge: Bridge, name: string | undefined, level: string | undefined, fingerprint: string | undefined): string {
  if (name === undefined || !MACHINE_LEVELS.includes(level as MachineLevel)) return `Usage: /bridge ${SUBCOMMANDS.machine.usage}`;
  const { fingerprint: chosen, released } = bridge.setMachineLevel(name, level as MachineLevel, fingerprint);
  const delivered = released > 0 ? ` ${released} held message(s) delivered.` : "";
  return `Machine "${name}" (${chosen}) is now ${level}: ${LEVEL_DESCRIPTIONS[level as MachineLevel]}.${delivered}`;
}

function workspace(bridge: Bridge, agent: string, args: string[]): string {
  if (args[0] === "new" && args[1] !== undefined) {
    return `Created workspace ${bridge.workspaces.create(agent, args[1])}; ${bridge.address(agent)} is its desk.`;
  }
  if (args[1] === "desk" && args[2] !== undefined) {
    bridge.workspaces.setDesk(args[0], args[2]);
    return `The desk of workspace ${args[0]} is now ${args[2]}.`;
  }
  if (args.length > 0) return `Usage: /bridge ${SUBCOMMANDS.workspace.usage}`;
  const hosted = bridge.store.db.prepare("SELECT name FROM ws_workspaces ORDER BY name").all();
  if (hosted.length === 0) return "No workspaces on this machine.";
  return hosted
    .map((r) => {
      const info = bridge.workspaces.hostInfo(String(r.name));
      const members = info.members.map((m) => `${m.address}${m.status === "pending" ? " (waiting)" : ` (${m.mode})`}`);
      return `${String(r.name)}: desk ${info.desk}; ${info.openTodos} open todo(s); ${members.join(", ")}`;
    })
    .join("\n");
}

async function questions(bridge: Bridge): Promise<string> {
  const open = await bridge.workspaces.questions();
  if (open.length === 0) return "No open questions.";
  return open.map((q) => `${q.post.id}  ${q.workspace}  ${q.post.author}: ${q.post.body}`).join("\n");
}

async function todos(bridge: Bridge, ref: string | undefined): Promise<string> {
  const open = (await bridge.workspaces.allTodos(false)).filter((t) => ref === undefined || t.workspace === ref || t.workspace.startsWith(`${ref}@`));
  if (open.length === 0) return `No open todos${ref === undefined ? "" : ` in ${ref}`}.`;
  return open
    .map(({ workspace, todo }) => `${todo.id}  ${workspace}  ${todo.text}  (${todo.source === "user" ? "you" : `${todo.addedBy}, ${todo.trust}`})`)
    .join("\n");
}

const TODO_ACTIONS = { done: ["done", "Ticked off"], undo: ["reopen", "Reopened"], drop: ["remove", "Removed"] } as const;

export async function runCommand(bridge: Bridge, agent: string, text: string): Promise<string> {
  const [sub, ...args] = text.trim().split(/\s+/).filter(Boolean);
  try {
    switch (sub) {
      case undefined:
        return `${machines(bridge, agent)}\n\n${help()}`;
      case "machines":
        return machines(bridge, agent);
      case "machine":
        return machine(bridge, args[0], args[1], args[2]);
      case "accept": {
        if (args[0]?.includes("/")) {
          const joined = bridge.workspaces.acceptJoin(args[0]);
          return joined.length === 0 ? `${args[0]} is not waiting to join a workspace here.` : `${args[0]} joined ${joined.join(", ")}.`;
        }
        return accept(bridge, agent, args[0]);
      }
      case "workspace":
        return workspace(bridge, agent, args);
      case "questions":
        return await questions(bridge);
      case "answer": {
        const [id, ...words] = args;
        if (id === undefined || words.length === 0) return `Usage: /bridge ${SUBCOMMANDS.answer.usage}`;
        const answered = await bridge.workspaces.answerAsUser(agent, id, text.trim().split(/\s+/).slice(2).join(" "));
        return `Answered question ${id} in ${answered.workspace}.`;
      }
      case "todo": {
        if (args.length < 2) return `Usage: /bridge ${SUBCOMMANDS.todo.usage}`;
        const added = await bridge.workspaces.addTodoAsUser(agent, args[0], text.trim().split(/\s+/).slice(2).join(" "));
        return `Added todo ${added.todo.id} to ${added.workspace}.`;
      }
      case "todos":
        return await todos(bridge, args[0]);
      case "done":
      case "undo":
      case "drop": {
        if (args[0] === undefined) return `Usage: /bridge ${SUBCOMMANDS[sub].usage}`;
        const [action, verb] = TODO_ACTIONS[sub];
        const changed = await bridge.workspaces.changeTodoAsUser(agent, args[0], action);
        return `${verb} "${changed.todo.text}" in ${changed.workspace}.`;
      }
      case "revoke":
        if (args[0] === undefined) return `Usage: /bridge ${SUBCOMMANDS.revoke.usage}`;
        return bridge.revoke(agent, args[0]) === 0
          ? `${bridge.address(agent)} has no conversation with thread id ${args[0]}.`
          : `Revoked thread ${args[0]}; new messages in it are held until accepted again.`;
      case "listen": {
        if (args[0] === undefined) return `Usage: /bridge ${SUBCOMMANDS.listen.usage}`;
        const ip = resolveListen(args[0]);
        saveConfig({ ...bridge.config(), listen: args[0] }, bridge.dir);
        setTimeout(() => bridge.emit("shutdown"), 100);
        return `agent-bridge now listens on ${args[0]} (${ip}); the daemon restarts on the next agent-bridge call.`;
      }
      case "restart":
        setTimeout(() => bridge.emit("shutdown"), 100);
        return "Restarting the agent-bridge daemon; it comes back on the next agent-bridge call.";
      default:
        return `Unknown command "${sub}".\n${help()}`;
    }
  } catch (error) {
    return `Failed: ${error instanceof Error ? error.message : error}`;
  }
}

export function completeCommand(bridge: Bridge, agent: string, prefix: string): Completion[] {
  const words = prefix.split(/\s+/);
  const current = words.pop() ?? "";
  const before = words.join(" ");
  const options = (items: Completion[]) =>
    items
      .filter((i) => i.label.startsWith(current))
      .map((i) => ({ ...i, value: before === "" ? i.value : `${before} ${i.value}` }));
  const [sub, first] = words;
  if (words.length === 0) {
    return options(Object.entries(SUBCOMMANDS).map(([name, s]) => ({ label: name, value: name, description: s.description })));
  }
  const machineNames = () =>
    bridge.store.peers().map((p) => ({ label: p.node, value: p.node, description: bridge.store.level(p.fingerprint) }));
  if (sub === "machine" && words.length === 1) return options(machineNames());
  if (sub === "machine" && words.length === 2 && first !== undefined) {
    return options(MACHINE_LEVELS.map((level) => ({ label: level, value: level, description: LEVEL_DESCRIPTIONS[level] })));
  }
  const waiting = () => bridge.store.conversationRequests(bridge.address(agent));
  if (sub === "accept" && words.length === 1) {
    return options([
      ...waiting().map((r) => ({ label: r.thread, value: r.thread, description: `${r.from}: ${r.subject}` })),
      ...[...new Set(waiting().map((r) => r.node))].map((node) => ({ label: node, value: node, description: "all from this machine" })),
    ]);
  }
  const hosted = () => bridge.store.db.prepare("SELECT name FROM ws_workspaces ORDER BY name").all().map((r) => String(r.name));
  if ((sub === "todo" || sub === "todos") && words.length === 1) {
    return options(hosted().map((name) => ({ label: name, value: name, description: "workspace" })));
  }
  if ((sub === "done" || sub === "undo" || sub === "drop") && words.length === 1) {
    return options(
      hosted().flatMap((name) =>
        bridge.workspaces
          .hostTodos(name, true)
          .filter((t) => t.done === (sub === "undo"))
          .map((t) => ({ label: t.id, value: t.id, description: `${name}: ${t.text}` })),
      ),
    );
  }
  if (sub === "revoke" && words.length === 1) {
    return options(
      bridge.store
        .conversations(agent)
        .filter((c) => c.status === "approved")
        .map((c) => ({ label: c.thread, value: c.thread, description: c.peer })),
    );
  }
  return [];
}
