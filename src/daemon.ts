import type { Server } from "node:https";
import { promisify } from "node:util";
import { Bridge } from "./bridge.js";
import { dataDir } from "./config.js";
import { resolveListen } from "./discovery.js";
import { startMcpHttp } from "./mcp.js";
import { Outbox } from "./outbox.js";
import { startPeerServer } from "./peers.js";

const PEER_RETRY_MS = 30_000;

export interface Daemon {
  bridge: Bridge;
  close(): Promise<void>;
}

export async function startDaemon(dir = dataDir(), outboxIntervalMs?: number): Promise<Daemon> {
  const bridge = new Bridge(dir);
  const config = bridge.config();
  let peerServer: Server | undefined;
  let retry: NodeJS.Timeout | undefined;
  const listenForPeers = async () => {
    try {
      peerServer = await startPeerServer(bridge, resolveListen(config.listen), config.peerPort);
    } catch (error) {
      console.error(`agent-bridge: other machines cannot reach this one yet (${config.listen}: ${error}); retrying in 30 s`);
      retry = setTimeout(() => void listenForPeers(), PEER_RETRY_MS);
    }
  };
  await listenForPeers();
  const mcpServer = await startMcpHttp(bridge, config.mcpPort).catch((error: unknown) => {
    clearTimeout(retry);
    peerServer?.close();
    throw error;
  });
  const outbox = new Outbox(bridge, outboxIntervalMs);
  outbox.start();
  return {
    bridge,
    async close() {
      clearTimeout(retry);
      await outbox.stop();
      peerServer?.closeAllConnections();
      mcpServer.closeAllConnections();
      const servers = peerServer === undefined ? [mcpServer] : [peerServer, mcpServer];
      await Promise.all(servers.map((server) => promisify(server.close.bind(server))()));
      bridge.store.close();
    },
  };
}
