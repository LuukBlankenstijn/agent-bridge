import { parseArgs } from "node:util";
import { assertName, assertNodeVersion, dataDir, defaultAgentName, ensureSetup } from "./config.js";
import { startDaemon } from "./daemon.js";
import { runStdioShim } from "./shim.js";

const USAGE = `agent-bridge: mailbox for AI agents, exposed over MCP

  agent-bridge [mcp] [--agent NAME]   MCP server (stdio) for one agent; NAME defaults to the current folder name.
                                      Starts the background daemon when it is not running.
  agent-bridge daemon                 run the daemon in the foreground

Data lives in ${dataDir()} (override with AGENT_BRIDGE_HOME).`;

async function main(): Promise<void> {
  assertNodeVersion();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { agent: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const command = positionals[0] ?? "mcp";
  const dir = dataDir();

  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "mcp") {
    const agent = values.agent ?? defaultAgentName();
    assertName("agent", agent);
    await runStdioShim(agent, dir);
    return;
  }

  if (command === "daemon") {
    await ensureSetup(dir);
    const daemon = await startDaemon(dir);
    const config = daemon.bridge.config();
    console.error(
      `agent-bridge daemon for machine "${config.node}": peers on ${config.listen}:${config.peerPort}, ` +
        `agents on 127.0.0.1:${config.mcpPort}`,
    );
    const stop = () => void daemon.close().then(() => process.exit(0));
    daemon.bridge.on("shutdown", stop);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  throw new Error(`unknown command "${command}"\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
