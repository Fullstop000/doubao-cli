# Headless backend

`doubao headless` uses Node.js HTTPS requests, service cookies, IM snapshots and SSE streams. It does not launch or connect to a browser or desktop app. Linux selects it by default; the existing macOS defaults are retained.

## Authentication

- Default: terminal QR from Passport, followed by read-only status polling and account verification. The user scans and approves on their phone. CLI does not submit scan/confirmation operations.
- Alternative: `login --cookie-file <path>` or `DOUBAO_HEADLESS_COOKIE` for an existing account session.
- Saved identity is verified against `/passport/account/info/v2/` before account operations. An expired session or changed account fails explicitly. Cookie values are never returned in command results.
- Cookie domain/path/expiry and trusted HTTPS origins constrain outbound credentials. Redirects cannot send credentials to arbitrary sites. Login expiry requires signing in again.
- Credentials are saved atomically under the configuration directory with mode 0600; the headless directory uses mode 0700. Recovery files contain request content and are scoped to platform, service endpoint and account.

## Commands and boundaries

| Available | Not exposed |
| --- | --- |
| Ordinary chat; cloud Work | Linux local tool runtime; desktop sandbox |
| Recent sessions; up to 100 recent messages | Full history export; UI current/open |
| Live model catalog; selection by ID or exact name | Model aliases; reasoning selection |
| Create/send/status/wait/stop; reply schema checks | Attachment uploads; projects; enterprise knowledge selection |
| Terminal QR; cookie import; local logout | MCP; answering task approval/forms from CLI |

Sending to a desktop local-runtime conversation is rejected. Tasks awaiting user input return `waiting_input` and a nonzero wait exit code; this adapter cannot answer their interactive controls.

## Recovery and completion

A send is attempted once. The SSE ACK pins server conversation and question IDs and immediately checkpoints the receipt. Work streams capture async handoffs and controls. Wait uses server snapshots, follows linked task threads, and uses the original request with `is_recovery=true` when a synchronous stream needs reconnection. It preserves the original message IDs, content and unique key.

Only terminal server state is successful. Thinking descendants are excluded from reply text. A transport timeout never cancels or resends the task. Cancellation addresses the pinned root and child IDs, then reads the server state again. `stopped:true` on an already completed task does not claim cancellation.

The adapter uses the service's observed Work protocol revision (`pc_version` / `doubao_pc_version` 2.31.10) to request structured messages and the live model catalog. These fields are protocol compatibility metadata; no installed client is consulted. The service is private and may change.

## Acceptance, 2026-10-10

- Pure Node HTTP: authenticated account lookup, session list, model catalog, new chat, follow-up chat, new cloud Work, model 5 selection and JSON reply validation passed.
- Cloud result: `38446481515031810` / `58110026190228738`, `HEADLESS_CLOUD_OK`. New-conversation identity differed from the source desktop session.
- Chat result: `38446428244786178`; first reply `HEADLESS_CHAT_OK`, follow-up `HEADLESS_FOLLOWUP_OK`.
- Model/JSON result: `38446481494493442` / `58114893028244226`, final `{"ok":true}`, `replyValid:true`.
- Timeout recovery: the original cloud turn was resumed by ID in another process. The final server reply was read without resending.
- Cloud calculation turn: `38446464005040130` / `58115199990398466`; server reply completed; stop read back its terminal completed state. The model's claim that Python ran is not independent proof of tool execution.
- Ordinary-chat cancellation: `38446446463869186` / `58114849878163970`; returned `status:cancelled`, `stopped:true`, verified from server readback. Live nested Work-child cancellation has not been covered.
- Linux QR: fresh anonymous HTTP bootstrap, issuance, phone scan/approval, confirmed polling, account verification and saving the resulting session passed. Generated request IDs were used; no app/browser credentials were imported. The resulting credential file is owned by the CLI user with mode 0600 and parent directories mode 0700.
- Fresh Linux processes with `DOUBAO_HEADLESS_COOKIE` unset reused the QR session for status, seven live models, five recent sessions, chat and cloud Work. Chat `38446481913278466` / `58107226726788354` returned `LINUX_QR_CHAT_OK`; Work `38446363878547202` / `58106696513435650` returned `LINUX_QR_WORK_OK`. Both server states were completed.
- Local Node 22.16.0 and Linux x86_64 Node 23.7.0: the complete suite passed 239/239 on each host, including a fresh Linux `npm ci`. Desktop tests select their intended backend explicitly; Linux default behavior is tested separately.
- Implicit Linux backend selection, unauthenticated status, capabilities and help passed. Installing the 0.15.0 npm tarball into an isolated prefix and invoking its `doubao` executable also passed. No existing account credentials were transferred there. Authenticated HTTP acceptance ran on both Linux and macOS; the HTTP backend did not connect to CDP.

Test side effects: several synthetic acceptance conversations remain in the account. The first raw protocol probe omitted the complete creation metadata, so the service appended a synthetic `HEADLESS_HTTP_OK` test turn to existing conversation `38446393744786434` (question `58110115407994626`). Production requests now include the verified creation metadata. No session was deleted.

This document records source acceptance. Registry installation and release results are verified separately when publishing.
