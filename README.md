# doubao CLI

## Install

Requirements: macOS, Node.js 22+, signed-in DoubaoWork.app or Doubao.app.

```bash
npm install --global doubao-cli@latest
doubao cdp launch
doubao status
```

- Restart confirmation: interactive prompt; scripts require `cdp launch --yes`.
- Chat window: must remain open.

Without global installation:

```bash
npx --yes doubao-cli@latest status
```

## Commands

```bash
doubao help
doubao status --json
doubao sessions list
doubao sessions current
doubao sessions create "Summarize this" --attach ./brief.pdf --wait
doubao sessions read <conversation-id> --limit 5
doubao sessions send <conversation-id> "Continue" --wait
```

Data-returning commands: `--json`.

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

- Runtime: `local` by default for new sessions; follow-ups inherit runtime and project.
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
| `DOUBAO_CDP_ENDPOINT` | CDP endpoint; Work: 9226, Doubao: 9225 |
| `DOUBAO_CLI_CONFIG_DIR` | Settings and recovery directory |
| `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` | Disable automatic updates and reminders |

- Default directory: `~/Library/Application Support/doubao-cli`.
- Update settings: `update.json`.
- Recovery: `turns/`; app/profile/account scoped; mode 0600; contains request content. Retain for task recovery.

## Limits

- App updates may break automation and MCP support.
- CDP: unauthenticated localhost access. Relaunch normally after automation.
- Task lookup: latest 100 main messages, up to 100 linked threads, 20 pages per thread.
- `sessions read`: rendered messages only. No full task-history export or event streaming.

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
