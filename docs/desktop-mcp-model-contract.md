# Desktop protocol corrections and MCP diagnostics

**Current diagnosis (2026-10-30):** the failing Work MCP path has a demonstrated transport mismatch. Native runtime selects dispatcher and skips the legacy tool SSE connection; LocalHub still delivers the test's `connector.call` on `/alice/office/tool_local/chunk_stream`. A strictly filtered diagnostic listener plus the native MCP bridge and original-call result upload restored one real model-to-tool round trip without changing the dispatcher flag. This is causal diagnostic evidence, not a shipped CLI fix. New ordinary Doubao 2.34.4 also fails under dispatcher; historical SSE successes remain historical controls.

Observed in the running Doubao Work 2.34.6 renderer on 2026-10-29; source inspection was read-only and the live controls used dedicated test resources. Module IDs identify that build, not stable API names. No account identifiers, credentials or conversation contents are included here.

## Model selection and serialization

- Native submit module `66848` copies the selected catalog entry's `model_item_key` and complete `model_extra_params` into the outgoing message metadata.
- Native request serializer `316377` emits `option.model_config.model_item_key` and `model_extra_params` even when no reasoning override is supplied. An explicit `reasoning_effort` is a number in `model_config`.
- Its `aggregate_params` includes string values for `model_item_key`, `mode_id`, `agent_mode`, `reasoning_effort`, `conversation_mode` and `provider_id`.
- The observed Work mode is `mode_id: "3"`, `agent_mode: "1"`. Current custom models retain `model_type`, `provider_id`, `memory_profile`, `total_window_size` and `disable_cot_summary`. Astra and Sol entries have the same extra-parameter values; their model keys differ.

The CLI previously extracted only `provider_id` and emitted `model_config` only with a reasoning override. The correction preserves catalog metadata for an explicitly resolved model on both create and follow-up requests. The default `AUTOMATIC_MODEL_PROTOCOL` sentinel still means “inherit the saved model” on an unspecified follow-up; it must not become an explicit Auto selection.

Tests execute the real menu-extraction expression against a catalog fixture and the real injected request expression against a captured fetch body. They verify object/serialized metadata preservation, explicit custom models without reasoning, and absence of an Auto override on unspecified follow-ups.

## MCP catalog and selection

- `282314.ConnectorToolListMessageLifecyclePlugin` attaches `task_input_json.localConnectors` and `schema_version: 1` for local tasks.
- `4088` emits `{ connectorId, mcpToolsList }`; each tool has name/description and JSON-string `inputSchema`, optional annotations and meta. These fields match the CLI's existing MCP snapshot.
- The non-Lark connector toggle in `814523` updates account-level enabled state and refreshes the catalog. Per-conversation `connector_info_list` in this path is specific to Lark.
- No inspected native source establishes a requirement to add local MCP IDs to `selected_skills`, `skill_selections`, `leading_accessory_tags` or mention metadata. Those fields are not changed speculatively.

The model metadata mismatch is confirmed independently of the MCP outcome. A live MCP call must still be proved by the dedicated server log and matching tool result; this contract comparison alone is not E2E approval.

## Client identity versus sandbox environment

The native completion builder (`682436`) reads `general-agent:client-env-id` from runtime storage and initializes that single key with a UUID when absent. This client identity is distinct from the sandbox environment ID. Read-only inspection confirms the raw `window.neotix.runtimeStorage.get` bridge returns a string; the normalized service wrapper (`222399.n.get`) returns an `{ isOK, data }` result.

The CLI now reads that identity, accepts the two observed success shapes, and never substitutes `queryRuntimeInfo().env.environmentId`. When the key is absent, it initializes only that key and uses persisted readback; failed or malformed reads do not overwrite storage, and an unconfirmed write is not retried or returned as an established identity. The renderer's app/device identity is checked before any storage access. Missing storage APIs yield an empty client identity, matching native failure behavior.

Sandbox preparation still receives the actual sandbox environment ID. Tests exercise these two paths together to prevent conflating their identifiers again.

## Live diagnostic results

The current candidate passed 525 automated tests on each of Node 22.16.0 and Node 24.22.2, plus the Node 22 isolated-package check (125 help invocations). This does **not** establish Desktop MCP E2E success. Clean explicit Astra, GPT-5.6 Sol and native Doubao 2.1 Pro tasks all ended without an inbound `tools/call`; fixture logs include all requests, including rejected methods and tool names. The service's structured tool result reports “连接器暂时不可用”, with no pending approval.

Direct calls through the real native bridge succeeded from both the chat renderer and background execution page: each produced one matching `tools/call` and the expected echo. Native logs distinguish these successful dispatches from the failed model run, whose correlated logs contain no call dispatch or sandbox prepare/rekey failure. This narrows the problem to the path before native MCP dispatch; it does not establish a server root cause.

The native connector registration, sandbox create and conversation reconciliation signatures were checked against the current app. No missing client/device registration field was found. Model metadata, client identity and workspace namespace corrections remain independently justified protocol fixes, not a demonstrated MCP repair. Headless FullAccess and interactive permission cases remain deferred. A later Desktop control used the already-confirmed native default policy, without changing global permission or answering any prompt.

A fresh conversation sent using the native UI also completed with zero MCP calls. Its structured file-operation tool block returned the same “连接器暂时不可用” error, without a numeric error code; this is not inferred from assistant prose. Its captured native request contained the exact newly registered connector/tool and local runtime with AskOnRisk. This control did not reuse a CLI-created conversation or CLI-built completion request. Both the chat-renderer and background-page bridge controls succeeded independently. All diagnostic connectors were removed, test conversations archived, and the prior global permission preference restored. No permission dialog was approved.

## Registration state and SDK controls

The native detail endpoint reports local STDIO test connectors as enabled/installed, with `connect_status: 0` (Disconnected) and `auth_status: 2` (AUTH_REQUIRED), while their native local status is READY. Native UI modules explicitly prioritize local READY for these connectors and do not expose the normal remote-connect action. Thus these remote status fields alone do not establish a CLI registration defect.

A single diagnostic `AGWManageConnectConnector` call on a dedicated test connector returned `connected: true`; both its returned connector and subsequent detail read still had the same remote status fields. No approval prompt or credential was supplied. The connector was removed afterward.

The hand-written fixture's initialize, tools/list and tools/call response shapes pass the installed MCP SDK 1.32.1 schemas. To independently check transport behavior, an official SDK McpServer/StdioServerTransport echo control was prepared. The first run was interrupted by renderer navigation: its original accepted task was read back as terminal and resources were cleaned, but the run is excluded from causal evidence. A separate stable-page control used the SDK and the standard connect step. It negotiated MCP 2025-11-25, completed initialization/tools-list, and its model task completed with zero inbound tools/call. Same-run readback contained the same structured “连接器暂时不可用” result and no pending approval. Its connector was removed and conversation archived. This excludes neither all account-side failures nor every service issue, but it does not support blaming the hand-written fixture or a missing connect step.

## Remaining boundary

No client-side repair has restored model-to-MCP execution in these controls. The native UI reproduces the failure, and the service-visible tool result exposes no finer error code. Further client-side investigation compares a historical successful native MCP dispatch with current failures; service routing logs are unavailable. Repeating the same client test, weakening permissions, or adding a speculative compatibility patch would not establish that cause. The verified protocol corrections are kept separate from the unresolved model-to-MCP execution issue. Their automated checks do not establish MCP E2E success.

## Further execution-path controls

- Native high-level registration (`643755.yl`) was tested, including native registry/cache updates and READY revision waiting. Model-to-MCP execution still failed.
- A single AskOnRisk task successfully read a random value that was not included in its prompt, then failed MCP. Native logs confirm 6002 → Read → sandboxFs.fileReadTool → success → upload. Thus ordinary local execution and result delivery work in the same task.
- The Desktop user's existing always_allow preference and confirmed flag were read back before a pure-echo control. Using that already-confirmed Desktop policy also failed MCP. No global permission changed and no prompt was approved. This does not cover Headless's per-turn confirmation flow.
- Full native registration plus a fresh native UI submission, using that existing policy, also completed with zero actual MCP calls. Its connector and conversation were cleaned up.
- Actual dispatch runs in the app's independent `jsrt.mojom.Service`, loading bundled `entry-moa/main.js`, not the visible CDP background renderer. Its connector.call handler is registered and resolves LocalFile for both SSE and multi-env tool calls. Passive inspection of zero stream objects in the visible renderer is therefore not proof of transport failure.
- Observed 6003 command results being produced/uploaded do not establish business execution success. These commands include workspace synchronization; they must not be counted as MCP calls.

The precise completion response LogID was captured privately. A targeted Argos query was rejected for missing `argos.streamlog.view`; no service log contents were available. Relevant services reported in the permission response include `flow.moa.connector`, `flow.mcp.core`, `flow.mcp.proxy` and `flow.office.tool_localhub`. This leaves the service-side reason unknown; log access is not a prerequisite for continuing client-side protocol and transport comparisons. No alternate identity or tool was used to circumvent IAM. Private identifiers and IAM application URLs are excluded from this repository.

## Historical routing comparison

A successful native MCP call on 2026-10-28 was found in the DoubaoWork log directory: client version 2.34.1, delivery `sse`, real `read_image` dispatch, successful MCP response and result upload. The same log window contains the Work monitoring application identifier. Current 2.34.6 failed controls use dispatcher delivery. This correlation is not yet a demonstrated cause: ordinary local Read succeeds over dispatcher, and version, transport and tool differ.

An additional official SDK echo control omitted all MCP tool annotations and still completed with zero tool calls. Its dedicated resources were cleaned up. Tool annotations alone therefore do not explain the observed failure.

## Same-account ordinary Doubao control

The stopped, installed ordinary Doubao app was launched without restarting another app. A private identity comparison confirmed the same logged-in account. The candidate CLI passed real MCP execution for a new conversation, explicit-model follow-up and inherited-model follow-up using Doubao 2.1 Lite: three distinct inbound calls and matching echo results. The test connector was removed and conversation archived. Native logs for the accepted task identify SSE delivery. The app metadata reports 2.32.3 while the native event reports pc_version 2.32.6; these are recorded separately rather than assumed equivalent.

Opening a Work-created seed conversation initially made `models` fail because its saved model ID was absent from the ordinary app's live catalog. No connector or model request was created in that attempt. A fresh blank draft resolved the harness prerequisite. This is not an MCP repair.

These controls establish that the installed candidate and account can execute MCP through the ordinary app. They do not establish current Work acceptance or justify silently changing apps, transport flags or permission policy.

A second fresh control with Doubao 2.1 Pro also passed all three stages (new conversation, explicit-model follow-up, inherited-model follow-up), with three actual calls and matching results. Its connector removal and conversation archival were verified. This removes the model-name difference for the comparison with the earlier failing Work Pro control, while app and delivery remain different.

## Work 2.34.9 revalidation

The installed Work app changed to 2.34.9 during the investigation. Its current entry-moa runtime is 3.43.3 (SHA-256 `76eb1161412096173e9515c3c6129210757d2a2772b759900f248b3123a2303b`). A fresh same-account control kept the ordinary-app Pro test's model, low reasoning, AskOnRisk policy, single connector and hand-written echo fixture. The turn completed with zero actual MCP calls. Native logs for this accepted task contain dispatcher delivery and no connector.call event. Connector removal and conversation archival were verified. Follow-up stages were not run after the first-stage failure.

Current native source shows both apps select dispatcher only when the server AB value `enable_multi_env_client` is the string `1`; the default is SSE. Work does not hard-code dispatcher. Their native application identities and websocket connection tags differ (`desktop` versus `desktop_work`), so the same account need not receive the same routing configuration. Renderer-side AB values do not establish the independent native worker's active configuration.

Both native registries contain connector.call. The Work handler requires a string mcpResponseJson, whereas ordinary Doubao accepts a defined value; direct Work bridge controls returned the required string. Both connector reporters use V1 result upload. These differences occur after dispatch and do not explain the missing tool invocation. No global AB overrides, application identity spoofing, or signed-app patches were made. The evidence supports an app/routing-specific failure before local MCP execution, but does not identify the precise upstream availability check or prove dispatcher alone is responsible.

The native worker loads this server AB map through GetAB (`/samantha/user/ab/get`) and awaits its initialization before constructing the runtime. The map is private to that process, with no observed persisted cache or exposed read RPC. Its logged dispatcher choice establishes the string-1 branch at that time; reading the renderer map would test a different instance. Current 2.34.9 session readback again contains the structured unavailable-connector error.

## Dispatcher sequence and device registration audit (2026-10-30)

This audit made read-only native API calls and rechecked historical evidence; it did not submit another model task or change routing, permission, connector or device settings.

All 83 saved routing-log rows for the Work 2.34.9 Pro control were matched against their original local log files. Its main-agent ingress sequence is contiguous: sequences 0–6 carry `AGENT_CMD_CALL` (6003), and sequence 7 carries `AGENT_FINISHED` (6004). There are zero `AGENT_TOOL_CALL` (6002) messages in that sequence. The installed native source maps 6002 to `tool_call` and 6003 to `cmd_call`, and records ingress before publishing packets to the execution queue.

This is stronger evidence than a missing `connector.call` execution log: the observed main-agent stream has no sequence gap hiding a received tool invocation. It does not prove that the service never attempted delivery to another stream/device, or identify the upstream connector-availability decision. The existing native-UI failure and direct bridge success remain separate evidence.

A fresh native `AGWGetDeviceInfo` request targeting the current renderer's own Work device and application identity returned code 0, online true, control enabled, version 2.34.9, and supported commands including 6001–6005. Thus a missing device record or missing declaration of 6002 support is not supported by this readback. This current snapshot is not proof of historical registration state during every failed task.

`AGWAllDevices({all_pc_2:true})` omitted Work even though the direct Work-device lookup succeeded. The list alone is therefore insufficient to infer that Work is offline or unregistered. The detail's `authorized:false` field belongs to the dispatcher device record; this audit has not established its relevance to same-device local MCP. It must not be treated as a FullAccess/MCP permission failure or changed speculatively.

The remaining investigation boundary is the upstream selection/availability of the local connector and its destination application/device, before a 6002 invocation reaches the observed Work stream. No CLI repair is justified by these findings alone. Private evidence includes a rerunnable original-log sequence checker and native device readbacks; account/device IDs and raw logs are excluded from this document.

## Cross-application connector controls (2026-10-30)

Two preserved native-UI requests from the earlier Work controls were checked against their registration receipts and the current Work device identity. Both use local runtime, the Work application ID and the same Work device, and include exactly one matching entry for the dedicated registered connector and its echo tool. Their server message metadata also identifies Work. This rules out an obvious missing connector or wrong application/device in those captured requests; it does not reveal the service's eventual routing decision. The native create-personal-connector API accepts name/description/icon/config, with no separate target-app/device field in the inspected request body.

Fresh tests used the published CLI 0.23.0, a live verified same account, Doubao 2.1 Pro with low reasoning, AskOnRisk, a dedicated workspace, no skills and a synthetic read-only echo tool. No native permission prompt was approved and no global policy or routing flag changed.

| Connector creation | Execution app | Actual fixture calls | Structured result | Native delivery |
| --- | --- | ---: | --- | --- |
| Work | Ordinary Doubao 2.34.4 | 0 | Connector temporarily unavailable | dispatcher |
| Same Work-created connector | Work 2.34.9 | 0 | Connector temporarily unavailable | dispatcher |
| Ordinary Doubao, new independent connector | Ordinary Doubao 2.34.4 | 0 | Connector temporarily unavailable | dispatcher |

Both apps loaded the shared connector before submission. Each task reached completed state without a pending permission request; completed here describes the model task, not successful tool execution. Exact-run message readback contains the structured file-operation error. Each correlated native log has seven 6003 command ingress messages and one 6004 finish message, with no connector.call execution. The ordinary-owned control shows that the new ordinary-app failure is not explained solely by using a Work-created connector.

An initial attempt stopped before model submission because the ordinary app's local runtime was briefly not READY after connector refresh. It was excluded from the comparison and its connector removed. The new controls explicitly waited for local-runtime readiness. A readback during renderer navigation also failed transiently; the original accepted tasks were subsequently read back without resubmission. These harness failures remain in private evidence.

All three accepted test sessions were archived with verified readback. All three temporary connectors (including the pre-submission attempt's connector) were removed; subsequent native tool-catalog checks found zero remaining test connectors in either app. Original page URLs were restored.

The evidence now supports a regression shared by newer desktop clients or their dispatcher routing configuration, rather than a Work-only failure. Version and delivery still covary: historical ordinary-app and Work successes used SSE, while the current failures use dispatcher. A causal transport claim needs a supported control holding version/account/connector constant while changing only delivery, or an explanation of the upstream availability check. No transport override, identity spoofing, application downgrade or speculative CLI patch was introduced.

## Current Work connector lifecycle audit and native-registration control

The live Work renderer was inspected again on 2026-10-30. Its high-level registration service (643755), connector revision store (480281) and outcome waiter (129727) are byte-identical to the previously saved module sources. The native path creates a personal connector, updates its cache, requests a local-runtime refresh, and waits for a newer per-connector revision to reach READY. It has explicit install/start/authorization failure states. This richer UI lifecycle differs from the CLI's direct API/polling implementation, but is not itself evidence of a newly missing registration requirement.

The current message lifecycle plugin (282314) still reads tools through the native serializer (4088) and inserts `localConnectors` into `task_input_json` for local execution. A fresh dedicated connector was created using the current native high-level service, bypassing CLI registration. It returned ready, installed and enabled, runtime type local, and localRuntime READY with needAuth false. Native and CLI snapshots for this connector were compared with deep equality: the connector and complete tool definitions matched exactly.

A fresh Pro/low/AskOnRisk model task using this connector completed with zero actual fixture calls. Its structured file-operation result exposed the more specific error `LocalHub connector.call failed: Timeout` (error -1). Its native logs again contained seven 6003 ingress commands and one 6004 finish, dispatcher delivery and no connector.call dispatch.

Before removing the connector, a single direct call through the same Work native MCP bridge produced exactly one fixture call and the matching echo response. This direct call used a different diagnostic marker and is not counted as model execution success. The combination narrows this control to the LocalHub-to-client delivery/wait path: the registered local tool itself remains executable. It does not identify whether LocalHub selected the wrong destination, used an incompatible transport or failed for another upstream reason.

The test session was archived. The initial connector cleanup attempt failed its renderer-readiness check before mutation; after restoring the original page, cleanup succeeded with absent/disabled account state and runtime disconnection verified. No account authorization, global permission, routing override or application patch was used. A CLI migration to the richer native registration lifecycle may improve readiness/error handling, but these results do not justify claiming it fixes MCP execution.

## Demonstrated LocalHub/SSE delivery mismatch

Native `entry-moa/main.js` chooses dispatcher when server AB `enable_multi_env_client` is the string `1`. Its runtime sets `useLocalToolSSE` false in this case; `prepareSandboxForSend` requests a command-websocket reconnect instead of `Es().ensureConnected()`, and legacy execution-context SSE subscription is conditional on this flag. The legacy stream URL is `/alice/office/tool_local/chunk_stream`.

Two new controls used the unchanged installed Work 2.34.9 and native registration, model Pro/low, AskOnRisk, a dedicated synthetic echo connector and workspace. No application files, global AB values, identities or permission settings were changed.

1. **Observation:** a temporary SSE listener requested the dedicated sandbox using the native `device_id`/`client_attrs.sandbox_id` shape. HTTP 200 text/event-stream delivered `event_type:1`, `tool_call.name:connector.call`; its sandbox and connector matched the accepted test request. Native dispatcher still received only 6003 commands and 6004 finish. The observer did not execute the call. The model task timed out; the attempted later response was refused because the original task was already terminal.
2. **Positive control:** a separate task used a fresh connector. The diagnostic listener captured its exact sandbox/connector/tool/marker, checked the original task was running with no pending interaction, called only that synthetic read-only tool via Work's existing native MCP bridge, and uploaded the result using the original tool-call ID and sandbox. The fixture recorded exactly one call. The native upload endpoint returned HTTP 200/code 0. The task completed and its model reply contained the exact matching echo result. Native logs still showed dispatcher and zero native connector.call dispatches; the diagnostic bridge, not dispatcher, supplied the missing execution.

The SSE endpoint is **not demonstrated to isolate by the requested sandbox**. The positive control first received an older test connector's replayed frame; strict identity assertions rejected it before execution. The listener was resumed for the same accepted task with sandbox filtering and never executed that stale frame. The first result-upload attempt failed locally because the selected renderer service lacked the method; the already-produced native result was persisted, then uploaded once through the source-confirmed endpoint. The tool was not executed again. These harness failures are retained in private evidence and are not counted as successful controls.

The direct failure mechanism is now established for the tested Work setup: the MCP invocation is available on the legacy SSE channel that the dispatcher-selected native path does not connect to. Restoring only that delivery/execution/result path makes the same app/account/model work. The exact upstream ownership remains outside this evidence: it does not determine whether LocalHub should migrate connector calls to dispatcher or the native client should keep a separate MCP SSE subscriber. It also does not establish the onset release/AB rollout date.

Both new test sessions were archived and connectors removed. Readback across both installed apps found zero remaining diagnostic connectors and no temporary SSE probe globals. No persistent compatibility code or global setting change remains. A production workaround must address device-wide replay, ownership, duplicate execution, permissions, signed-frame validation, stream lifecycle and coexistence with native dispatch; the diagnostic listener must not be copied into the CLI as an unrestricted executor.

## CLI compatibility implementation (0.23.1 candidate)

The CLI now supplies a narrow connector-only relay for verified dispatcher tasks. It discovers fresh exact sandbox-to-command-to-delivery evidence in bounded native worker logs; renderer AB values and app version alone do not activate it. Normal native SSE tasks are left alone. It starts only after an accepted receipt and stays owned by that CLI wait. Ordinary non-MCP sends/waits do not load the relay.

All COMMAND frames and non-connector tools are ignored without acknowledgements. Tool calls require the issued sandbox, selected connector/tool, matching account/device envelope, a timestamp belonging to this turn, and the exact still-running accepted run with no pending interaction. The account/app/device is checked again at renderer operations. Signature identity checks are not cryptographic verification; native MCP likewise does not pass signed envelopes to the MCP bridge. Native command/file APIs are never invoked by this relay.

The adapter uses the app's authenticated fetch and native MCP bridge. Bounded buffers and a renderer watchdog clean up abandoned streams. A durable 0600 journal records started calls before invocation and stores results before upload. Replays never repeat a completed call; recovery retries only a saved result upload, and an uncertain started call is reported rather than reexecuted. A device-wide lease and journals live in the default per-user CLI state directory, shared across alternate config directories. Multiple CLI processes cannot own that device stream concurrently.

AskOnRisk and AlwaysAsk require the explicit terminal approval callback used by the existing local runtime. Missing TTY, denial, EOF and cancellation do not authorize tool execution; readOnlyHint is not an approval. FullAccess retains the Desktop policy selected for the turn. Task activity is rechecked after approval. Interrupting CDP cannot prove a native tool stopped, so its execution record is retained rather than replayed.

Limits: the CLI must be able to read fresh native worker delivery evidence. Truncated/unavailable logs and conflicting transport evidence fail closed. In particular, an already-pending task recovered in a new CLI process may lack fresh dispatcher events; `sessions wait` must not assume old routing is still active after an app restart. This is an explicit recovery limitation, not permission to resend an accepted task.

Validation: Node 22.16.0 and 24.10.0 each passed 578 automated tests, including ownership, replay, cross-task filtering, permission denial, uncertain execution recovery, device leases, account changes, bounded transport, delayed history persistence, invalid timestamps and non-MCP isolation. The startup window is separate from the native evidence timestamp; only `turn_unavailable` is retried during admission. Live Work 2.34.9 candidate tests passed new conversation, explicit-model follow-up and inherited-model follow-up: each produced exactly one real echo call and matching model result. A separate AlwaysAsk task without TTY produced zero native calls and a journaled/uploaded PERMISSION_DENIED result. After the admission fixes, a final Work candidate run again completed with exactly one real echo call and the matching model reply. Dedicated sessions/connectors were cleaned up. Initial native-log parsing and pre-submission CDP readiness failures remain preserved separately; they are not relabeled as passes.

Production package checks passed on Node 22 and 24: isolated installs without development dependencies, 125 help entry points, compatibility aliases, and detached-worker startup to the expected isolated login-required result. These package checks do not constitute a fresh account login or npm publication.
