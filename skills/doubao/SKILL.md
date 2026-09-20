---
name: doubao
description: "Control the local Doubao desktop app on macOS through the doubao CLI: create, read, send to, or stop chat sessions, attach files, select models, and register or use local stdio MCP tools. Requires Doubao.app installed and logged in, with CDP enabled for automation."
---

# Doubao CLI

`doubao` controls the local, already logged-in Doubao desktop app over a localhost CDP endpoint. No API keys or credentials are involved. Requires macOS, Node.js 22+, Doubao.app.

If the CLI is missing: `npm install --global doubao-cli@latest` (or prefix commands with `npx --yes doubao-cli@latest`).

## Readiness check (do this first)

```bash
doubao status --json        # app installed / running / version / profile
doubao capabilities --json  # per-feature availability; cdp.available gates messaging
```

If `cdp.available` is false, use `doubao cdp launch`. Restarting a running app needs the user's consent; pass `--yes` in non-interactive use only when that restart is authorized. Use `DOUBAO_CDP_ENDPOINT` for a non-default port.

## Command routing

Pass `--json` to every data-returning command when another program consumes the output.

| Task | Command |
| --- | --- |
| List sessions | `doubao sessions list --json` |
| Current session | `doubao sessions current --json` |
| Create session with first message | `doubao sessions create "..." --wait --json` |
| Blank draft session | `doubao sessions create --json` (returns `conversationId: null`) |
| Send to a session | `doubao sessions send <id> "..." --wait --json` |
| Stop a generating reply | `doubao sessions stop <id> --json` |
| Register a local MCP server | `doubao mcp register <name> --command <path> [--arg X]... [--env K=V]... --json` |
| List / remove MCP connectors | `doubao mcp list --json` / `doubao mcp remove <connector-id> --json` |
| Send with MCP tools | add `--mcp <connector-id> --wait` to each `sessions create`/`sessions send` |
| Read messages | `doubao sessions read <id> --limit 20 --json` |
| Reveal session in the app | `doubao sessions open <id>` |
| List / show models | `doubao models --json` / `doubao model --json` |
| Switch model | `doubao model select <model> --json` or per-send `--model <model>` |
| Set reasoning effort | `doubao model reasoning <level> --json` or `--reasoning <level>` on select/send/create |
| Update the CLI | `doubao update` (`update check`, `update auto on`) |

## Behavior notes

- Add `--wait` to block until the assistant reply completes and return it as `reply`; omit it to return once the user message is accepted (`reply: null`). Default timeout is 120 s; raise with `--timeout <seconds>`. A reply whose stream ends without Doubao's completion event fails with `incomplete_stream` instead of returning a partial answer; on `timeout`/`incomplete_stream` failures the CLI tries to stop the server-side generation, and the process exits non-zero. `sessions stop <id>` cancels an in-flight generation explicitly.
- `--expect-json` (with `--wait`) exits 1 when the reply is not valid JSON; `--reply-schema <path>` also checks `type`/`required`/`properties`/`enum`/`items`. Both mark the JSON output with `replyValid`.
- `--workspace <path>` sets the agent workspace; `--no-skills` omits default local skill paths. These apply to new conversations and MCP turns; ordinary follow-up messages do not resend them. Agent mode stays enabled; `--no-skills` is not a tool-permission sandbox.
- Prefer `sessions create "first message"` over create-then-send: a conversation id exists only after the first message.
- Session operations never raise the Doubao window; only `sessions open` brings the app to the front intentionally.
- Prefix the message with `--` when it begins with option-like text: `doubao sessions send <id> -- "--model means what here"`.
- Select a non-default local profile with `--profile "Profile 1"` (directory or display name).
- Repeat `--attach <path>` for attachments (max 50 files, 100 MiB each). The CLI uploads through the app's drop path and confirms the upload before sending; attachments take the slower UI path while plain text uses the direct protocol path.
- The composer auto-inserts spaces at CJK/latin boundaries; verify content with `sessions read` rather than raw string comparison.

## Local MCP tools

Use CLI 0.8.1 or newer. The published 0.8.1 path was verified on Doubao 2.30.1; it depends on app internals and may need updates for other versions. Before the first MCP request, select **本地电脑** in a Doubao work task and let the local runtime initialize. Version 0.8.1 does not select the device for you.

```bash
# Register an existing stdio MCP server; returns connectorId after READY.
doubao mcp register my-tools --command "$(command -v node)" --arg /absolute/path/server.mjs --json
doubao mcp list --json

# Replace the ids with values returned by register and create.
doubao sessions create "Call my_tool with ..." --mcp <connector-id> --wait --json
doubao sessions send <conversation-id> "Call my_tool again with ..." --mcp <connector-id> --wait --json

doubao mcp remove <connector-id> --json
doubao mcp list --json
```

- Use absolute executable and server paths. Repeat `--arg` for arguments and `--env KEY=value` for environment variables; the app starts the server.
- Pass every required `--mcp <connector-id>` on **each turn**, including follow-ups. Use a message and `--wait`; in 0.8.1, returning at the initial acknowledgement can skip sandbox binding. `--mcp` cannot be combined with `--attach`.
- To keep the same workspace across MCP turns, repeat `--workspace /absolute/path` each time; also repeat `--no-skills` when wanted.
- `--permission FullAccess|AskOnRisk|AlwaysAsk` sets the local task's execution permission for a turn with `--mcp`. Default: `FullAccess` (no additional approval). `AskOnRisk` and `AlwaysAsk` request Doubao's corresponding approval policies; respond to approval requests in the app. Repeat the flag on each turn; omitting it returns to `FullAccess`. Doubao 2.30.1 handles `connector.call` separately from native command approval, so this does not guarantee approval for every MCP call or restrict the server process itself. Check `doubao help` for flag support on an older CLI.
- Connectors are account-level. After `mcp remove`, check `mcp list`: an absent or disabled entry confirms removal. A disconnect can delete the record before the subsequent disable call, producing a 404; verify the list before retrying.
- Verify tool execution from the server's actual result or log, not just the model's claim. Do not automatically resend a timed-out request that may already have run a tool.

## Model values

Accept the value, exact display name, or an alias anywhere `<model>` appears. Confirm availability with `doubao models --json` — the installed app version decides what exists.

Reasoning effort levels: `low` (低), `medium` (中), `high` (高), `xhigh` (极高), `max` (最高). `--reasoning` on `sessions send` requires `--model` and is incompatible with `--attach`; `model reasoning <level>` changes the current session without switching models.

| Model | Value | Aliases |
| --- | --- | --- |
| 自动 | `auto` | `自动` |
| 豆包 2.1 Turbo | `doubao-2.1-turbo` | `turbo` |
| 豆包 2.1 Pro | `doubao-2.1-pro` | `pro` |
| Orange 5.0 | `orange-5.0` | `orange` |
| Gemini 3.7 Flash | `gemini-3.7-flash` | `gemini` |
| GPT-5.6 Sol | `gpt-5.6-sol` | `gpt`, `sol` |

## Environment overrides

- `DOUBAO_APP` — Doubao.app path (default `/Applications/Doubao.app`)
- `DOUBAO_DATA_DIR` — Doubao user-data directory
- `DOUBAO_CDP_ENDPOINT` — CDP endpoint (default `http://127.0.0.1:9225`)
- `DOUBAO_CLI_CONFIG_DIR` — CLI settings directory
- `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` — skip configured auto updates (CI)

## Troubleshooting

- `Doubao CDP is unavailable` → use the CDP launch procedure above.
- `Doubao connectors are not ready` → check the id with `mcp list` and the connector's local status in the app; list output alone does not prove READY.
- `no Doubao chat page found` → CDP is up but no chat window exists; open Doubao once, then retry.
- Commands break after a Doubao.app update → the app changed its DOM/API surface; run `doubao update check` for a fixed CLI release.
- CDP is unauthenticated but bound to 127.0.0.1; quit and relaunch Doubao normally when automation is no longer needed.
