# doubao CLI

Programmatic access to local sessions in the macOS Doubao desktop app.

## Install

Requires macOS, Node.js 22 or newer, and the Doubao desktop app.

```bash
npm install --global doubao-cli@latest
doubao --version
```

Upgrade an existing installation with the same command. To run without a global install:

```bash
npx --yes doubao-cli@latest status
```

## Commands

```bash
doubao status
doubao profiles
doubao sessions list
doubao sessions current
doubao sessions open 38439138239851266
doubao sessions read 38439138239851266 --limit 5
doubao sessions send 38439138239851266 "hello"
doubao sessions send 38439138239851266 "hello" --wait
doubao cdp status
doubao cdp launch
doubao capabilities
```

Every data-returning command supports `--json`. Select a non-default local profile with `--profile "Profile 1"` or its display name.

Message automation requires Doubao to be launched with local Chrome DevTools Protocol enabled:

Quit any running Doubao process first, then run `doubao cdp launch`. The equivalent manual command is `open -a /Applications/Doubao.app --args --remote-debugging-port=9225`.

Set `DOUBAO_CDP_ENDPOINT` if using another port. `sessions send --wait` waits for and returns the completed assistant reply.

CDP is unauthenticated but bound to `127.0.0.1`. Quit and relaunch Doubao normally when automation is no longer needed.

## How it works

- Session ids and titles are read directly from Doubao's local IndexedDB cache.
- The current session is recovered from Chromium's local session store.
- Opening a session uses Doubao's registered `doubao://doubaoapp/open-url` deep-link router.

No UI coordinates, image recognition, Cookie extraction, or private credential copying are involved.

## Limits

Message read/send uses stable DOM test ids in the authenticated Doubao renderer over localhost CDP. A Doubao update can change these selectors. The CLI verifies that the exact user message appears in the target conversation before reporting success.

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
