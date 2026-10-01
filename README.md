# doubao CLI

Control Doubao desktop sessions from the terminal: send messages, attach files, track tasks and use local MCP tools.

[Install](#install) · [Commands](#commands) · [Tasks](#resume-or-stop) · [Projects](#projects-and-runtime) · [MCP](#mcp) · [Configuration](#configuration)

## Install

Requires macOS, Node.js 22+, and a signed-in DoubaoWork.app or Doubao.app.

```bash
npm install --global doubao-cli@latest
doubao cdp launch
doubao status
```

`cdp launch` enables local Chrome DevTools Protocol (CDP) and waits for the authenticated chat renderer. If the app needs restarting, confirm interactively. Scripts and `--json` mode require `doubao cdp launch --yes`.

Without a global install:

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
doubao models
doubao sessions send <conversation-id> "Review this" --model pro --reasoning high --wait
```

Run `doubao help` for all commands and options. Data-returning commands support `--json`.

### App and profile

Work is selected when installed; regular Doubao is used only when Work is absent. Login or connection failures do not switch apps. Keep the same app throughout a conversation.

```bash
doubao --app doubao status --json
doubao --app work cdp launch
doubao profiles
```

Use `--profile <name>` to select a profile. Messaging, model and MCP commands require the selected profile to be active and a chat window to be open. They run in the background; the CLI does not switch accounts. `sessions open <conversation-id>` navigates to the session and may change focus.

### Sessions, attachments and models

Include a first message to persist a new session. `sessions create` without a message opens a composer and returns `conversationId: null`. Repeat `--attach` for multiple files; the CLI waits for uploads before sending.

```bash
doubao sessions create "Compare these" --attach ./one.pdf --attach ./two.pdf --wait
doubao model select pro --reasoning max
doubao model reasoning high
doubao sessions create -- "Explain --model literally"
```

Use `doubao models` for available model IDs, display names and aliases. `model select` changes the active model; `send --model` selects it before sending. Reasoning levels: `low`, `medium`, `high`, `xhigh`, `max`; `send --reasoning` requires `--model`.

## Resume or stop

```bash
doubao sessions status <conversation-id> --run <run-id> --json
doubao sessions wait <conversation-id> --run <run-id> --timeout 600 --json
doubao sessions stop <conversation-id> --run <run-id> --json
```

`create` and `send` return the accepted message's `runId`. `--wait` follows that turn and its subagents. Results include `status`, `reply`, `progress`, `artifacts`, `tasks` and `pending`; `reply` is populated only on success.

| State / result | Next action |
| --- | --- |
| `completed` | Read the final `reply` |
| `running` | Continue with `wait` |
| `waiting_input` | Answer or approve in Doubao, then wait again |
| `failed`, `cancelled`, `unknown` | Inspect the result before retrying |
| Timeout or connection failure | Resume with the same IDs; do not resend |

- Default timeout: **120 seconds**. Timeout does not cancel the task. Waiting commands exit nonzero on timeout, pending input or failure.
- Omit `--run` to select the latest submitted turn once. `wait` can resume in a new CLI process.
- `stop` targets the turn and linked task tree. `stopped: true` confirms no tracked task is running; incomplete confirmation returns `stopped: false` and exits nonzero. Cancellation does not undo completed tool effects.

For structured replies, add `--expect-json` or `--reply-schema <path>` to `create/send --wait` or `sessions wait`. Invalid replies exit with code 1 and `replyValid: false`. Supported schema fields: `type`, `required`, `properties`, `enum`, `items`. Invalid options and schemas fail before sending.

## Projects and runtime

```bash
doubao runtimes --json
doubao projects list --json
doubao projects create "Code" --workspace /path/to/repo --json
doubao sessions create "Analyze this" --runtime local --project <project-id> --permission AskOnRisk --wait
doubao sessions send <conversation-id> "Search internal docs" --enterprise-knowledge --wait
```

| Option | Values / behavior |
| --- | --- |
| `--runtime` | `local` (new-session default) or `cloud`; follow-ups inherit |
| `--project` | ID, exact name or `none`; follow-ups inherit; duplicate names require ID |
| `--workspace` | Local working directory; project folders must match app/device |
| `--permission` | `FullAccess` (default), `AskOnRisk`, `AlwaysAsk`; repeat each turn |
| `--enterprise-knowledge` | 企业知识 skill; repeat each applicable turn |
| `--no-skills` | Omit default local skill paths |

`projects create` returns `id`, `name`, `folders` and `operationId`. `--workspace` binds an existing directory to the current app/device. Names allow 40 units; Chinese characters count as 2. If creation or readback fails, check `projects list` before retrying.

Selecting a project does not change its folders. Without `--workspace`, local tasks use the project's primary folder, inherited workspace or a new chat directory. Projects without matching device folders use the session workspace.

```bash
doubao sessions send <conversation-id> "Run in the cloud" --runtime cloud --project none --wait
```

Runtime, project and enterprise-knowledge options require a message and support attachments. Results include the submitted `context`. Enterprise knowledge requires an available account skill; it does not restrict tools already available to the model.

Cloud cannot use `--mcp`, `--workspace`, `--no-skills` or `--permission`. Local tasks default to **FullAccess**; repeat `--permission` and `--no-skills` on each turn where needed.

## MCP

```bash
doubao mcp register my-tools --command /usr/local/bin/node --arg /path/to/server.mjs
doubao mcp list
doubao sessions create "Use my tool" --mcp <connector-id> --permission AskOnRisk --wait
doubao mcp remove <connector-id>
```

`mcp register` registers a local stdio server and returns its connector ID after the app reports it ready. Add arguments with repeated `--arg` and environment variables with repeated `--env KEY=VALUE`. Connectors belong to the account and appear in app settings.

Repeat `--mcp` on each turn; multiple connectors are supported. It requires a message and `--wait`, and cannot be combined with `--attach`. `mcp remove` verifies account state and local tool removal.

| Permission | Policy |
| --- | --- |
| `FullAccess` (default) | Execute without additional approval |
| `AskOnRisk` | Ask when Doubao classifies an operation as risky |
| `AlwaysAsk` | Use Doubao's always-ask policy |

Approval happens in Doubao. These modes do not guarantee approval for every MCP call or restrict the server process. Omitting `--permission` returns to `FullAccess`.

## Updates

```bash
doubao update check
doubao update
doubao update auto on
doubao update auto status
doubao update auto off
```

`update check` checks npm without installing. `update` installs the latest release globally through npm when available.

Automatic installation is off by default and checks at most once every 24 hours. Update failures do not block ordinary commands. With auto-update off, version reminders go to stderr; `--json` suppresses them. Network failures are silent.

## Configuration

| Environment variable | Override |
| --- | --- |
| `DOUBAO_APP` | App path |
| `DOUBAO_DATA_DIR` | App data directory |
| `DOUBAO_CDP_ENDPOINT` | CDP endpoint; Work: 9226, Doubao: 9225 |
| `DOUBAO_CLI_CONFIG_DIR` | Settings and recovery directory |
| `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` | Disable automatic updates and reminders |

Default configuration directory: `~/Library/Application Support/doubao-cli`. Update settings are in `update.json`. Recovery receipts are in `turns/`, scoped to app, profile and account, with file mode 0600. They contain request content, control blocks and stream cursors; retain them to resume accepted tasks.

## How it works

- Session metadata comes from account IndexedDB snapshots; offline profiles may use the older disk cache.
- Sending uses the authenticated renderer and the app's request-signing hook. Replies come from the SSE stream.
- Model choices come from the live app menu. Message reading and attachment upload use DOM attributes over CDP.
- Task tracking follows linked thread histories; recovery reuses the original request identity or stream cursor.

The CLI does not extract cookies or copy private credentials.

## Limits

- App updates may break automation and MCP support.
- Attachments: up to 50 files, 100 MiB each; service limits may be lower.
- CDP: unauthenticated localhost access. Relaunch normally after automation.
- Task lookup: latest 100 main messages, up to 100 linked threads, 20 pages per thread.
- `sessions read`: rendered messages only. No full task-history export or event streaming.

## Development

```bash
npm test
npm run test:e2e -- --app work
npm run test:e2e -- --fallback
```

Run live tests against a signed-in, quiet app with CDP enabled. They send synthetic messages, upload fixtures and register a temporary MCP server, then remove the connector and restore the initial page. They do not restart the app.

`--fallback` tests regular Doubao by hiding the Work installation probe in child processes; it does not move or uninstall Work. Results stay in ignored `.e2e/work/` or `.e2e/fallback/` directories.

Rerun a stage with `--stage baseline|messages|models|attachments|stop|mcp|negative|update|cleanup`. Use `--fallback --stage selection` for app discovery and failure isolation.

[App tests](docs/doubaowork-e2e.md) · [Task tests](docs/subagent-e2e.md) · [Context tests](docs/task-context-e2e.md)

## Agent skill

```bash
npx skills add Fullstop000/doubao-cli
```

[SKILL.md](skills/doubao/SKILL.md)

## License

MIT © 2026 Fullstop000

### 使用额度

```bash
doubao usage
doubao usage --json
doubao --app work usage
```

通过当前登录应用的真实额度接口查询订阅、个人/企业使用窗口、额度包和奖励额度。展示已用/剩余百分比及重置时间（UTC）；小于 1% 的用量保留 `<1%`，未知用量不推算剩余额度。`--json` 返回结构化字段，未知值为 `null`。需要已开启 CDP；不支持该接口的应用版本会明确报错。不会发送消息或消耗模型额度。
