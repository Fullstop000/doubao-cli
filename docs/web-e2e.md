# Web platform live acceptance

Run each mode on each signed-in account, where that account exposes the mode. Select the account and one matching chat tab before starting. The runner invokes `doubao web` and never chooses or launches a browser. `doubao --platform web` remains a compatibility alias. It accepts an explicit localhost HTTP CDP endpoint on any port, including the default 9227, and uses isolated `.e2e/web/<account>` config/output. `--run-label <label>` stores evidence under `.e2e/web/<label>/<account>`; labels use 1 to 64 lowercase letters, digits, or hyphens. Reuse the same label to continue its state and append evidence; its saved identity pin rejects account or endpoint changes. Use a fresh label for a new lifecycle. Repeating an accepted create/send under a labeled run is blocked so recovery uses the saved IDs. Do not start with an unsent draft or active generation.

Run `doubao web login` before the matrix to start or reuse the dedicated browser and complete website sign-in. It waits up to 120 seconds and keeps the browser open on timeout. The matrix runner itself requires a ready signed-in browser. After a manual login and browser relaunch, `login-reuse` checks that login reuses the already-running browser, remains ready, and reports the same account, endpoint, and selected target. It fails if CDP is not ready and never launches a browser. Login has separate acceptance checks for authenticated reuse, no-tab creation, an empty profile launch, anonymous timeout with its page preserved, target ambiguity, external origin rejection, and shared deadlines.

Every invocation requires `--mode`, `--account-label`, and `--stage`. `create` and `send` use a fixed synthetic prompt asking for an exact token without tools or artifacts. They run once; failures never trigger resends. Default subprocess timeout is 120 seconds. `--timeout 1..120` controls the CLI timeout; a watchdog terminates the child within 20 seconds after that deadline and escalates to kill after 1.5 seconds. Results contain checks and synthetic markers, not sidebar contents or raw replies. A mutation's conversation and run IDs are saved as soon as its JSON contains both numeric IDs, before exit-code or response-shape assertions. `localMessageId` is stored as an opaque bounded string, commonly a UUID, and is not assumed numeric. Failed checked stages write a redacted `failure-stage.json` with the known IDs, state, `accepted`, `sendAttempted`, and safe error/message summary to guide recovery.

```sh
# Choose a fresh private profile and an unused localhost CDP port for manual sign-in.
export DOUBAO_CLI_CONFIG_DIR="$PWD/.e2e/web/fresh-chat/a/config"
export DOUBAO_WEB_PROFILE_DIR="$PWD/.e2e/web/fresh-chat/a/profile"
export DOUBAO_CDP_ENDPOINT=http://127.0.0.1:9233
node bin/doubao.mjs web login --timeout 120 --json
# Complete sign-in in the opened browser; assert loggedIn, ready, and a nonzero accountId.
# Close only this dedicated browser, then relaunch the same profile on port 9233:
node bin/doubao.mjs web login --timeout 120 --json
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage login-reuse
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage inspect
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage cdp-reuse
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage blank
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage create
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage wait --which create
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage send
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage wait --which send
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage read
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage open
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage current
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage list
node scripts/e2e-web.mjs --mode chat --account-label A --run-label fresh-chat --stage status --which send
```

Repeat with `--mode work` on the same account and label. Work create selects `--mode work`; Work send specifies `--runtime cloud`. `--target <id>` pins one tab when CDP reports multiple matches. `blank` opens an unsaved blank conversation; do not send a message into it. `stop` always invokes the CLI for the selected accepted run, including an already-completed run. A `stopped: true` result means the server reports a terminal tree with no running or unknown nodes; it does not mean every node was cancelled. Report `cancelled` only when the returned state is cancelled; report completed work as `completed`. Optional `--id` and `--run` must match the saved synthetic conversation/run.

## Acceptance matrix

| Stage | Passing evidence |
| --- | --- |
| `login-reuse` | Starts only after status preflight is ready. `doubao web login` confirms `loggedIn` and `ready`, reuses the browser (`launched: false`), and preserves account ID, endpoint, and target when status supplied one. |
| `inspect` | Signed-in account, ready page, requested composer mode, required capabilities, current-session shape, and sidebar list shape are valid. Only sidebar count is recorded. |
| `cdp-reuse` | CDP is already available; `cdp launch` reuses it (`launched: false`) and returns the same account. It never launches a browser when CDP is absent. |
| `blank` | Blank creation returns `created: true`, `persisted: false`, and no conversation ID. |
| `create` / `send` | Native submission is accepted with numeric conversation/run IDs and a nonempty bounded local-message ID. Create is persisted; send keeps the same conversation and gets a new run. IDs and marker are saved before later response validation. |
| `wait` | Exact selected run reaches `completed`; assistant reply exactly matches its synthetic marker. `--which create|send` selects the saved run. |
| `read` | Each saved user marker appears; each completed run has the exact assistant marker. Message text is not saved to results. |
| `open` / `current` / `list` | Open and current identify the saved conversation; rendered sidebar includes it. |
| `status` | Saved conversation and selected run IDs match; state is a known running or terminal state. |
| `stop` | Calls stop for the selected run even if it is already complete. Success requires `stopped: true` and zero running/unknown task counts. Terminal-tree confirmation alone does not prove cancellation. |

On a failed or timed-out create/send, inspect its recorded result and the selected Web conversation before any further action. If accepted IDs were saved, use `status`/`wait`; never resend to recover. Results and state are under `.e2e/web/<account>/` by default or `.e2e/web/<label>/<account>/` with `--run-label`; do not commit them.

Guardrails for unsupported Web options, malformed IDs, wrong runtime/mode, login/readiness, draft/generation, and target ambiguity are covered by unit tests and can be spot-checked only in a safely prepared synthetic page. Do not create a draft or generation solely to probe a guard. The runner's stop case is optional and must target only its own synthetic run.

The live matrix covers the CLI-supported `status`, `capabilities`, CDP status/reuse, and sessions list/current/open/read/create/send/status/wait/stop. Uploads, model selection, enterprise knowledge, local runtimes, MCP, workspaces, profiles, and desktop-only settings remain unsupported by the Web adapter.
