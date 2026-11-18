import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ensureSetup, paths, type Config } from "./config.js";
import { AGENT_HEADER, readEvents } from "./events.js";
import { connectionRefused, startDetachedDaemon } from "./launch.js";

const DAEMON_START_TIMEOUT_MS = 15_000;

function headers(config: Config, agent: string): Record<string, string> {
  return { authorization: `Bearer ${config.adminToken}`, [AGENT_HEADER]: agent };
}

async function connect(config: Config, agent: string): Promise<Client> {
  const client = new Client({ name: "agent-bridge-stdio", version: "0.2.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.mcpPort}/mcp`), {
      requestInit: { headers: headers(config, agent) },
    }),
  );
  return client;
}

async function connectOrStartDaemon(config: Config, agent: string, dir: string): Promise<Client> {
  try {
    return await connect(config, agent);
  } catch {
    startDetachedDaemon(dir);
  }
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (true) {
    await sleep(200);
    try {
      return await connect(config, agent);
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`the agent-bridge daemon did not start; see ${paths(dir).log} (${error})`);
      }
    }
  }
}

export async function runStdioShim(agent: string, dir: string): Promise<void> {
  const config = await ensureSetup(dir);
  let client = await connectOrStartDaemon(config, agent, dir);

  const forward = async <T>(request: (client: Client) => Promise<T>): Promise<T> => {
    try {
      return await request(client);
    } catch (error) {
      if (!connectionRefused(error)) throw error;
      client = await connectOrStartDaemon(config, agent, dir);
      return request(client);
    }
  };

  const server = new Server(
    { name: "agent-bridge", version: "0.2.0" },
    {
      capabilities: { tools: {}, prompts: {}, experimental: { "claude/channel": {} } },
      instructions: client.getInstructions(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => forward((c) => c.listTools(request.params)));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    forward((c) => c.callTool(request.params, undefined, { timeout: (config.waitCapSeconds + 10) * 1000 })),
  );
  server.setRequestHandler(ListPromptsRequestSchema, (request) => forward((c) => c.listPrompts(request.params)));
  server.setRequestHandler(GetPromptRequestSchema, (request) => forward((c) => c.getPrompt(request.params)));
  await server.connect(new StdioServerTransport());

  void (async () => {
    while (true) {
      try {
        for await (const event of readEvents(config, agent)) {
          await server.notification({ method: "notifications/claude/channel", params: event });
        }
      } catch (error) {
        if (connectionRefused(error)) client = await connectOrStartDaemon(config, agent, dir).catch(() => client);
      }
      await sleep(1000);
    }
  })();
}
