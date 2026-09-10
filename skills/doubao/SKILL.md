---
name: doubao
description: "Drive the local Doubao desktop app on macOS through the `doubao` CLI (doubao-cli). Use when the user asks to message Doubao, create/list/read Doubao chat sessions, attach files to a conversation, switch the active model, or check whether Doubao automation is available. Covers CDP setup, session and message flows, model selection, attachments, self updates, and troubleshooting."
---

# Doubao CLI

`doubao` gives programmatic access to the **local, already logged-in** Doubao desktop app on macOS. It talks to the app over a localhost Chrome DevTools Protocol (CDP) endpoint; there is no cloud API key and no credential handling. Requires macOS, Node.js 22+, and Doubao.app installed with an active login.

## Readiness check (do this first)

```bash
doubao status --json        # app installed / running / version / profile
doubao capabilities --json  # per-feature availability; cdp.available is the gate
```

If `capabilities` shows `cdp.available: false`, message automation is off until Doubao runs with the debugging port:

```bash
doubao cdp launch --yes
```

This quits and relaunches Doubao with `--remote-debugging-port=9225` and returns only when the authenticated chat renderer is ready. `--yes` is required in scripts and `--json` mode because the restart otherwise asks for confirmation. Use `DOUBAO_CDP_ENDPOINT` for a non-default port.

## Command routing

All data-returning commands support `--json`; always pass it when another program consumes the output.

| Task | Command |
| --- | --- |
| List local sessions | `doubao sessions list --json` |
| Current session | `doubao sessions current --json` |
| Create + send first message | `doubao sessions create "..." --wait --json` |
| Blank draft session | `doubao sessions create --json` (returns `conversationId: null`) |
| Send to a session | `doubao sessions send <id> "..." --wait --json` |
| Read messages | `doubao sessions read <id> --limit 20 --json` |
| Reveal a session in the app | `doubao sessions open <id>` |
| List models | `doubao models --json` |
| Current model | `doubao model --json` |
| Switch model | `doubao model select <model> --json` or per-send `--model <model>` |
| Self update | `doubao update check` / `doubao update` / `doubao update auto on` |

Behavior notes that matter for automation:

- `--wait` makes create/send block until the assistant reply completes and returns it as `reply`; without it the command returns as soon as the user message is accepted (`reply: null`). Default timeout is 120 s; override with `--timeout <seconds>`.
- A numeric conversation id exists only after the first message is sent. Prefer `sessions create "first message"` over create-then-send.
- All session operations run without raising the Doubao window; only `sessions open` intentionally brings the app to the front.
- Prefix the message with `--` when it starts with option-like text: `doubao sessions send <id> -- "--model means what here"`.
- `--profile "Profile 1"` (directory name or display name) selects a non-default local Doubao profile.
- Attachments: repeat `--attach <path>`; up to 50 files, 100 MiB each. The CLI uploads through the app's drop path and confirms the upload before sending. Attachments force the UI path; plain text uses the faster protocol path.
- The composer auto-inserts spaces around CJK/latin boundaries; verify content by `sessions read`, not by comparing raw strings.

## Model values

Use the value, exact display name, or alias anywhere `<model>` is accepted. Run `doubao models --json` for what the installed app actually exposes.

| Model | Value | Aliases |
| --- | --- | --- |
| 自动 | `auto` | `自动` |
| 豆包 2.1 Turbo | `doubao-2.1-turbo` | `turbo` |
| 豆包 2.1 Pro | `doubao-2.1-pro` | `pro` |
| Orange 5.0 | `orange-5.0` | `orange` |
| Gemini 3.7 Flash | `gemini-3.7-flash` | `gemini` |
| GPT-5.6 Sol | `gpt-5.6-sol` | `gpt`, `sol` |

## Environment overrides

- `DOUBAO_APP` — path to Doubao.app (default `/Applications/Doubao.app`)
- `DOUBAO_DATA_DIR` — Doubao user-data directory
- `DOUBAO_CDP_ENDPOINT` — CDP endpoint (default `http://127.0.0.1:9225`)
- `DOUBAO_CLI_CONFIG_DIR` — CLI settings directory
- `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` — skip configured auto updates (CI)

## Troubleshooting

- `Doubao CDP is unavailable` → run `doubao cdp launch --yes`.
- `no Doubao chat page found` → the app is running with CDP but no chat window exists; open Doubao once, then retry.
- Commands suddenly failing after a Doubao.app update → the app changed its DOM/API surface; run `doubao update check` for a fixed CLI release.
- CDP is unauthenticated but bound to 127.0.0.1; quit and relaunch Doubao normally when automation is no longer needed.

Install/upgrade: `npm install --global doubao-cli@latest` or one-off `npx --yes doubao-cli@latest status`.
