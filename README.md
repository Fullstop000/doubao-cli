# doubao CLI

[![skills.sh](https://img.shields.io/badge/skills.sh-doubao-black)](https://skills.sh/Fullstop000/doubao-cli)

Programmatic access to local sessions in the macOS Doubao desktop app.

## Install

Requires macOS, Node.js 22 or newer, and DoubaoWork.app or Doubao.app.

```bash
npm install --global doubao-cli@latest
doubao --version
```

Upgrade an existing installation with `doubao update`. To run without a global install:

```bash
npx --yes doubao-cli@latest status
```

### Agent skill

An [agent skill](https://skills.sh/Fullstop000/doubao-cli) for AI coding assistants ships in [`skills/doubao`](skills/doubao/SKILL.md). Install it with the skills CLI:

```bash
npx skills add Fullstop000/doubao-cli
```

## Commands

```bash
doubao status
doubao profiles
doubao sessions list
doubao sessions current
doubao sessions create
doubao sessions create "summarize the attachment" --attach ./report.pdf --model pro --wait
doubao sessions open 38439138239851266
doubao sessions read 38439138239851266 --limit 5
doubao sessions send 38439138239851266 "hello"
doubao sessions send 38439138239851266 "hello" --wait
doubao sessions status 38439138239851266 --run 56325877314422786
doubao sessions wait 38439138239851266 --run 56325877314422786 --timeout 600
doubao sessions stop 38439138239851266 --run 56325877314422786
doubao sessions send 38439138239851266 "compare these files" --attach ./one.pdf --attach ./two.pdf --wait
doubao models
doubao model
doubao model select doubao-2.1-turbo
doubao sessions send 38439138239851266 "hello" --model gpt-5.6-sol --wait
doubao cdp status
doubao cdp launch
doubao update check
doubao update
doubao update auto on
doubao capabilities
```

The CLI prefers `/Applications/DoubaoWork.app`; it falls back to `/Applications/Doubao.app` only when Work is absent. Use `--app work` or `--app doubao` to select explicitly. Login or connection failures never switch apps. `status --json` reports the selected app, profile, and endpoint.

```bash
doubao status --json                  # Work first
doubao --app doubao status --json     # regular Doubao
doubao --app work cdp launch
```

Each app uses its own data directory and CDP port: Work **9226**, Doubao **9225**. Every turn in a conversation should target the same app. Connectors remain account-level and may appear in both apps when signed into the same account.

Ordinary session, model and MCP commands run in the background. They require an existing chat window and report an error if it is closed. `sessions open` explicitly follows the app's deep link and may briefly change focus; it is not needed before sending or reading. Launching or restarting with `cdp launch` may also show the app window.

Every data-returning command supports `--json`. Select a local profile with `--profile "Profile 1"` or its display name. Messaging, models and connectors require that profile to be active in the selected app; the CLI does not switch accounts.

Message automation requires Doubao to be launched with local Chrome DevTools Protocol enabled:

```bash
doubao cdp launch
```

If Doubao is already running without CDP, the command asks for confirmation before quitting it and relaunching with the debugging port enabled. Scripts and `--json` mode never prompt; pass `doubao cdp launch --yes` to confirm the restart explicitly. The command returns only after both the CDP endpoint and authenticated chat renderer are ready. For Work, the equivalent manual sequence is to quit it completely and run `open -a /Applications/DoubaoWork.app --args --remote-debugging-port=9226`. Regular Doubao uses `/Applications/Doubao.app` and port `9225`.

Set `DOUBAO_CDP_ENDPOINT` if using another port.

### Task completion and recovery

Requires CLI 0.11.0 or newer.

`create` and `send` return a `runId` for the accepted user message. `--wait` follows that turn's organizer and subagents, then returns the final main reply. Text, attachment and MCP turns use the same result: `status`, `reply`, `progress`, `artifacts`, `tasks` counts, and `pending` questions or approval controls. `reply` is only populated on success; progress is not a final answer.

```bash
doubao sessions create "Compare these approaches using two subagents" --json
# Use the returned conversationId and runId.
doubao sessions status <conversation-id> --run <run-id> --json
doubao sessions wait <conversation-id> --run <run-id> --timeout 600 --json
doubao sessions stop <conversation-id> --run <run-id> --json
```

- `status` reads the current state; `wait` can run in a new CLI process. Both return `completed`, `running`, `waiting_input`, `failed`, `cancelled`, or `unknown`. Without `--run`, the command selects the latest submitted turn once.
- Timeout defaults to 120 seconds and **does not cancel the task**. A timeout or unavailable connection exits nonzero with the known IDs. Continue with `sessions wait`; do not resend a request that may already have used a tool.
- `waiting_input` returns questions/approval choices and exits nonzero from a waiting command. Respond in Doubao, then wait again. The CLI does not submit approvals.
- `stop` targets the specified turn and its linked task tree, then reads back the states. `stopped:true` means no tracked task is running. A cancellation request without complete confirmation returns `stopped:false` and exits nonzero. Cancelling a task does not undo completed tool effects.
- `tasks` reflects server thread states. Doubao can mark interrupted subthreads completed; the CLI preserves its confirmed cancellation so the overall turn remains `cancelled`.
- Recovery receipts are scoped to app, active profile and account under `DOUBAO_CLI_CONFIG_DIR/turns` (default: `~/Library/Application Support/doubao-cli/turns`). Files have mode 0600 and contain request content, control blocks and stream cursors. Keep them to resume accepted requests; they contain no copied cookies or request signatures.

`--expect-json` fails the command (exit code 1, `replyValid: false`) when the final reply is not valid JSON; `--reply-schema <path>` also checks `type`, `required`, `properties`, `enum` and `items`. Use them on `create`/`send` with a message and `--wait`, or on `sessions wait`. Invalid options or schemas fail before sending.

### Execution environment, projects and enterprise knowledge

```bash
doubao runtimes --json                 # Local runtime readiness
doubao projects list --json            # Project IDs, names and device-bound folders
doubao projects create "Demo" --json   # Create a project
doubao projects create "Code" --workspace /path/to/repo --json  # Bind an existing local folder
doubao sessions create "Analyze this" --runtime local --project "My project" --enterprise-knowledge --wait
doubao sessions send <id> "Continue" --wait                # Inherit runtime and project
doubao sessions send <id> "Search internal docs" --enterprise-knowledge --wait
doubao sessions send <id> "Run in the cloud" --runtime cloud --project none --wait
```

- `--runtime local|cloud` selects 本地电脑 or the cloud. New sessions default to `local`; follow-ups inherit the server's setting. Local execution provisions a real sandbox and defaults to `FullAccess`. Use `--runtime local --permission AlwaysAsk` or `AskOnRisk` to request approvals.
- `projects create <name>` returns the new project's `id`, `name`, `folders` and `operationId`. Optional `--workspace` binds an existing directory as the current app/device's primary folder. Names allow 40 units (Chinese characters count as 2). If creation or readback fails, check `projects list` before repeating the command; it does not retry creation automatically.
- `--project <id-or-exact-name>` selects a Doubao project; `none` clears it. Use the ID returned by `projects create` directly in `sessions create/send`. Duplicate names require an ID. Local tasks receive only folders bound to the selected app's current device. A project without matching folders uses the session workspace. Selecting a project does not change its folders.
- `--enterprise-knowledge` selects the official 企业知识 skill for this turn. Its ID is read from the live catalog; unavailable accounts fail before sending. Repeat it on each turn that should select the skill. It is not a permission boundary for tools already available to the model.
- All three options work with `--attach` and require a message. Results include `context` with the submitted runtime, project, workspace and enterprise-knowledge selection. Ordinary sends preserve the current composer text and do not navigate or raise the app.
- `--workspace <path>` overrides the local working directory; otherwise use the selected project's primary folder, the inherited workspace, or a new app chat directory. `--no-skills` omits default local skill paths; repeat it when needed. Cloud cannot use `--mcp`, `--workspace`, `--no-skills` or `--permission`. Agent mode remains enabled.


### Local MCP connectors

The CLI can register a local stdio MCP server as a Doubao personal connector and let the model call its tools:

```bash
doubao mcp register my-tools --command /usr/local/bin/node --arg /path/to/server.mjs --env TOKEN=secret
doubao mcp list
doubao sessions create "use my tool to ..." --mcp 369247068674 --permission AskOnRisk --wait
doubao sessions send <conversation-id> "continue" --mcp 369247068674 --permission AskOnRisk --wait
doubao mcp remove 369247068674
```

`mcp register` waits until the app's native MCP runtime reports the connector READY and prints its connector id. Passing `--mcp <connector-id>` (repeatable) to `sessions create`/`sessions send` snapshots the connector's tool catalog into the request and prepares the local sandbox route, so model-issued tool calls execute against the local server. It requires a message and `--wait`, and is incompatible with `--attach`. Connectors are account-level and visible in the Doubao settings UI. `mcp remove` disconnects, disables if still present, and confirms both account state and local tool removal. Connector support depends on undocumented app internals (verified against Doubao 2.29.12, 2.30.1, 2.30.2, and DoubaoWork 2.30.5) and may break when the app updates.

`--permission <mode>` sets the local task's execution permission. It requires `--mcp` or `--runtime local`, and a message. Names are case-insensitive; hyphenated forms such as `ask-on-risk` also work.

| Mode | Doubao policy |
| --- | --- |
| `FullAccess` (default) | Allow execution without additional approval |
| `AskOnRisk` | Ask when Doubao classifies an operation as risky |
| `AlwaysAsk` | Use Doubao's always-ask policy |

Repeat `--mcp` and `--permission` on each turn; omitting `--permission` returns to `FullAccess`. Approval is handled by Doubao, so a turn may wait for action in the app. Doubao 2.30.1 dispatches `connector.call` separately from the native command approval path: these modes do not guarantee approval for every MCP call or restrict the server process itself. Use `--wait` for MCP turns so the session binding completes.

### Updates

`doubao update check` compares the running version with npm without changing the installation. `doubao update` installs the latest release globally through npm when an update is available:

```bash
doubao update check --json
doubao update
```

Automatic installation is opt-in and checks at most once every 24 hours:

```bash
doubao update auto on
doubao update auto status
doubao update auto off
```

An automatic update never blocks the requested Doubao command if npm or the network fails. Set `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` to skip configured automatic updates in CI or a one-off invocation. Settings are stored under `~/Library/Application Support/doubao-cli/update.json`; override that directory with `DOUBAO_CLI_CONFIG_DIR`.

When automatic updates are off, the CLI still checks npm at most once every 24 hours and prints a reminder to stderr when a newer version exists. The reminder is silent on network failures, suppressed in `--json` mode, and also disabled by `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1`.

### New sessions and attachments

`sessions create` without a message opens a clean composer. A numeric conversation id does not exist until the first message is sent, so `sessions create` without a message returns `conversationId: null`. Create and persist a session in one command by providing its first message:

```bash
doubao sessions create "Start a new task" --model gpt-5.6-sol --wait --json
```

Attach one or more local files by repeating `--attach`. The CLI validates each path, transfers the file through the authenticated renderer, waits for Doubao to finish uploading it, then uses the app's attachment formatter to send through the same protocol as text:

```bash
doubao sessions create "Summarize these" --attach ./brief.pdf --attach ./notes.md --wait
doubao sessions send 38439138239851266 "Review this spreadsheet" --attach ./data.xlsx --wait
```

Use `--` before message text that contains CLI option names, for example `doubao sessions create -- "Explain --model literally"`.

`models` reads the choices currently exposed by the desktop app. `model select` changes the active model, and `sessions send --model` selects a model before sending.

| Model | Value | Short aliases |
| --- | --- | --- |
| 自动 | `auto` | `自动` |
| 豆包 2.1 Turbo | `doubao-2.1-turbo` | `turbo` |
| 豆包 2.1 Pro | `doubao-2.1-pro` | `pro` |
| Orange 5.0 | `orange-5.0` | `orange` |
| Gemini 3.7 Flash | `gemini-3.7-flash` | `gemini` |
| GPT-5.6 Sol | `gpt-5.6-sol` | `gpt`, `sol` |

Use the value, exact display name, or a short alias anywhere `<model>` is accepted. Run `doubao models` to verify the choices exposed by the selected app. Exact names and IDs from this list also work for newer models, for example `--model gpt-6-astra`; protocol parameters are read from the live menu.

Adjust the reasoning effort (推理强度) with `--reasoning`, or change it for the current session with `model reasoning`:

```bash
doubao model reasoning high
doubao model select pro --reasoning max
doubao sessions send 38439138239851266 "hello" --model turbo --reasoning low --wait
```

Levels are `low` (低), `medium` (中), `high` (高), `xhigh` (极高), and `max` (最高); display names and raw API values work too. `--reasoning` on `sessions send` requires `--model`.

CDP is unauthenticated but bound to `127.0.0.1`. Quit and relaunch Doubao normally when automation is no longer needed.

## How it works

- Session ids and titles come from the signed-in account's IndexedDB snapshots; offline profiles use the older disk cache when available.
- The current session comes from the selected app's live chat route when CDP is available.
- Opening a session targets the selected app and its registered `doubaowork://` or `doubao://` deep-link router.
- Sending and creating sessions issue `chat/completion` requests directly inside the authenticated renderer, where the app's own request-signing hook attaches its risk-control parameters; the reply is parsed from the SSE event stream rather than scraped from the DOM.
- Model choices and request parameters come from the selected app's live menu. Existing-session model changes use `im/conversation/modify` and verify `batch_get`; draft changes use the menu.
- Task tracking follows async stream handoffs and reads the turn plus linked thread histories. Recovery uses the original request identity or async cursor. Stopping uses `im/message/break_stream_msg` and the app's task-termination API, then verifies parent and child states.
- Attachments are transferred into the renderer through its drop-upload path; file contents and credentials are never printed.

No hard-coded UI coordinates, image recognition, Cookie extraction, or private credential copying are involved.

## Limits

Message send/create and model selection use Doubao's own HTTP APIs from inside the authenticated renderer; message read and attachment upload use stable DOM attributes over localhost CDP. A Doubao update can change either surface. The CLI treats image previews and file cards separately, waits for their respective upload completion signals, and encodes the uploaded files with the app's attachment formatter before sending. The CLI currently accepts up to 50 attachments per command and files up to 100 MiB each; the Doubao service can impose stricter type or size limits.

Task history lookup currently covers the latest 100 main-conversation messages and up to 100 linked threads (20 pages per thread). Missing history or unknown states fail explicitly; they are not interpreted as completion. `sessions read` remains a view of rendered messages, not an export of all task histories. Full subagent listing and event streaming are not exposed. See [task lifecycle verification](docs/subagent-e2e.md).

## Development

```bash
npm test
```

Run the live command suite against an already signed-in app with CDP enabled:

```bash
npm run test:e2e -- --app work
npm run test:e2e -- --fallback
```

This sends synthetic messages, uploads generated fixtures and registers a temporary MCP server. Run it against a quiet app. It does not restart the app; it removes its connector and restores the initial page. Results stay in `.e2e/work/` or `.e2e/fallback/` and are excluded from Git. Use `--stage baseline|messages|models|attachments|stop|mcp|negative|update|cleanup` to rerun a stage. See [verification](docs/doubaowork-e2e.md) for tested coverage and limits.

`--fallback` hides only the Work installation probe in CLI child processes and omits `--app`; commands then use real regular Doubao with its default data directory and port. It neither moves nor uninstalls Work. The suite discovers the selected app's available models. `--fallback --stage selection` checks discovery and failure isolation without restarting either app.

Override discovery paths when testing:

```bash
DOUBAO_APP=/path/to/Doubao.app DOUBAO_DATA_DIR=/path/to/user-data doubao status
```

## License

MIT © 2026 Fullstop000
