# Task context verification

Verified 2026-09-25 using Node 22.16.0, DoubaoWork 2.30.5 (9226) and Doubao 2.31.1 (9225). This is source verification, not a published-release claim.

| Check | Evidence |
| --- | --- |
| Local execution, default FullAccess | A shell call wrote `LOCAL_RUNTIME_SENTINEL_925` into the isolated test workspace; read back from disk. |
| Local send without `--wait` | Returned accepted run `56666522265921538`; a separate wait completed and the file existed. |
| Cloud, project selection | Creation saved runtime 1 and the selected project in server conversation metadata. |
| Follow-up runtime/project | Switched local/cloud, cleared with `--project none`, then inherited cloud with no project; independently fetched server state. |
| Enterprise knowledge | Live skill catalog ID encoded in the mention and task selections. Run `56662498460844802` returned a native enterprise search result block. |
| Attachments plus all three options | Work follow-up `56659245171974658` and Doubao creation `56663303415168258` returned the uploaded file's sentinel. |
| Mixed image/file attachment | Run `56655107192525826` returned the file sentinel and identified the generated blue image. |
| MCP plus context | Runs `56652078847510018` and `56664122893191682`; local server logged both requested markers and `pong` results. Temporary connector removal confirmed account absence and runtime disconnection. |
| Automatic fallback | Hid only the Work installation probe in the CLI process; the real standard app completed `56667086226859778` with cloud/project/enterprise selection. |
| Automated regression | 99 tests passed: parser conflicts, project pagination/name collision/device filtering, inherited workspace, cloud payload, dynamic module lookup, ACK reconciliation and rejection, generated directory creation, existing MCP/task recovery tests. |

Tests used a folderless existing project for association and isolated directories for local commands. Existing project folder bindings were not changed. Current-device folder filtering and sandbox folder propagation are covered by automated tests; no new folder binding was created in the app. No app restart or foreground activation was requested. Test messages remain in their synthetic sessions.

## Project creation

Verified 2026-09-26 with the same app versions:

- `projects create` created a folderless project and a directory-bound project in DoubaoWork. Both were independently read back by ID.
- With the Work installation probe hidden, automatic fallback created a project in Doubao and bound the standard app's device ID.
- Sessions using only the returned project ID selected the bound workspace. Work run `56661491511120642` and fallback run `56658194250012930` wrote distinct marker files; server context and file contents were read back independently.
- All three test projects were removed through the official project service and confirmed absent. Existing projects were preserved; the two synthetic test conversations remain. Both app URLs, composer text and attachment counts matched their pre-test state.
- 104 automated tests passed, including name/directory validation, app-device binding, moved module discovery, unknown flags, uncertain creation without retry and failed readback preserving the created ID. Package installation and command help were checked in an isolated prefix.

Evidence: `.e2e/context/project-create/` (gitignored). No publication or global installation was performed.

Internal module locations changed between these app versions. Module lookup checks the observed export/source contract and reports missing or ambiguous matches; future app updates still require validation. Account permissions and enterprise-search relevance remain controlled by Doubao.

Local raw evidence is in `.e2e/context/` (gitignored), including sanitized request/conversation readback, reply JSON, test logs and MCP execution logs.
