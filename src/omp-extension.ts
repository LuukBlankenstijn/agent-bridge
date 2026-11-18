interface McpNotification {
  server: string;
  method: string;
  params: unknown;
}

interface OmpExtensionApi {
  on(event: "mcp_notification", handler: (event: McpNotification) => void): void;
  sendUserMessage(content: string, options: { deliverAs: "aside"; attribution: "agent" }): void;
}

function isBridgeEvent(params: unknown): params is { content: string; meta: { bridge: string; kind: string } } {
  if (typeof params !== "object" || params === null || !("content" in params) || !("meta" in params)) return false;
  const { content, meta } = params;
  return typeof content === "string" && typeof meta === "object" && meta !== null && "bridge" in meta && meta.bridge === "agent-bridge";
}

export default function agentBridge(pi: OmpExtensionApi): void {
  pi.on("mcp_notification", (event) => {
    if (event.method !== "notifications/claude/channel" || !isBridgeEvent(event.params)) return;
    pi.sendUserMessage(`<agent-bridge kind="${event.params.meta.kind}">\n${event.params.content}\n</agent-bridge>`, {
      deliverAs: "aside",
      attribution: "agent",
    });
  });
}
