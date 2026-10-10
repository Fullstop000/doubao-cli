# doubao CLI

## Install

Requirements: Node.js 22+. Headless runs on Linux or macOS with an authenticated Doubao account. Desktop and browser backends require macOS plus DoubaoWork.app / Doubao.app or Chrome respectively.

```bash
npm install --global doubao-cli@latest
# Linux (defaults to headless):
doubao login
doubao sessions create "Hello" --mode work --wait --json

# macOS desktop:
doubao cdp launch
doubao status
```

- Restart confirmation: interactive prompt; scripts require `cdp launch --yes`.
- Desktop chat window: must remain open.

Without global installation:

```bash
npx --yes doubao-cli@latest status
```

## Commands

```bash
doubao help
doubao sessions --help
doubao sessions create --help
doubao web sessions send -h
doubao status --json
doubao sessions list
doubao sessions current
doubao sessions create "Summarize this" --attach ./brief.pdf --wait
doubao sessions read <conversation-id> --limit 5
doubao sessions send <conversation-id> "Continue" --wait
```

Data-returning commands: `--json`.

Command help: append `--help` / `-h`, or use `doubao help sessions create` / `doubao sessions help create`. Help runs without connecting or executing the command. `--` ends option parsing: `doubao sessions create -- help` sends the literal message `help`.

### App and profile

```bash
doubao --app work cdp launch
doubao --app doubao status --json
doubao profiles
doubao --profile "Profile 1" sessions list
```

- Default app: Work when installed; otherwise Doubao.
- Login or connection failure: no app fallback.
- Conversation: use the same app on every turn.
- Messaging, models and MCP: selected profile must be active in the app.
- `sessions open <conversation-id>`: navigate to session; may change focus.

### Headless (experimental)

```bash
doubao headless login
# Scan the terminal QR with the Doubao mobile app and approve sign-in.
doubao headless status --json
doubao headless capabilities --json
doubao headless models --json
doubao headless sessions list --limit 20 --json
doubao headless sessions create "Hello" --mode chat --wait --json
doubao headless sessions create "Write a plan" --mode work --model 5 --wait --json
doubao headless sessions send <conversation-id> "Continue" --wait --json
doubao headless sessions read <conversation-id> --limit 5 --json
doubao headless sessions wait <conversation-id> --run <run-id> --json
doubao headless sessions stop <conversation-id> --run <run-id> --json
doubao headless logout
```

- Direct HTTPS from Node; no browser, CDP, display server, or local Doubao installation. Linux defaults to this backend. macOS requires `headless` or `--platform headless`.
- Default creation mode: `work`; execution: cloud. Follow-ups retain the conversation mode. Desktop local-runtime conversations are rejected.
- Model selection: live model ID or exact name, available for the selected mode and account. `--model` works on create/send; model aliases and reasoning selection are not exposed here.
- Save `conversationId` and `runId`. An accepted timeout/disconnect is recovered with `sessions wait`, using the original request identity. Sending is never retried automatically. `stop` confirms server state; a completed task is already stopped.
- Headless supports chat, cloud Work, recent sessions, reads, model selection and task recovery/cancellation. Attachments, local execution, MCP, project/knowledge selection, UI navigation and interactive approval answers are currently unavailable. Check `capabilities` before automation.
- Terminal QR login requires scanning and approval in the Doubao mobile app. Security challenges fail explicitly and may require supported website login.
- Account cookies and recovery files are secrets, stored with mode 0600. `logout` removes saved credentials; an externally set `DOUBAO_HEADLESS_COOKIE` remains active until unset. Protocol compatibility metadata can require updates when Doubao changes its private service APIs.

Unattended sign-in with an existing session:

```bash
doubao headless login --cookie-file /secure/doubao-cookie.txt --json
```

The file accepts a Cookie header, `{ "cookie": "..." }`, or an exported cookie array. Credentials are read from the file, not command-line values. `DOUBAO_HEADLESS_COOKIE` supplies a session in memory instead.

[Headless verification and limits](docs/headless.md)

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
- Default remains Work when installed, otherwise Doubao. Web is opt-in, on port 9227.
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

```bash
doubao sessions create "Compare these" --attach ./one.pdf --attach ./two.pdf --wait
doubao models
doubao model select pro --reasoning max
doubao model reasoning high
doubao sessions send <conversation-id> "Review this" --model pro --reasoning high --wait
doubao sessions create -- "Explain --model literally"
```

- `create` without a message: `conversationId: null`.
- Attachments: repeat `--attach`; maximum 50 files, 100 MiB each. Service limits may be lower.
- Models: ID, display name or alias from `doubao models`.
- Reasoning: `low`, `medium`, `high`, `xhigh`, `max`; `send --reasoning` requires `--model`.
- Message containing option names: precede with `--`.

### Usage quota

```bash
doubao usage
doubao usage --json
doubao --app work usage
```

- Requires CDP and an app version supporting quota queries.
- Reset times: UTC. Unknown values: `null`. Usage below 1%: `<1%`.

## Resume or stop

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
- `stopped: true`: no tracked task running. `stopped: false`: cancellation unconfirmed, nonzero exit.
- For Web, `stopped: true` means the server task tree is terminal; inspect `status` to distinguish `cancelled` from work that completed naturally.
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

```bash
doubao mcp register my-tools --command /usr/local/bin/node --arg /path/to/server.mjs
doubao mcp list
doubao sessions create "Use my tool" --mcp <connector-id> --permission AskOnRisk --wait
doubao mcp remove <connector-id>
```

- Registration: local stdio server; returns connector ID when ready.
- Server arguments: repeat `--arg`; environment: repeat `--env KEY=VALUE`.
- `--mcp`: repeat for multiple connectors and on each turn; requires message and `--wait`; incompatible with `--attach`.

| Permission | Policy |
| --- | --- |
| `FullAccess` (default) | Execute without additional approval |
| `AskOnRisk` | Ask for operations Doubao classifies as risky |
| `AlwaysAsk` | Doubao always-ask policy |

- Local task permission: repeat `--permission` each turn; omitted value defaults to `FullAccess`.
- Approvals: in Doubao; not guaranteed for every MCP call. Server process is unrestricted by these policies.

## Updates

```bash
doubao update check
doubao update
doubao update auto on
doubao update auto status
doubao update auto off
```

- `update check`: check only.
- `update`: global npm installation.
- Auto-update: off by default; checks at most once every 24 hours.
- Version reminders: stderr; suppressed with `--json`.

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
| `DOUBAO_HEADLESS_COOKIE` | Headless session Cookie header; secret, alternative to saved login |
| `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` | Disable automatic updates and reminders |

- Default directory: macOS `~/Library/Application Support/doubao-cli`; Linux `$XDG_CONFIG_HOME/doubao-cli` or `~/.config/doubao-cli`.
- Headless credentials: `headless/session.json`.
- Update settings: `update.json`.
- Recovery: `turns/`; desktop records use app/profile/account scope, Web and headless records use platform/endpoint/account scope. Files use mode 0600 and may contain task content. Retain for task recovery.

## Limits

- App updates may break automation and MCP support.
- CDP: unauthenticated localhost access. Relaunch normally after automation.
- Task lookup: latest 100 main messages, up to 100 linked threads, 20 pages per thread.
- Desktop `sessions read`: rendered messages only. Web reads up to 100 recent server messages. No full task-history export or event streaming.

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
