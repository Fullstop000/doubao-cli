# doubao CLI

[![skills.sh](https://img.shields.io/badge/skills.sh-doubao-black)](https://skills.sh/Fullstop000/doubao-cli)

Programmatic access to local sessions in the macOS Doubao desktop app.

## Install

Requires macOS, Node.js 22 or newer, and the Doubao desktop app.

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
doubao sessions stop 38439138239851266
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

Every data-returning command supports `--json`. Select a non-default local profile with `--profile "Profile 1"` or its display name.

Message automation requires Doubao to be launched with local Chrome DevTools Protocol enabled:

```bash
doubao cdp launch
```

If Doubao is already running without CDP, the command asks for confirmation before quitting it and relaunching with the debugging port enabled. Scripts and `--json` mode never prompt; pass `doubao cdp launch --yes` to confirm the restart explicitly. The command returns only after both the CDP endpoint and authenticated chat renderer are ready. The equivalent manual sequence is to quit Doubao completely and run `open -a /Applications/Doubao.app --args --remote-debugging-port=9225`.

Set `DOUBAO_CDP_ENDPOINT` if using another port. `sessions send --wait` waits for and returns the completed assistant reply; a reply stream that ends without Doubao's completion event, or a reply that does not finish within `--timeout`, is reported as an error (with the partial text attached) rather than returned as success, and the CLI makes a best-effort attempt to stop the server-side generation afterwards. `sessions stop` cancels an in-flight generation explicitly.

`--expect-json` fails the command (exit code 1, `replyValid: false`) when the waited reply is not valid JSON; `--reply-schema <path>` additionally checks it against a JSON schema subset (`type`, `required`, `properties`, `enum`, `items`). Both require `--wait`.

`--workspace <path>` stores the new session's agent workspace under a caller-chosen directory instead of `~/Doubao/chats/<date>`, and `--no-skills` drops the default local skill paths from the request. Both only affect newly created conversations, and agent mode itself stays enabled — the CLI does not currently offer a plain-chat mode.

### Local MCP connectors

The CLI can register a local stdio MCP server as a Doubao personal connector and let the model call its tools:

```bash
doubao mcp register my-tools --command /usr/local/bin/node --arg /path/to/server.mjs --env TOKEN=secret
doubao mcp list
doubao sessions create "use my tool to ..." --mcp 369247068674 --wait
doubao mcp remove 369247068674
```

`mcp register` waits until the app's native MCP runtime reports the connector READY and prints its connector id. Passing `--mcp <connector-id>` (repeatable) to `sessions create`/`sessions send` snapshots the connector's tool catalog into the request and prepares the local sandbox route, so model-issued tool calls execute against the local server without UI approval prompts. `--mcp` is incompatible with `--attach`. Connectors are account-level and visible in the Doubao settings UI; there is no delete API, so `mcp remove` disconnects and disables. Connector support depends on undocumented app internals (verified against Doubao 2.29.12 and 2.30.1) and may break when the app updates.

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

`sessions create` opens a clean composer. A numeric conversation id does not exist until the first message is sent, so `sessions create` without a message returns `conversationId: null`. Create and persist a session in one command by providing its first message:

```bash
doubao sessions create "Start a new task" --model gpt-5.6-sol --wait --json
```

Attach one or more local files by repeating `--attach`. The CLI validates each path, transfers the file through the authenticated renderer, waits for Doubao to finish uploading it, and only then sends the message:

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

Use the value, exact display name, or a short alias anywhere `<model>` is accepted. Run `doubao models` to verify the choices exposed by the installed Doubao version.

Adjust the reasoning effort (推理强度) with `--reasoning`, or change it for the current session with `model reasoning`:

```bash
doubao model reasoning high
doubao model select pro --reasoning max
doubao sessions send 38439138239851266 "hello" --model turbo --reasoning low --wait
```

Levels are `low` (低), `medium` (中), `high` (高), `xhigh` (极高), and `max` (最高); display names and raw API values work too. `--reasoning` on `sessions send` requires `--model`, and it is not supported together with `--attach`.

CDP is unauthenticated but bound to `127.0.0.1`. Quit and relaunch Doubao normally when automation is no longer needed.

## How it works

- Session ids and titles are read directly from Doubao's local IndexedDB cache.
- The current session is recovered from Chromium's local session store.
- Opening a session uses Doubao's registered `doubao://doubaoapp/open-url` deep-link router.
- Sending and creating sessions issue `chat/completion` requests directly inside the authenticated renderer, where the app's own request-signing hook attaches its risk-control parameters; the reply is parsed from the SSE event stream rather than scraped from the DOM.
- Model selection uses the conversation-level `im/conversation/modify` API when a current session exists, and falls back to the renderer's menu UI otherwise.
- Attachments are transferred into the renderer through its drop-upload path; file contents and credentials are never printed.

No hard-coded UI coordinates, image recognition, Cookie extraction, or private credential copying are involved.

## Limits

Message send/create and model selection use Doubao's own HTTP APIs from inside the authenticated renderer; message read and attachment upload use stable DOM attributes over localhost CDP. A Doubao update can change either surface. The CLI treats image previews and file cards separately, waits for their respective upload completion signals, and verifies both the exact user message and sent attachment count before reporting success. The CLI currently accepts up to 50 attachments per command and files up to 100 MiB each; the Doubao service can impose stricter type or size limits.

## Development

```bash
npm test
```

Override discovery paths when testing:

```bash
DOUBAO_APP=/path/to/Doubao.app DOUBAO_DATA_DIR=/path/to/user-data doubao status
```

## License

MIT © 2026 Fullstop000
