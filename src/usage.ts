export const SUBCOMMANDS: Record<string, { usage: string; description: string }> = {
  machines: { usage: "machines", description: "list machines with their level, and conversations waiting for you" },
  machine: { usage: "machine <name> <unknown|known|trusted|blocked> [fingerprint]", description: "set a machine's level" },
  accept: { usage: "accept [thread|machine|node/agent]", description: "accept a waiting conversation or workspace join" },
  revoke: { usage: "revoke <thread>", description: "stop a conversation" },
  listen: { usage: "listen <interface|ip>", description: "where other machines reach this one; restarts the daemon" },
  workspace: { usage: "workspace [new <name> | <name> desk <agent>]", description: "list workspaces, create one, or set its desk" },
  questions: { usage: "questions", description: "open user questions in all workspaces" },
  answer: { usage: "answer <question id> <text>", description: "answer a workspace question as the user" },
  todo: { usage: "todo <workspace> <text>", description: "add a todo to a workspace" },
  todos: { usage: "todos [workspace]", description: "open todos in one or all workspaces" },
  done: { usage: "done <todo id>", description: "tick off a workspace todo" },
  undo: { usage: "undo <todo id>", description: "reopen a workspace todo" },
  drop: { usage: "drop <todo id>", description: "remove a workspace todo" },
  restart: { usage: "restart", description: "restart the daemon, e.g. after an update" },
};

export const USAGE = Object.values(SUBCOMMANDS)
  .map((s) => s.usage)
  .join(" · ");

