import { setTimeout as sleep } from "node:timers/promises";
import { dataDir, defaultAgentName, ensureSetup } from "./config.js";
import { completeCommand, pushEvent, renderEvent, sendCommand } from "./events.js";
import { connectionRefused, startDetachedDaemon } from "./launch.js";
import { USAGE } from "./usage.js";

interface McpNotification {
  server: string;
  method: string;
  params: unknown;
}

interface CommandContext {
  cwd: string;
}

interface Completion {
  label: string;
  value: string;
  description: string;
}

interface OmpExtensionApi {
  on(event: "mcp_notification", handler: (event: McpNotification) => void): void;
  sendUserMessage(content: string, options: { deliverAs: "aside"; attribution: "agent" }): void;
  sendMessage(message: { customType: string; content: string; display: boolean }): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: CommandContext) => Promise<void>;
      getArgumentCompletions: (prefix: string) => Promise<Completion[] | null>;
    },
  ): void;
}

async function run(agent: string, text: string): Promise<string> {
  const dir = dataDir();
  const config = await ensureSetup(dir);
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendCommand(config, agent, text);
    } catch (error) {
      if (!connectionRefused(error) || attempt === 25) throw error;
      if (attempt === 0) startDetachedDaemon(dir);
      await sleep(200);
    }
  }
}

export default function agentBridge(pi: OmpExtensionApi): void {
  let agent = defaultAgentName();

  pi.on("mcp_notification", (event) => {
    if (event.method !== "notifications/claude/channel") return;
    const parsed = pushEvent.safeParse(event.params);
    if (!parsed.success || parsed.data.meta.bridge !== "agent-bridge") return;
    pi.sendUserMessage(renderEvent(parsed.data), {
      deliverAs: "aside",
      attribution: "agent",
    });
  });

  pi.registerCommand("bridge", {
    description: `agent-bridge: ${USAGE}`,
    async handler(args, ctx) {
      agent = defaultAgentName(ctx.cwd);
      const text = await run(agent, args).catch((error: unknown) => `agent-bridge failed: ${error}`);
      pi.sendMessage({ customType: "agent-bridge", content: text, display: true });
    },
    async getArgumentCompletions(prefix) {
      const config = await ensureSetup(dataDir());
      const items = await completeCommand(config, agent, prefix).catch(() => []);
      return items.length > 0 ? items : null;
    },
  });
}
