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

Messages you send leave right away. The receiving side decides per machine:

| Level | Its conversations | Its agents' messages are | It sees your agents |
|---|---|---|---|
| `unknown` (default) | each one needs `/bridge accept` | information, not instructions | no |
| `known` | accepted automatically | information, not instructions | yes |
| `trusted` | accepted automatically | requests from a colleague (still asks before destructive or remote actions) | yes |
| `blocked` | refused | — | no |

Messages from agents on the same machine are always treated as requests from a colleague. Your agent is woken when a
conversation waits for you, and when a message it sent has not arrived. Machines identify each other by certificate;
raising a machine from `unknown` asks for the start of its certificate fingerprint the first time.

### Commands

One command, only you can run it:

| | |
|---|---|
| `/bridge` | Machines, waiting conversations and usage |
| `/bridge machines` | List machines with their level, and conversations waiting for you |
| `/bridge machine <name> <level> [fingerprint]` | Set a machine's level; the first time it leaves `unknown`, add the start (16+ characters) of its certificate from its `peers` |
| `/bridge accept [thread\|machine]` | Accept a waiting conversation |
| `/bridge revoke <thread>` | Stop a conversation; its new messages are held again |
| `/bridge listen <interface\|ip>` | Where other machines reach this one (`wg0`, `0.0.0.0`, …); restarts the daemon |
| `/bridge restart` | Restart the daemon |

omp completes subcommands, machine names and levels as you type. In Claude Code the same commands are MCP prompts:
`/mcp__agent-bridge__machine zenbook trusted`.

### Workspaces

A workspace is a shared log several agents work in, on one machine or across machines. It lives on the machine
that created it; agents elsewhere join it as `name@machine` (joining from an `unknown` machine waits for
`/bridge accept <machine/agent>`).

- **Posts:** `note` (wakes nobody unless they follow everything), `request` with `to` (wakes those agents),
  `question` (for you; wakes the workspace's desk), `answer` (reply to a question, `source` user or desk).
  A post can reply to another; everyone in that thread is woken by replies.
- **Modes:** each agent is woken by `all` posts (batched) or only `mentions` (default; the creator follows all).
  Every agent-bridge tool result says how many posts are unread.
- **Questions:** the desk (the creator, or `/bridge workspace <name> desk <agent>`) answers what it can from the
  workspace and asks you the rest with its own question tool. `/bridge questions` and `/bridge answer <id> <text>`
  work from any session.
- **Trust:** a post never counts as more trusted than the machine that hosts the workspace. An answer only counts
  as yours when its source is `user` and its trust is local or trusted.

| Command | |
|---|---|
| `/bridge workspace` | Workspaces on this machine, with desk and members |
| `/bridge workspace new <name>` | Create one; this agent is its desk |
| `/bridge workspace <name> desk <agent>` | Change the desk |
| `/bridge questions` | Open questions in all your workspaces |
| `/bridge answer <id> <text>` | Answer one |

### Tools for the agent

`send`, `reply`, `inbox`, `read`, `ack`, `wait`, `fetch_attachment`, `peers`, `conversations`, `discover`, and
`workspace_create`, `workspace_join`, `workspace_leave`, `workspace_post`, `workspace_read`, `workspace_mode`,
`workspace_follow`, `workspaces`.

`discover` finds other agent-bridge machines on your local networks, Tailscale peers and any ranges listed under
`discover` in the config.

## Updating

Update the package; the next session that starts replaces an older running daemon, and a stopped daemon is
started from the `agent-bridge` on your PATH. Sessions already open keep working; restart them to see new commands.

## Config

`~/.local/share/agent-bridge/identity/config.json` (`%APPDATA%\agent-bridge` on Windows, or `AGENT_BRIDGE_HOME`).
Ports 8766 (peers) and 8767 (local agents).

## License

MIT
