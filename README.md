# doubao CLI

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

Set `DOUBAO_CDP_ENDPOINT` if using another port. `sessions send --wait` waits for and returns the completed assistant reply.

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

CDP is unauthenticated but bound to `127.0.0.1`. Quit and relaunch Doubao normally when automation is no longer needed.

## How it works

- Session ids and titles are read directly from Doubao's local IndexedDB cache.
- The current session is recovered from Chromium's local session store.
- Opening a session uses Doubao's registered `doubao://doubaoapp/open-url` deep-link router.
- Model discovery and selection use the renderer's semantic menu attributes and native CDP input events.
- New sessions use Doubao's blank `/chat` route and return the id assigned after the first confirmed send.
- Attachments are transferred into the renderer through its drop-upload path; file contents and credentials are never printed.

No hard-coded UI coordinates, image recognition, Cookie extraction, or private credential copying are involved.

## Limits

Message read/send and attachment upload use stable DOM attributes in the authenticated Doubao renderer over localhost CDP. A Doubao update can change these selectors. The CLI treats image previews and file cards separately, waits for their respective upload completion signals, and verifies both the exact user message and sent attachment count before reporting success. The CLI currently accepts up to 50 attachments per command and files up to 100 MiB each; the Doubao service can impose stricter type or size limits.

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
