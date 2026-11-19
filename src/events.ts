import { z } from "zod";
import type { Config } from "./config.js";

const pushEvent = z.object({ content: z.string(), meta: z.record(z.string(), z.string()) });

export type PushEvent = z.infer<typeof pushEvent>;

export const AGENT_HEADER = "x-agent-bridge-agent";

export async function* readEvents(config: Config, agent: string, signal?: AbortSignal): AsyncGenerator<PushEvent> {
  const response = await fetch(`http://127.0.0.1:${config.mcpPort}/events`, {
    headers: { authorization: `Bearer ${config.adminToken}`, [AGENT_HEADER]: agent },
    signal,
  });
  if (!response.ok || response.body === null) throw new Error(`event stream refused: HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (frame.startsWith("data: ")) yield pushEvent.parse(JSON.parse(frame.slice(6)));
      end = buffer.indexOf("\n\n");
    }
  }
}

const completion = z.array(z.object({ label: z.string(), value: z.string(), description: z.string() }));

export async function sendCommand(config: Config, agent: string, text: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${config.mcpPort}/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.adminToken}`, [AGENT_HEADER]: agent, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`agent-bridge refused the command: HTTP ${response.status}`);
  return z.object({ text: z.string() }).parse(await response.json()).text;
}

export async function completeCommand(config: Config, agent: string, prefix: string): Promise<z.infer<typeof completion>> {
  const url = new URL(`http://127.0.0.1:${config.mcpPort}/complete`);
  url.searchParams.set("prefix", prefix);
  const response = await fetch(url, { headers: { authorization: `Bearer ${config.adminToken}`, [AGENT_HEADER]: agent } });
  return response.ok ? completion.parse(await response.json()) : [];
}
