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

The native connector registration, sandbox create and conversation reconciliation signatures were checked against the current app. No missing client/device registration field was found. Model metadata, client identity and workspace namespace corrections remain independently justified protocol fixes, not a demonstrated MCP repair. FullAccess and interactive permission cases remain deferred.

A fresh conversation sent using the native UI also completed with zero MCP calls. Its structured file-operation tool block returned the same “连接器暂时不可用” error, without a numeric error code; this is not inferred from assistant prose. Its captured native request contained the exact newly registered connector/tool and local runtime with AskOnRisk. This control did not reuse a CLI-created conversation or CLI-built completion request. Both the chat-renderer and background-page bridge controls succeeded independently. All diagnostic connectors were removed, test conversations archived, and the prior global permission preference restored. No permission dialog was approved.

## Registration state and SDK controls

The native detail endpoint reports local STDIO test connectors as enabled/installed, with `connect_status: 0` (Disconnected) and `auth_status: 2` (AUTH_REQUIRED), while their native local status is READY. Native UI modules explicitly prioritize local READY for these connectors and do not expose the normal remote-connect action. Thus these remote status fields alone do not establish a CLI registration defect.

A single diagnostic `AGWManageConnectConnector` call on a dedicated test connector returned `connected: true`; both its returned connector and subsequent detail read still had the same remote status fields. No approval prompt or credential was supplied. The connector was removed afterward.

The hand-written fixture's initialize, tools/list and tools/call response shapes pass the installed MCP SDK 1.32.1 schemas. To independently check transport behavior, an official SDK McpServer/StdioServerTransport echo control was prepared. The first run was interrupted by renderer navigation: its original accepted task was read back as terminal and resources were cleaned, but the run is excluded from causal evidence. A separate stable-page control used the SDK and the standard connect step. It negotiated MCP 2025-11-25, completed initialization/tools-list, and its model task completed with zero inbound tools/call. Same-run readback contained the same structured “连接器暂时不可用” result and no pending approval. Its connector was removed and conversation archived. This excludes neither all account-side failures nor every service issue, but it does not support blaming the hand-written fixture or a missing connect step.

## Remaining boundary

No client-side repair has restored model-to-MCP execution in these controls. The native UI reproduces the failure, and the service-visible tool result exposes no finer error code. The next useful evidence is the service's connector availability/routing decision for one saved failing run. Repeating the same client test, weakening permissions, or adding a speculative compatibility patch would not establish that cause. The verified protocol corrections are kept separate from the unresolved model-to-MCP execution issue. Their automated checks do not establish MCP E2E success.
