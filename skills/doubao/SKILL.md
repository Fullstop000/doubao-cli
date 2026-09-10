---
name: doubao
description: "Drive the local Doubao desktop app on macOS through the `doubao` CLI. Use when the user wants to message Doubao from an agent or script: create, list, read, or send to Doubao chat sessions, attach files, or switch the model. Requires macOS with Doubao.app installed and logged in; message automation additionally needs the app's CDP endpoint (setup covered inside)."
---

# Doubao CLI

`doubao` controls the local, already logged-in Doubao desktop app over a localhost CDP endpoint. No API keys or credentials are involved. Requires macOS, Node.js 22+, Doubao.app.

If the CLI is missing: `npm install --global doubao-cli@latest` (or prefix commands with `npx --yes doubao-cli@latest`).

## Readiness check (do this first)

```bash
doubao status --json        # app installed / running / version / profile
doubao capabilities --json  # per-feature availability; cdp.available gates messaging
```

If `cdp.available` is false, run `doubao cdp launch --yes` (quits and relaunches Doubao with the debugging port; `--yes` is required in non-interactive use). Use `DOUBAO_CDP_ENDPOINT` for a non-default port.

## Command routing

Pass `--json` to every data-returning command when another program consumes the output.

| Task | Command |
| --- | --- |
| List sessions | `doubao sessions list --json` |
| Current session | `doubao sessions current --json` |
| Create session with first message | `doubao sessions create "..." --wait --json` |
| Blank draft session | `doubao sessions create --json` (returns `conversationId: null`) |
| Send to a session | `doubao sessions send <id> "..." --wait --json` |
| Read messages | `doubao sessions read <id> --limit 20 --json` |
| Reveal session in the app | `doubao sessions open <id>` |
| List / show models | `doubao models --json` / `doubao model --json` |
| Switch model | `doubao model select <model> --json` or per-send `--model <model>` |
| Set reasoning effort | `doubao model reasoning <level> --json` or `--reasoning <level>` on select/send/create |
| Update the CLI | `doubao update` (`update check`, `update auto on`) |

## Behavior notes

- Add `--wait` to block until the assistant reply completes and return it as `reply`; omit it to return once the user message is accepted (`reply: null`). Default timeout is 120 s; raise with `--timeout <seconds>`.
- Prefer `sessions create "first message"` over create-then-send: a conversation id exists only after the first message.
- Session operations never raise the Doubao window; only `sessions open` brings the app to the front intentionally.
- Prefix the message with `--` when it begins with option-like text: `doubao sessions send <id> -- "--model means what here"`.
- Select a non-default local profile with `--profile "Profile 1"` (directory or display name).
- Repeat `--attach <path>` for attachments (max 50 files, 100 MiB each). The CLI uploads through the app's drop path and confirms the upload before sending; attachments take the slower UI path while plain text uses the direct protocol path.
- The composer auto-inserts spaces at CJK/latin boundaries; verify content with `sessions read` rather than raw string comparison.

## Model values

Accept the value, exact display name, or an alias anywhere `<model>` appears. Confirm availability with `doubao models --json` — the installed app version decides what exists.

Reasoning effort levels: `low` (低), `medium` (中), `high` (高), `ultra` (极高), `max` (最高). `--reasoning` on `sessions send` requires `--model` and is incompatible with `--attach`; `model reasoning <level>` changes the current session without switching models.

| Model | Value | Aliases |
| --- | --- | --- |
| 自动 | `auto` | `自动` |
| 豆包 2.1 Turbo | `doubao-2.1-turbo` | `turbo` |
| 豆包 2.1 Pro | `doubao-2.1-pro` | `pro` |
| Orange 5.0 | `orange-5.0` | `orange` |
| Gemini 3.7 Flash | `gemini-3.7-flash` | `gemini` |
| GPT-5.6 Sol | `gpt-5.6-sol` | `gpt`, `sol` |

## Environment overrides

- `DOUBAO_APP` — Doubao.app path (default `/Applications/Doubao.app`)
- `DOUBAO_DATA_DIR` — Doubao user-data directory
- `DOUBAO_CDP_ENDPOINT` — CDP endpoint (default `http://127.0.0.1:9225`)
- `DOUBAO_CLI_CONFIG_DIR` — CLI settings directory
- `DOUBAO_CLI_DISABLE_AUTO_UPDATE=1` — skip configured auto updates (CI)

## Troubleshooting

- `Doubao CDP is unavailable` → run `doubao cdp launch --yes`.
- `no Doubao chat page found` → CDP is up but no chat window exists; open Doubao once, then retry.
- Commands break after a Doubao.app update → the app changed its DOM/API surface; run `doubao update check` for a fixed CLI release.
- CDP is unauthenticated but bound to 127.0.0.1; quit and relaunch Doubao normally when automation is no longer needed.
