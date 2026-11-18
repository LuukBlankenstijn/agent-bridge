# agent-bridge

Let your AI agents message each other — on one machine or across machines. An MCP server for Claude Code, omp and
opencode. New messages wake the agent.

## Install

Needs Node.js 22.13+.

```sh
npm install --global @luukblankenstijn/agent-bridge
```

From source: `pnpm install && pnpm build && pnpm add --global "$PWD"` (run `pnpm setup` once first). With Nix:
`nix profile install github:LuukBlankenstijn/agent-bridge`.

## Connect

Each agent is named after its project folder (override with `--agent NAME`). The first session starts a
background daemon; nothing else to set up.

**Claude Code**

```sh
claude mcp add agent-bridge -- agent-bridge mcp
claude --dangerously-load-development-channels server:agent-bridge   # needed for wake-ups
```

**omp** — `.omp/mcp.json`, plus the extension in `~/.omp/agent/config.yml`:

```json
{ "mcpServers": { "agent-bridge": { "type": "stdio", "command": "agent-bridge", "args": ["mcp"] } } }
```

```yaml
extensions:
  - <global node_modules>/@luukblankenstijn/agent-bridge/dist/src/omp-extension.js   # see `npm root -g`
```

**opencode** — `opencode.json`:

```json
{
  "mcp": { "agent-bridge": { "type": "local", "command": ["agent-bridge", "mcp"] } },
  "plugins": ["@luukblankenstijn/agent-bridge"]
}
```

## Use

Agents send to `agent` (same machine), `agent@host` (another machine, first time) or `machine/agent`.

Messages you send leave right away. The receiving side stays in control:

- **Accept** each conversation another machine starts with one of your agents. That lets only that thread
  through, not the whole machine.
- **Trust** your own machines (e.g. your other laptop) to accept all their conversations, for every agent.

Your agent is woken when a conversation waits for you, and when a message it sent has not arrived (held by the
receiver, failed, or retrying). Machines identify each other by certificate. Machines without an accepted
conversation can't upload files or claim a known name, and no machine sees your agent names.

### Commands

Slash commands only you can run (`/mcp__agent-bridge__<cmd>` in Claude Code, `/agent-bridge:<cmd>` in omp and
opencode; omp needs `name=value` arguments).

| Command | |
|---|---|
| `accept thread` | Accept one conversation from another machine |
| `revoke thread` | Stop a conversation; its new messages are held again |
| `trust machine` | Always accept conversations from this machine (your own machines only; accept one of its conversations first) |
| `untrust machine` | Stop always accepting a machine |
| `forget machine` | Drop a machine entirely |
| `pending` | Conversations waiting for you |
| `peers` | This agent's address, local agents, known machines |
| `listen on` | Interface or IP to listen on (`wg0`, `0.0.0.0`, …) |
| `restart` | Restart the daemon after an update |

### Tools for the agent

`send`, `reply`, `inbox`, `read`, `ack`, `wait`, `fetch_attachment`, `peers`, `conversations`, `discover`.

`discover` finds other agent-bridge machines on your local networks, Tailscale peers and any ranges listed under
`discover` in the config.

## Config

`~/.local/share/agent-bridge/identity/config.json` (`%APPDATA%\agent-bridge` on Windows, or `AGENT_BRIDGE_HOME`).
Ports 8766 (peers) and 8767 (local agents).

## License

MIT
