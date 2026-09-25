---
name: doubao
description: "Control the local Doubao desktop app on macOS through the doubao CLI: create, read, send to, or stop chat sessions, attach files, select execution environments/projects/enterprise knowledge and models, and register or use local stdio MCP tools. Requires DoubaoWork.app or Doubao.app installed and logged in, with CDP enabled for automation."
---

# Doubao CLI

`doubao` controls the local, already logged-in Doubao desktop app over a localhost CDP endpoint. No API keys or credentials are involved. Requires macOS, Node.js 22+, and DoubaoWork.app or Doubao.app.

If the CLI is missing: `npm install --global doubao-cli@latest` (or prefix commands with `npx --yes doubao-cli@latest`).

## App selection

Requires CLI 0.10.0 or newer. Check `doubao --version`; update older installations before using `--app` or Work.

Prefer DoubaoWork when installed; fall back to Doubao only when Work is absent. Use `--app work` or `--app doubao` on any command to select explicitly. A login or CDP failure must not trigger a switch. Check `status --json` for `app`, `appPath`, `dataDir`, profile, and `cdpEndpoint`.

Work uses port 9226 and its own profile directory; regular Doubao uses 9225. Keep the same `--app` on follow-ups. Connectors are account-level, so the same account can expose them in both apps. Restart authorization applies separately to each app.

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
| List runtimes / projects | `doubao runtimes --json` / `doubao projects list --json` |
| Create a project | `doubao projects create "name" [--workspace /absolute/directory] --json` |
| Select task context | add `--runtime local\|cloud --project <id-or-name> --enterprise-knowledge` to create/send |
| List sessions | `doubao sessions list --json` |
| Current session | `doubao sessions current --json` |
| Create session with first message | `doubao sessions create "..." --wait --json` |
| Blank draft session | `doubao sessions create --json` (returns `conversationId: null`) |
| Send to a session | `doubao sessions send <id> "..." --wait --json` |
| Query a turn | `doubao sessions status <id> --run <run-id> --json` |
| Resume waiting | `doubao sessions wait <id> --run <run-id> --timeout 600 --json` |
| Stop a turn and its tasks | `doubao sessions stop <id> --run <run-id> --json` |
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

- Task tracking requires CLI 0.11.0 or newer. Check `doubao --version` and run `doubao update` before using `sessions status/wait` or `stop --run` on an older installation.
- Save both `conversationId` and `runId` from each accepted send. `--wait` follows organizer/subagents and returns only the final main reply in `reply`; interim text is `progress`, produced files are `artifacts`, and `tasks` gives server thread counts. Omit `--wait` to return on acceptance with `reply: null` (MCP still requires `--wait`).
- Timeout defaults to 120 s; set `--timeout <seconds>` when needed. Timeout or disconnection does not cancel work. Use `sessions wait <id> --run <run-id>` in a new process instead of resending; tools may already have executed. Keep the same app, account, profile and config directory for recovery receipts. Receipt files include request content and have mode 0600.
- `waiting_input` includes `pending` questions or approval controls. Ask the user to respond in Doubao, then wait again; do not automatically choose or approve. Waiting commands exit nonzero for timeout, unknown state, waiting input, failure or cancellation. A `status` lookup itself exits zero when the lookup succeeds.
- Explicit cancellation uses `sessions stop <id> --run <run-id>`. Confirm `stopped: true`; otherwise report unconfirmed cancellation. It does not undo tool effects. Without `--run`, status/wait/stop pin the latest submitted turn once; prefer the saved ID for automation. An already completed old turn can be queried/stopped without targeting a newer one.
- `--expect-json` / `--reply-schema <path>` validate the final reply. Use them on create/send with a message and `--wait`, or on `sessions wait`. They mark `replyValid` and exit nonzero on invalid output. Pending/error states are not successful replies.
- Runtime/project commands and enterprise knowledge require CLI 0.12.0 or newer.
- `--runtime local|cloud` selects execution on 本地电脑 or in the cloud. New sessions default to local with `FullAccess`; follow-ups inherit the server's runtime/project. An unavailable local runtime fails explicitly. Use `--runtime local --permission AlwaysAsk` or `AskOnRisk` to request Doubao approvals.
- `projects create <name>` returns `id`, `name`, `folders` and `operationId`. Optional `--workspace` must be an existing directory and binds it as this app/device's primary folder. Names allow 40 units (Chinese characters count as 2). Creation is not retried automatically; an error retains `operationId` and any known `id`. Check `projects list` before repeating an uncertain create.
- `--project <id-or-exact-name>` selects a project; `--project none` clears it. Use the ID from `projects create` or `projects list`; duplicate names require an ID. Only current-device project folders are granted to local tasks; folders bound to another app/device are not reused. Selecting a project does not edit its folders.
- `--enterprise-knowledge` selects the official 企业知识 skill using the live catalog. Repeat it on each desired turn. Missing account/runtime availability fails before sending. Omitting it does not revoke tools or knowledge already available to the model.
- All three context flags require a message and support attachments. The result's `context` records the submitted choice. Cloud rejects MCP, workspace, local skill and permission flags.
- `--workspace <path>` overrides the local working directory. Otherwise use the project's current-device primary folder, inherited session workspace, or a new app chat directory. `--no-skills` omits default local skill paths; repeat it when wanted. Agent mode remains enabled; this is not a tool-permission sandbox.
- Prefer `sessions create "first message"` over create-then-send: a conversation id exists only after the first message.
- Ordinary session, model and MCP commands run in the background. Do not run `sessions open` before sending or reading; it uses a deep link and can briefly change focus. A missing chat page fails explicitly without opening a window. Launching or restarting the app with `cdp launch` may show its window.
- Prefix the message with `--` when it begins with option-like text: `doubao sessions send <id> -- "--model means what here"`.
- `--profile "Profile 1"` accepts a directory or display name. Messaging, model and connector commands require that profile to be active in the selected app; switch it in the app first.
- Repeat `--attach <path>` for attachments (max 50 files, 100 MiB each). The CLI uploads through the app's drop path and confirms the upload before sending; the app's formatter encodes uploads for the direct protocol path. Sending preserves existing composer text and removes only its own staged uploads.
- The composer auto-inserts spaces at CJK/latin boundaries; verify content with `sessions read` rather than raw string comparison.

## Local MCP tools

MCP depends on app internals. The dual-app implementation was tested on DoubaoWork 2.30.5 and Doubao 2.30.2, including real tool execution through automatic fallback with Work absence simulated. If the local runtime is unavailable, select **本地电脑** in a work task and let it initialize, then retry readiness checks.

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
- Pass every required `--mcp <connector-id>` on **each turn**, including follow-ups. A message and `--wait` are required so the sandbox binding completes. `--mcp` cannot be combined with `--attach`.
- MCP turns inherit the workspace; use `--workspace /absolute/path` to override it and repeat `--no-skills` when wanted.
- `--permission FullAccess|AskOnRisk|AlwaysAsk` sets execution permission for a turn with `--mcp` or `--runtime local`. Default: `FullAccess` (no additional approval). `AskOnRisk` and `AlwaysAsk` request Doubao's corresponding approval policies; respond to approval requests in the app. Repeat the flag on each turn; omitting it returns to `FullAccess`. Doubao 2.30.1 handles `connector.call` separately from native command approval, so this does not guarantee approval for every MCP call or restrict the server process itself. Requires CLI 0.9.0 or newer.
- Connectors are account-level. `mcp remove` verifies an absent/disabled account entry and removal from the selected app's tool catalog. A failed readback is reported as unconfirmed; check `mcp list` before retrying.
- Verify tool execution from the server's actual result or log, not just the model's claim. Do not automatically resend a timed-out request that may already have run a tool.

## Model values

Accept the value, exact display name, or an alias anywhere `<model>` appears. Exact names and IDs from the live list work for newer models, including `gpt-6-astra` when available. Confirm availability with `doubao models --json` — the installed app version decides what exists.

Reasoning effort levels: `low` (低), `medium` (中), `high` (高), `xhigh` (极高), `max` (最高). `--reasoning` on `sessions send` requires `--model`; `model reasoning <level>` changes the current session without switching models.

| Model | Value | Aliases |
| --- | --- | --- |
| 自动 | `auto` | `自动` |
| 豆包 2.1 Turbo | `doubao-2.1-turbo` | `turbo` |
| 豆包 2.1 Pro | `doubao-2.1-pro` | `pro` |
| Orange 5.0 | `orange-5.0` | `orange` |
| Gemini 3.7 Flash | `gemini-3.7-flash` | `gemini` |
| GPT-5.6 Sol | `gpt-5.6-sol` | `gpt`, `sol` |

## Environment overrides

- `DOUBAO_APP` — explicit application path; overrides automatic selection. `--app` selects the other variant when specified.
- `DOUBAO_DATA_DIR` — selected app user-data directory override
- `DOUBAO_CDP_ENDPOINT` — CDP endpoint (Work: `http://127.0.0.1:9226`; Doubao: `http://127.0.0.1:9225`). An endpoint belonging to the other app is rejected.
- `DOUBAO_CLI_CONFIG_DIR` — CLI settings directory
- `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` — skip configured auto updates (CI)

## Troubleshooting

- `Doubao CDP is unavailable` → use the CDP launch procedure above.
- `Doubao connectors are not ready` → check the id with `mcp list` and the connector's local status in the app; list output alone does not prove READY.
- `no Doubao chat page found` → CDP is up but no chat window exists. Ask the user to open a chat window in the selected app, then retry; do not silently run `sessions open` as recovery.
- Missing requested turn in history → the lookup is limited to the latest 100 main-conversation messages; do not substitute a newer turn. Full child lists/event streaming are not CLI features yet.
- Commands break after an app update → the app changed its DOM/API surface; run `doubao update check` for a fixed CLI release.
- CDP is unauthenticated but bound to 127.0.0.1; quit and relaunch Doubao normally when automation is no longer needed.
