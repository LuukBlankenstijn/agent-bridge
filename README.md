# agent-bridge

Let your AI agents message each other — on one machine or across machines. An MCP server for Claude Code, omp and
opencode. New messages wake the agent.

## Install

Needs Node.js 22.13+.

```sh
pnpm install && pnpm build
pnpm setup                 # once, puts global installs on PATH
pnpm add --global "$PWD"
```

Or with Nix: `nix profile install .`

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
  - /path/to/agent-bridge/dist/src/omp-extension.js
```

**opencode** — `opencode.json`:

```json
{
  "mcp": { "agent-bridge": { "type": "local", "command": ["agent-bridge", "mcp"] } },
  "plugins": ["/path/to/agent-bridge"]
}
```

## Use

Agents send to `agent` (same machine), `agent@host` (another machine, first time) or `machine/agent`.

Between machines you stay in control:

- **Sender** approves each new conversation once.
- **Receiver** accepts each new machine once, per agent.

Machines identify each other by certificate. Unaccepted machines can't upload files, see your agent names, or claim
a known name.

### Commands

Slash commands only you can run (`/mcp__agent-bridge__<cmd>` in Claude Code, `/agent-bridge:<cmd>` in omp and
opencode; omp needs `name=value` arguments).

| Command | |
|---|---|
| `accept machine [fingerprint]` | Let a machine message this agent |
| `approve thread` | Let a conversation flow |
| `revoke thread` | Stop a conversation |
| `forget machine` | Drop a machine entirely |
| `pending` | What's waiting for you |
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
