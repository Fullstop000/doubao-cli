# Desktop protocol corrections and MCP diagnostics

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
