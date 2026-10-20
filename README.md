# doubao CLI

## Install

Node.js 22+. Desktop: macOS + DoubaoWork.app or Doubao.app. Web: macOS + Chrome. Headless: Linux or macOS.

```bash
npm install --global doubao-cli@latest
doubao --version
```

## Backends

| Selector | Backend |
| --- | --- |
| `doubao` on Linux | Headless |
| `doubao` on macOS | Work if installed, otherwise Doubao |
| `doubao headless` | Headless |
| `doubao web` | Web |
| `doubao --app work` / `doubao --app doubao` | Selected desktop app |

Keep the same backend, account and profile for each conversation.

## Setup

```bash
doubao cdp launch                    # macOS desktop
doubao headless login
doubao web login
doubao status --json
```

- Desktop: sign in in the app; keep the chat window open. Restart requires confirmation (`--yes` for scripts).
- Headless: scan and approve the terminal QR in the Doubao mobile app; `login --cookie-file <path>` also accepts saved cookies.
- Web: sign in in Chrome; select multiple matching tabs with `--target <id>` from `web cdp status --json`.

[Headless options](docs/headless.md)

## Commands

Prefix with `headless` or `web` as needed. Use `--json` for data output, `--help` for command options, and `--` before literal option-like messages.

```bash
doubao help
doubao capabilities --json
doubao sessions list --json
doubao sessions create "Summarize this" --wait --json
doubao sessions read <conversation-id> --limit 5 --json
doubao sessions send <conversation-id> "Continue" --wait --json
doubao sessions status <conversation-id> --run <run-id> --json
doubao sessions wait <conversation-id> --run <run-id> --timeout 600 --json
doubao sessions stop <conversation-id> --run <run-id> --json
```

- Save `conversationId` and `runId`. After timeout/disconnect, wait with the same IDs; do not resend. Timeout does not cancel.
- Omitted `--run`: latest submitted turn. `waiting_input`: respond in Doubao, then wait again.
- `stopped: true`: task tree is terminal; inspect `status`. Completed tool effects remain.

| Option | Values / restrictions |
| --- | --- |
| `--mode` | `goal` on Desktop/Headless; `chat`, `work` on Headless/Web; create only |
| `--runtime` | `local`, `cloud`; task execution, not backend selection |
| `--model` | Exact name from `models`; Desktop/Headless |
| `--reasoning` | `low`, `medium`, `high`, `xhigh`, `max`; Desktop/Headless; send requires `--model` |
| `--attach` | Repeatable; 50 files, 100 MiB each; Desktop/Headless |
| `--timeout` | Seconds; default 120 |
| `--expect-json` | Validate the final reply as JSON |
| `--reply-schema` | Schema file: `type`, `required`, `properties`, `enum`, `items` |

Create/send reply validation requires `--wait`; invalid replies exit nonzero.

## Desktop

```bash
doubao profiles --json
doubao --profile "Profile 1" sessions list
doubao sessions current
doubao sessions open <conversation-id>
```

Messaging, models and MCP require the selected profile to be active in the app.

## Models and usage

Desktop/Headless:

```bash
doubao models --json
doubao model select 'Orange 5.5' --reasoning max
doubao model reasoning high
doubao usage --json
```

## Goals and automatic tasks

Desktop/Headless (add `headless` after `doubao` for Headless):

```bash
doubao sessions create "Define the result and acceptance criteria" --mode goal --runtime cloud --wait --json
doubao automations list --json
doubao automations get <id> --json
doubao automations create --file task.json --json
doubao automations update <id> --file patch.json --json
doubao automations delete <id> --json
```

Goal mode requires Doubao 2.32.10+ and the account's `goal_mode_enable` flag. This is a conservative compatibility floor based on the verified desktop protocol; Headless uses the same protocol revision without requiring an installed app. Follow-ups inherit the conversation's active goal. `sessions wait/status` track a turn; turn completion does not establish goal completion.

`task.json` contains the native task fields; `patch.json` contains only the fields to change. See [JSON examples and supported fields](docs/headless.md#automatic-tasks). Create, update and delete verify server readback. An unconfirmed operation retains its ID/operation ID; inspect `list/get` before retrying. Web does not support these commands.

## Projects and runtime

Desktop/Headless:

```bash
doubao runtimes --json
doubao projects list --json
doubao projects create "Code" --json
doubao projects create "Repo" --workspace /path/to/repo --json
doubao sessions create "Analyze this" --runtime local --project <project-id> --wait
doubao sessions send <conversation-id> "Search internal docs" --enterprise-knowledge --wait
```

- `--project`: ID, exact name, or `none`; duplicate names require ID.
- `--workspace`: existing local directory. `--no-skills`: omit default local skill paths.
- `--enterprise-knowledge`: requires the available 企业知识 skill; repeat each turn.
- Cloud rejects `--mcp`, `--workspace`, `--no-skills`, `--permission`. Headless project/enterprise selection requires Work mode.
- Unconfirmed project creation: check `projects list` before retrying.

## MCP

Desktop/Headless local execution:

```bash
doubao mcp register my-tools --command /usr/local/bin/node --arg /path/to/server.mjs
doubao mcp list --json
doubao sessions create "Use my tool" --mcp <connector-id> --permission AskOnRisk --wait
doubao mcp remove <connector-id>
```

- Repeat `--arg` and `--env KEY=VALUE` for server arguments/environment.
- `--mcp` requires a message; repeat `--mcp` and `--permission` each turn. Permission: `FullAccess` (default), `AskOnRisk`, `AlwaysAsk`.
- Desktop MCP requires `--wait`; incompatible with `--attach`. Approvals occur in the app.
- Headless approvals require terminal input/output and `--wait`; without `--wait`, operations requiring approval are denied.
- Permission policies do not restrict the MCP server process.

## Updates

```bash
doubao update check
doubao update
doubao update auto on
doubao update auto off
doubao update auto status
doubao update notify on
doubao update notify off
doubao update notify status
```

Auto-update defaults off. `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` disables automatic updates/reminders; explicit update commands remain available.

## Environment

| Variable | Value |
| --- | --- |
| `DOUBAO_APP` | Desktop app path |
| `DOUBAO_DATA_DIR` | App data directory |
| `DOUBAO_CDP_ENDPOINT` | CDP URL; Work 9226, Doubao 9225, Web 9227 |
| `DOUBAO_BROWSER_APP` | Web browser app; default `/Applications/Google Chrome.app` |
| `DOUBAO_WEB_PROFILE_DIR` | Web browser data directory |
| `DOUBAO_CLI_CONFIG_DIR` | Settings and recovery directory |
| `XDG_CONFIG_HOME` | Linux settings root; default `~/.config` |
| `DOUBAO_HEADLESS_COOKIE` | Headless Cookie header; secret |
| `DOUBAO_CLI_DISABLE_AUTO_UPDATE` | `1` to disable automatic updates/reminders |
| `DOUBAO_CLI_CONNECTION_BADGE` | `1` to show the desktop connection badge; hidden by default |

## Agent skill

```bash
npx skills add Fullstop000/doubao-cli
```

[Skill reference](skills/doubao/SKILL.md)

License: [MIT](LICENSE)
