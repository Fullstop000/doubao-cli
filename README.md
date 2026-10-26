# doubao CLI

## Install

Node.js 22+. Desktop: macOS + DoubaoWork.app or Doubao.app. Headless: Linux or macOS.

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
| `doubao web` / `doubao --platform web` | Headless (compatibility aliases) |
| `doubao --app work` / `doubao --app doubao` | Selected desktop app |

Keep the same backend, account and profile for each conversation.

## Setup

```bash
doubao cdp launch                    # macOS desktop
doubao headless login
doubao status --json
```

- Desktop: sign in in the app; keep the chat window open. Restart requires confirmation (`--yes` for scripts).
- Headless: scan and approve the terminal QR in the Doubao mobile app; `login --cookie-file <path>` also accepts saved cookies.
- `web` commands use the same login, profiles and settings as Headless. Browser login sessions are not imported; run `doubao web login` to sign in. Browser `--target` and `web cdp` commands are unsupported.

[Headless options](docs/headless.md)

## Commands

Desktop and Headless `sessions list` use the same `/im/chain/recent_conv` pagination and runtime classification. Both accept `--all` or `--limit 1–100` (default 20); `--timeout` covers the traversal. `--all` follows all API-visible sessions, removes duplicate IDs, and finishes with `hasMore: false`. Deleted or inaccessible history is outside this API's scope. Invalid pages, non-advancing cursors and timeouts fail instead of returning partial success. The observed intermittent read error is retried twice on the same page.

JSON uses an object with `sessions`, `source`, `complete`, `hasMore`, `pages`, and `platform`. **Desktop JSON changed from an array to this object**; scripts should read `.sessions`. `source: "api"` identifies a live query; `complete: true` means the response includes every API-visible session. Text output includes the same completeness fields below the session rows.

`runtime` is `cloud`, `local`, or `unknown`. Desktop overlays only explicit input runtime selections on server-saved context; Headless uses saved context. Unsaved Desktop selections can therefore differ. `local` can refer to another PC. Without CDP, or for an inactive desktop profile, Desktop returns `source: "disk-cache"`, `complete: false`, `hasMore: null`, and `runtime: "unknown"`. An empty cache does not establish an empty account. `--all` exits nonzero when only a cache is available. Live API errors do not silently fall back to a cache.

Desktop and Headless project lists also share API pagination, normalization and validation. Both accept `projects list --timeout <seconds>` with a single traversal budget. Desktop uses the signed-in renderer; Headless uses its selected account profile.

Prefix with `headless` as needed; `web` remains a compatibility alias. Use `--json` for data output, `--help` for command options, and `--` before literal option-like messages.

```bash
doubao help
doubao skin on|off|status --json
doubao capabilities --json
doubao sessions list --json
doubao headless sessions list --all --json
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
| `--mode` | `goal` on Desktop/Headless; `chat`, `work` on Headless; create only |
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

`task.json` contains the native task fields; `patch.json` contains only the fields to change. See [JSON examples and supported fields](docs/headless.md#automatic-tasks). Create, update and delete verify server readback. An unconfirmed operation retains its ID/operation ID; inspect `list/get` before retrying.

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
- `--workspace`: existing local directory. Both backends use an explicit workspace first, then the saved workspace on the same device when the project is unchanged, then a current-device project folder, then a generated workspace. Selecting or clearing a project discards the inherited workspace. `--no-skills`: omit default local skill paths.
- Saved execution metadata is parsed consistently on both backends. Missing legacy metadata keeps follow-ups on cloud; malformed runtime/permission metadata fails before submission. Inherited local sessions from another device require an explicit `--runtime local` or `--runtime cloud`.
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
- `--mcp` requires a message; repeat `--mcp` each turn. New local conversations default to `AskOnRisk` on Headless and `FullAccess` on Desktop. Both backends inherit the saved local permission on follow-up unless `--permission` overrides it.
- Desktop MCP requires `--wait`; incompatible with `--attach`. Approvals occur in the app.
- Headless approvals require terminal input/output and `--wait`; without `--wait`, operations requiring approval are denied.
- Headless `FullAccess` requires explicit terminal confirmation each turn, including local task recovery; `--yes` cannot bypass it. Headless MCP `--env` values remain in the local store/process and are omitted from remote registration.
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
| `DOUBAO_CDP_ENDPOINT` | Desktop CDP URL; Work 9226, Doubao 9225 |
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

### Desktop skin

Desktop chat connections (including `cdp launch`) automatically apply an installed `doubao-skin` skill. Auto-loading defaults to on and preserves the last theme, including the native appearance. The skill must provide `src/integration.mjs`; `doubao skin status --json` reports its path and compatibility. Discovery is limited to the selected app's active profile (`.user_skills` then `.skills`); `DOUBAO_SKIN_ROOT` overrides the skill directory.

`doubao skin off` saves the preference and tries to restore the current desktop immediately; `on` enables it again. Theme selections and custom images are retained. Preferences live in `skin.json` under the CLI settings directory (`DOUBAO_CLI_CONFIG_DIR` overrides it). If the desktop is unavailable, the setting applies on the next connection. Help/version, offline commands, Web and Headless do not auto-load skins. This integration never installs a skill, restarts the app, or opens another debugging port. Skin failures do not fail the CLI command.
