# doubao CLI

## Install

Requirements: Node.js 22+. Headless runs on Linux or macOS with an authenticated Doubao account. Desktop and browser backends require macOS plus DoubaoWork.app / Doubao.app or Chrome respectively.

```bash
npm install --global doubao-cli@latest
# Headless on Linux or macOS:
doubao headless login
doubao headless sessions create "Hello" --mode work --wait --json
```

Check the installed version with `doubao --version`. Upgrade older installations with the same npm command.

Without global installation:

```bash
npx --yes doubao-cli@latest headless status --json
```

## Backend selection

| System | Default for `doubao sessions ...` | Explicit Headless |
| --- | --- | --- |
| Linux | Headless: direct HTTPS | `doubao headless sessions ...` |
| macOS | Desktop: Work when installed, otherwise Doubao | `doubao headless sessions ...` |

`doubao headless <command>` and `doubao --platform headless <command>` are equivalent. On Linux, the prefix is optional: `doubao login` and `doubao sessions list --json` use Headless. On macOS, include `headless` on login and every session command to use it.

Web is opt-in via `doubao web <command>`. `--app work|doubao` explicitly selects a desktop app. `--runtime cloud` selects where a task executes; it does not switch the backend. Keep the same backend for create, send, read, wait and stop.

## Commands

```bash
doubao help
doubao sessions --help
doubao sessions create --help
doubao web sessions send -h
doubao status --json
doubao sessions list
doubao sessions create "Summarize this" --wait
doubao sessions read <conversation-id> --limit 5
doubao sessions send <conversation-id> "Continue" --wait
```

Data-returning commands: `--json`.

Command help: append `--help` / `-h`, or use `doubao help sessions create` / `doubao sessions help create`. Help runs without connecting or executing the command. `--` ends option parsing: `doubao sessions create -- help` sends the literal message `help`.

### Headless (experimental)

Runs on Linux and macOS without a browser, CDP, display server or installed Doubao app. Terminal QR login needs the Doubao mobile app to scan and approve sign-in.

```bash
doubao headless login
# Scan the terminal QR with the Doubao mobile app and approve sign-in.
doubao headless status --json
doubao headless capabilities --json
doubao headless models --json
doubao headless sessions list --limit 20 --json
# Equivalent selector:
doubao --platform headless sessions list --json
doubao headless sessions create "Hello" --mode chat --wait --json
doubao headless sessions create "Write a plan" --mode work --model 'Orange 5.5' --wait --json
doubao headless sessions send <conversation-id> "Continue" --wait --json
doubao headless sessions read <conversation-id> --limit 5 --json
doubao headless sessions wait <conversation-id> --run <run-id> --json
doubao headless sessions stop <conversation-id> --run <run-id> --json
doubao headless logout
```

- Default creation mode: cloud Work; use `--mode chat` for ordinary chat. Follow-ups retain the conversation mode. Cloud and process-based local execution are available for Work tasks.
- Model catalog, profile-scoped model/reasoning defaults, per-turn model/reasoning overrides, attachments, projects, enterprise knowledge, usage, local execution and MCP are available; see [the Headless command guide](docs/headless.md) for options and limits.
- Save `conversationId` and `runId`. Recover an accepted timeout or disconnect with `sessions wait` using the same IDs; do not resend. Without `--wait`, one detached worker submits the request and then owns its local HTTP/SSE execution.
- Terminal QR login requires scanning and approval in the Doubao mobile app. Security challenges fail explicitly and may require supported website login.
- Account cookies and recovery files are secrets, stored with mode 0600. `logout` removes saved credentials; an externally set `DOUBAO_HEADLESS_COOKIE` remains active until unset. Protocol compatibility metadata can require updates when Doubao changes its private service APIs.

Unattended sign-in with an existing session:

```bash
doubao headless login --cookie-file /secure/doubao-cookie.txt --json
```

The file accepts a Cookie header, `{ "cookie": "..." }`, or an exported cookie array. Credentials are read from the file, not command-line values. `DOUBAO_HEADLESS_COOKIE` supplies a session in memory instead.

[Headless verification and limits](docs/headless.md)

### Desktop app and profile (macOS)

```bash
doubao cdp launch
doubao status
doubao --app work cdp launch
doubao --app doubao status --json
doubao profiles
doubao --profile "Profile 1" sessions list
doubao sessions current
```

- macOS default app: Work when installed; otherwise Doubao. `DOUBAO_APP` can override the app path.
- Login or connection failure: no app fallback.
- Conversation: use the same app on every turn.
- Messaging, models and MCP: selected profile must be active in the app.
- `profiles --json` adds account ID, name, type, enterprise user type, tenant ID/name/user name, and metadata source (`live` or `cache`). Missing metadata is `null`; offline types remain `unknown`. Account identity does not imply permission to send Feishu messages.
- Account IDs come from profile Preferences; CDP reads account and tenant metadata without switching profiles. `accountLookupError` reports incomplete or unavailable lookup.
- Desktop chat window: must remain open.
- While a CLI command uses the desktop chat renderer, a `doubao-cli` connection badge appears beside search (or in the upper-right corner). Click it to see the selected app, profile, CDP endpoint, CLI version, and process ID. Commands send heartbeats every 2 seconds; the badge shows a delayed connection after 5 seconds and disconnected after 10 seconds without a heartbeat, or immediately when the command finishes. Concurrent connections are counted separately. This indicates an active CLI connection, not login or task completion; detached tasks may continue after the CLI disconnects. Web and Headless do not display the badge.
- Restart confirmation: interactive prompt; scripts require `cdp launch --yes`.
- `sessions open <conversation-id>`: navigate to session; may change focus.

### Web platform (experimental)

```bash
doubao web login
# Complete sign-in in the opened browser; the command waits until the account is ready.
doubao web status --json
doubao web capabilities --json
doubao web sessions create "Hello" --mode chat --wait --json
doubao web sessions create "Write a short plan" --mode work --runtime cloud --wait --json
doubao web sessions wait <conversation-id> --run <run-id> --json
```

- `doubao web <command>`: Web entry point with its own help (`doubao web help`). `--platform web` remains a compatibility alias. Desktop selectors (`--app` / `--platform work|doubao`) conflict with the Web namespace and fail before connecting.
- Web is opt-in on macOS, on port 9227. It requires Chrome and is separate from Headless.
- `doubao web login` starts or reuses the browser; an already signed-in account returns immediately. Manual website sign-in stays in the browser. The default wait is 120 seconds (`--timeout` to adjust); timeout exits nonzero and keeps the browser open. No separate `cdp launch` step is needed; it remains available for advanced setup.
- Web launch uses a separate Chrome data directory; it does not restart your normal browser or copy its login. Chrome 136+ requires a non-default directory for CDP.
- Multiple matching tabs: use `--target <id>` from `cdp status --json`.
- New sessions use `--mode chat|work` or the active composer mode. Accounts may expose different creation modes; choose the account in the browser. Work uses 云电脑, and `--runtime cloud` is optional.
- Save `conversationId` and `runId`. Web wait/status/stop use server task state; timeout never resends. Recovery records are scoped by platform, browser endpoint and account. An account change fails explicitly.
- `sessions list`: rendered sidebar only. `sessions read`: up to 100 recent main messages.
- Web does not yet expose CLI attachment uploads, model/reasoning changes, project/enterprise-knowledge selection or quota queries. Local runtimes, MCP, workspace, skills, permission settings and desktop profiles are rejected before connecting.
- Website support for uploads, models, projects and enterprise knowledge is separate from CLI adapter support. Sending uses the website's native configuration; CLI does not change these settings.
- Live E2E covers Work on one selected account and ordinary chat on another, including create/send/read/wait, recovery, guards, identity isolation and target selection. Ordinary-chat cancellation was confirmed; Work stop confirmed a terminal completed tree, not child cancellation. Work editor hydration, ordinary-chat post-ACK routing, same-origin async stream recovery, and bounded wait/stop results were fixed and verified without resending accepted messages. Local tests passed 204/204; package dry-run includes both Web modules. Both modes were not tested on both accounts, and the installer upgrade branch was not triggered. See [acceptance results](docs/web-e2e-results.md) and [design and checks](docs/web-platform-design.md).

### Attachments and models

These examples use the macOS desktop backend. Headless also supports uploads and model/reasoning selection; see [the Headless command guide](docs/headless.md).

```bash
doubao sessions create "Compare these" --attach ./one.pdf --attach ./two.pdf --wait
doubao models
doubao model select 'Orange 5.5' --reasoning max
doubao model reasoning high
doubao sessions send <conversation-id> "Review this" --model 'Orange 5.5' --reasoning high --wait
doubao sessions create -- "Explain --model literally"
```

- `create` without a message: `conversationId: null`.
- Attachments: repeat `--attach`; maximum 50 files, 100 MiB each. Service limits may be lower.
- Models: exact model name from `doubao models`.
- Reasoning: `low`, `medium`, `high`, `xhigh`, `max`; `send --reasoning` requires `--model`.
- Message containing option names: precede with `--`.

### Usage quota

Available through the macOS desktop and Headless backends.

```bash
doubao usage
doubao usage --json
doubao --app work usage
```

- Desktop requires CDP and an app version supporting quota queries. Headless reads usage from the account service.
- Reset times: UTC. Unknown values: `null`. Usage below 1%: `<1%`.

## Resume or stop

Use the same backend as the original send. For Headless tasks on macOS, replace `doubao` below with `doubao headless`; for Web tasks, use `doubao web`.

```bash
doubao sessions status <conversation-id> --run <run-id> --json
doubao sessions wait <conversation-id> --run <run-id> --timeout 600 --json
doubao sessions stop <conversation-id> --run <run-id> --json
```

- `runId`: returned by `create` / `send`.
- Omitted `--run`: latest submitted turn, selected once.
- `--wait`: waits for the turn and subagents; final `reply` only on success.
- Default timeout: 120 seconds. Timeout does not cancel.
- Timeout or connection failure: resume with the same IDs; do not resend.
- `waiting_input`: respond in Doubao, then wait again.
- `stopped: true`: the tracked task tree is terminal; inspect `status` to distinguish cancellation from natural completion. `stopped: false`: cancellation unconfirmed, nonzero exit.
- Cancellation: completed tool effects remain.

| State | Action |
| --- | --- |
| `completed` | Read `reply` |
| `running` | Continue with `wait` |
| `waiting_input` | Respond in the app |
| `failed`, `cancelled`, `unknown` | Inspect result before retrying |

Reply validation with `create/send --wait` or `sessions wait`:

- `--expect-json`: valid JSON required.
- `--reply-schema <path>`: supports `type`, `required`, `properties`, `enum`, `items`.
- Invalid reply: exit 1, `replyValid: false`.
- Invalid options or schema: fail before sending.

## Projects and runtime

Available through the macOS desktop and Headless backends. Headless project and enterprise-knowledge selection is supported for Work tasks.

```bash
doubao runtimes --json
doubao projects list --json
doubao projects create "Code" --workspace /path/to/repo --json
doubao sessions create "Analyze this" --runtime local --project <project-id> --permission AskOnRisk --wait
doubao sessions send <conversation-id> "Search internal docs" --enterprise-knowledge --wait
doubao sessions send <conversation-id> "Run in the cloud" --runtime cloud --project none --wait
```

- Desktop runtime: `local` by default for new sessions; follow-ups inherit runtime and project.
- Project: ID or exact name; duplicate names require ID; `none` clears selection.
- Workspace: `--workspace` override, project folder on current app/device, inherited workspace, or new chat directory.
- Project creation failure: check `projects list` before retrying.
- `--enterprise-knowledge`: available 企业知识 skill required; repeat each turn.
- `--no-skills`: omit default local skill paths; repeat each turn.
- Cloud: incompatible with `--mcp`, `--workspace`, `--no-skills`, `--permission`.

## MCP

Available through the macOS desktop and Headless backends with local execution.

```bash
doubao mcp register my-tools --command /usr/local/bin/node --arg /path/to/server.mjs
doubao mcp list
doubao sessions create "Use my tool" --mcp <connector-id> --permission AskOnRisk --wait
doubao mcp remove <connector-id>
```

- Registration: local stdio server; returns connector ID when ready.
- Server arguments: repeat `--arg`; environment: repeat `--env KEY=VALUE`.
- `--mcp`: repeat for multiple connectors and on each turn; requires a message. Headless accepts attachments and continues in a background worker without `--wait`. Desktop MCP requires `--wait` and is incompatible with `--attach`.

| Permission | Policy |
| --- | --- |
| `FullAccess` (default) | Execute without additional approval |
| `AskOnRisk` | Ask for operations Doubao classifies as risky |
| `AlwaysAsk` | Doubao always-ask policy |

- Local task permission: repeat `--permission` each turn; omitted value defaults to `FullAccess`.
- Desktop `AlwaysAsk` uses the native sandbox policy; commands within granted folders can execute without another prompt.
- Approvals: in Doubao; not guaranteed for every MCP call. Server process is unrestricted by these policies.

## Updates

```bash
doubao update check
doubao update
doubao update auto on
doubao update auto status
doubao update auto off
doubao update notify on
doubao update notify off
doubao update notify status
```

- `update check`: check only.
- `update`: global installation from the public npm registry used by `update check`.
- Auto-update: off by default; checks at most once per day when enabled with `update auto on`.
- Version reminders: on by default; `update notify` with no action shows status. Ordinary commands may report the latest stable npm version and suggest `doubao update` on stderr; reminders never install updates.
- Reminders are checked in parallel with the command, with a 1-second budget, at most once per day. Failed checks are also throttled. `--json`, non-TTY stderr, CI, help/version, and `update` commands skip the reminder check.
- Enabling auto-update suppresses version reminders. `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` disables reminders and automatic updates; explicit `update` and `update check` still work.

## Configuration

| Environment variable | Override |
| --- | --- |
| `DOUBAO_APP` | App path |
| `DOUBAO_DATA_DIR` | App data directory |
| `DOUBAO_CDP_ENDPOINT` | CDP endpoint; Work: 9226, Doubao: 9225, Web: 9227 |
| `DOUBAO_BROWSER_APP` | Web browser app; default `/Applications/Google Chrome.app` |
| `DOUBAO_WEB_PROFILE_DIR` | Dedicated Web browser data directory; default settings directory + `web-browser` |
| `DOUBAO_CLI_CONFIG_DIR` | Settings and recovery directory |
| `XDG_CONFIG_HOME` | Linux settings root; default `~/.config` |
| `DOUBAO_HEADLESS_COOKIE` | Headless session Cookie header; secret, in-memory alternative to saved login |
| `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` | Disable reminders and automatic updates; explicit `update` and `update check` still work |

- Default directory: macOS `~/Library/Application Support/doubao-cli`; Linux `$XDG_CONFIG_HOME/doubao-cli` or `~/.config/doubao-cli`.
- Headless credentials: `headless/session.json` for the default profile; named profiles use `headless/profiles/<name>/session.json`. Account-scoped selections and connector configuration are stored alongside the profile.
- Update settings: `update.json`.
- Recovery: `turns/`; desktop records use app/profile/account scope, Web uses platform/endpoint/account scope, and Headless also isolates named profiles. The default Headless profile retains its original recovery directory. Files use mode 0600 and may contain task content. Retain for task recovery.

## Limits

- App updates may break automation and MCP support.
- CDP: unauthenticated localhost access. Relaunch normally after automation.
- Task lookup: latest 100 main messages, up to 100 linked threads, 20 pages per thread.
- Desktop `sessions read`: rendered messages only. Web and Headless read up to 100 recent server messages. No full task-history export or event streaming.

## Development

```bash
npm test
npm run test:e2e -- --app work
npm run test:e2e -- --fallback
```

- E2E requirements: signed-in, quiet app with CDP.
- E2E effects: synthetic messages, fixture uploads, temporary MCP connector.
- Cleanup: remove connector; restore initial page.
- Results: ignored `.e2e/work/` or `.e2e/fallback/`.
- `--fallback`: regular Doubao.
- `--stage`: `baseline`, `messages`, `models`, `attachments`, `stop`, `mcp`, `negative`, `update`, `cleanup`.

[App tests](docs/doubaowork-e2e.md) · [Task tests](docs/subagent-e2e.md) · [Context tests](docs/task-context-e2e.md)

## Agent skill

```bash
npx skills add Fullstop000/doubao-cli
```

[SKILL.md](skills/doubao/SKILL.md)

## License

MIT © 2026 Fullstop000
