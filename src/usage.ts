export const SUBCOMMANDS: Record<string, { usage: string; description: string }> = {
  machines: { usage: "machines", description: "list machines with their level, and conversations waiting for you" },
  machine: { usage: "machine <name> <unknown|known|trusted|blocked> [fingerprint]", description: "set a machine's level" },
  accept: { usage: "accept [thread|machine]", description: "accept a waiting conversation" },
  revoke: { usage: "revoke <thread>", description: "stop a conversation" },
  listen: { usage: "listen <interface|ip>", description: "where other machines reach this one; restarts the daemon" },
  restart: { usage: "restart", description: "restart the daemon, e.g. after an update" },
};

export const USAGE = Object.values(SUBCOMMANDS)
  .map((s) => s.usage)
  .join(" · ");

