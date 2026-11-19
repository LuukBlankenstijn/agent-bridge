import { setTimeout as sleep } from "node:timers/promises";
import { dataDir, defaultAgentName, ensureSetup } from "./config.js";
import { readEvents, sendCommand, type PushEvent } from "./events.js";
import { connectionRefused, startDetachedDaemon } from "./launch.js";
import { USAGE } from "./usage.js";

interface OpencodeEvent {
  type: string;
  location?: { directory?: string };
  data?: { sessionID?: string };
}

interface OpencodeContext {
  location: { directory: string };
  options: Record<string, unknown>;
  event: { subscribe(options: { types?: string[]; signal?: AbortSignal }): AsyncIterable<OpencodeEvent> };
  session: {
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
  };
  command: {
    transform(
      callback: (editor: {
        add(definition: {
          name: string;
          description: string;
          execute(input: { sessionID: string; prompt: { text?: string } }): Promise<void>;
        }): void;
      }) => void,
    ): Promise<unknown>;
  };
}

const RETRY_MS = 2_000;

function render(event: PushEvent): string {
  return `<agent-bridge kind="${event.meta.kind}">\n${event.content}\n</agent-bridge>`;
}

export default {
  id: "agent-bridge",
  setup(ctx: OpencodeContext) {
    const directory = ctx.location.directory;
    const agent = typeof ctx.options.agent === "string" ? ctx.options.agent : defaultAgentName(directory);
    const controller = new AbortController();
    const waiting: PushEvent[] = [];
    let sessionID: string | undefined;

    const deliver = async (event: PushEvent) => {
      if (sessionID === undefined) waiting.push(event);
      else await ctx.session.prompt({ sessionID, text: render(event) });
    };

    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.inbox.enqueued"], signal: controller.signal })) {
        if (event.location?.directory !== directory || !event.data?.sessionID) continue;
        sessionID = event.data.sessionID;
        for (const pending of waiting.splice(0)) await deliver(pending);
      }
    })().catch(() => {});

    const dir = dataDir();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const config = await ensureSetup(dir);
          for await (const event of readEvents(config, agent, controller.signal)) await deliver(event);
        } catch (error) {
          if (connectionRefused(error)) startDetachedDaemon(dir);
          await sleep(RETRY_MS);
        }
      }
    })();

    void ctx.command.transform((editor) => {
      editor.add({
        name: "bridge",
        description: `agent-bridge: ${USAGE}`,
        async execute({ sessionID: commandSession, prompt }) {
          const config = await ensureSetup(dir);
          const text = await sendCommand(config, agent, prompt.text ?? "").catch(
            (error: unknown) => `agent-bridge failed: ${error}`,
          );
          await ctx.session.synthetic({ sessionID: commandSession, text });
        },
      });
    });

    return () => controller.abort();
  },
};
