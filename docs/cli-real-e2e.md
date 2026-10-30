# CLI 真实 E2E 验收

日期：2026-10-29；补测更新：2026-10-30。范围：PR #31 的安装候选，Desktop（Doubao Work/CDP）和 Headless（HTTPS）。普通 Doubao 额外验证启动、只读接口和平台选择，不等同于第三套完整业务验收。

## 结论

本轮补测已覆盖扫码登录、AlwaysAsk 批准/拒绝、Headless MCP 实际调用、多子任务取消、真实重启、升级安装及视觉集成。FullAccess 拒绝及本人确认后的正向执行均已通过。Doubao Work MCP 实际工具调用仍失败，因此不能声明全部通过。模拟接口、解析兼容性与帮助测试不计入真实服务端验收；原始失败证据保留，修复后使用独立目录记录。

本轮发现并修复定时任务时间回读误判：服务端将 UTC 毫秒时间转换为任务时区、秒精度，现比较同一秒的时间点。Desktop、Headless 的创建、查询、修改、删除已重新实测通过；6 条测试定时任务全部删除并回读确认。

Desktop 当前版本的附件叶子模块/重导出、项目设备 helper 和具名 skills facade 已适配；附件上传、工作目录绑定、企业知识均已用新安装包实测通过。MCP 固定旧 chunk 已修复，注册/list/remove 通过；实际调用仍失败：任务 completed 但专用服务器日志 0 call、没有预期 pong。发送回执包含 localConnectors 和工具 schema，精确 run 保留 local/AskOnRisk；助手使用了其他工具，但没有 connector.call，也无待批准证据。具体路由原因尚未确定，不能归为人工权限问题或记为通过。

Desktop 协议额外修正：保留完整模型参数、使用原生 client_env_id、按应用区分 agent workspace。Node 22/24 各 525 项自动测试及隔离打包检查通过；这些结果不改变 MCP 未通过结论。详见 [协议与诊断记录](desktop-mcp-model-contract.md)。

## 2026-10-30 补测与权限交互修复

以下新结果补充后文 10 月 29 日矩阵，不能将旧失败覆盖为成功：

- 新鲜扫码登录：首次二维码过期退出；第二次由用户扫码并在手机确认后成功，隔离配置的 status 回读登录及账号一致。未导入 Cookie 代替本项。
- 多子任务取消：新建一次 cloud 任务，确认父任务和两个子任务均 running 后停止。stop/status 均返回 cancelled，原三个线程均终态且无 running/unknown；并发 wait 非零退出并返回 cancelled。测试会话归档、原页面与草稿恢复均回读确认。
- 真实应用重启：普通豆包初次退出超过等待预算，明确报错，原失败保留。原候选复验切换 CDP 端口及恢复默认端口均返回 restarted:true；持续观察超过 30 秒，默认端口、主进程稳定，账号/原页面/草稿一致，Work 未重启。没有使用 SIGKILL。
- 实际升级安装：`test/update-install-upgrade/run.mjs` 使用隔离 npm prefix/config/cache，先安装 registry 的 0.21.0，再执行候选 CLI 的 update 命令，实际安装 registry 的 0.22.0 并回读包/bin 版本。为进入升级分支，仅候选临时副本的版本元数据设为 0.21.0；运行时代码保持候选内容。不是未发布候选的发布证明，也不是当前 0.22.0 到尚不存在的新版本的实测。未改变 HOME 或全局 CLI。
- 视觉集成：`scripts/verify-skin-visual.mjs` 使用最小本地 CSS 皮肤夹具，在真实 Work 页面验证开/关的 computedStyle、重复连接不重复注入、设置回读及恢复原样，Node 22 五项通过。第三方 doubao-skin 包兼容性没有验证。一次 Node 26 重跑在 CDP discovery 阶段失败，保留为瞬时连接失败，原因未知；夹具节点最终为零。
- 人工交互发现问题：权限 readline 未配置输出流，输入缺少可见回显；独立并发测试也发现多个审批回调可同时读取同一输入。修复为每个终端串行排队并启用回显，排队取消不显示/读取答案，单次输入不能批准后续问题。FullAccess 拒绝原样本通过；批准原样本提交前非零退出且 stderr 未捕获，不能确定原因。AlwaysAsk 原样本已按原 run 取消、回读并归档，不冒充通过。
- 修复后的 Node 22.16.0 / Node 24.10.0 各 530 项测试、build/typecheck 通过。修复后的人工批准/拒绝及 Headless MCP 已实测，具体证据如下；自动测试不替代人工验收。

私有证据：`~/.local/state/doubao-cli/validation/cli-e2e-2026-10-30/` 与 `interactive-e2e-2026-10-30/`。其中原始回执、日志及凭据不入库。

## 验收边界

- 候选来自隔离 npm 安装。发现问题后只同步修复的运行时文件，并保存变更 hash；最终包检查另行记录。
- 部分真实测试使用 Node 26.7.0，部分使用 Node 22.16.0；不能宣称真实账号 E2E 已在 Node 22/24 全部重复。自动化回归与打包测试另列。
- 专用测试会话、项目、连接器、定时任务与私有文件用于验收；不更改用户原有业务资源。应用界面临时切到专用会话后恢复。
- 命令退出 0 不足以证明效果；写入必须回读，MCP 必须有实际工具结果或日志。
- `stop` 需区分“命令返回、任务已终态”与“确实取消了运行中的任务”。Desktop 原任务服务端已中断，CLI 漏读用户消息标记；修复后同一 run 在两个后端的 status/stop 均为 cancelled，stopped:true。Headless 自建 cloud 请求此前已自然完成，未命中运行中取消。
- `update` 当前最新版本路径通过，没有据此声称实际升级安装路径已执行。Desktop skin 未安装，验证的是设置持久化及 not-installed 行为，未验证皮肤视觉应用。

## 人工项补测状态（2026-10-30）

1. 新鲜扫码登录已通过，用户亲自在手机确认，服务端账号回读一致。
2. FullAccess 拒绝和正向执行均已通过。最终单项由用户在原生提示中输入 y；任务 exit 0 / completed，专用 proof.txt 内容精确匹配预期 marker，运行时 journal 确认 Bash 成功并上传，原 run 终态与会话归档均回读确认。此前输入 N 的拒绝样本及未操作导致的超时样本保留，不改写成成功。
3. AlwaysAsk 拒绝与批准均已验证。拒绝样本无测试文件且 journal 记录 PERMISSION_DENIED；批准样本通过真实 MCP 调用确认。
4. Headless MCP 正向调用已通过：AlwaysAsk 下用户亲自批准，fixture 收到恰好一次调用，回复 marker 与已上传 MCP 结果一致，连接器和会话清理已回读。

补测脚本的两次误判均保留原记录：FullAccess 拒绝样本读取尚未 flush 的终端日志时得到空字符串；最终日志证明提示与拒绝均发生，后续 launcher 使用 script -F 即时落盘。MCP 样本错误要求 wrapper 的 isError===false，而实际 MCP 内容位于 raw_result、isError 可省略；已按真实协议修正断言并复核原 run，没有重新发送任务。`simple-v4/post-run-verification.json` 和 `approve-v5/post-run-verification.json` 保存复核结论，原结果未覆盖。

FullAccess 最终成功证据位于 `~/.local/state/doubao-cli/validation/interactive-e2e-2026-10-30-fullaccess-v7/`：`results/fullaccess-approve.json`、`results/fullaccess-approve-proof.json`、私有 runtime journal 与 `suite-state.json`。本次只执行一个已确认的任务，没有重放此前的失败请求。

## 私有证据

证据根目录：`~/.local/state/doubao-cli/validation/cli-e2e-2026-10-29/`。其中含账号与会话数据，不提交 Git。仓库仅保留测试代码、脱敏结论和证据定位。

- `automations/`、`automations-canonical/`：原始失败及恢复清理；`automations-fixed/`：修复后两端 CRUD 回读。
- `infrastructure/`：账号登录/退出、状态、设置、更新检查、平台别名、启动及入口；带不适用 `--profile` 的原始调用被拒绝，合法调用另存，不作为产品缺陷。
- `headless/results/`：基础查询、文本+PNG 上传、隐藏文件 marker 读取、runtime/workspace 切换、MCP 权限边界。
- `headless/commands/`：26 个命令/回读步骤；`headless/modes/`：goal、企业知识、后台恢复及 stop 边界；`headless/auth/`：隔离 profile 登录/退出及 chat。
- `stop-fix-readback/summary.json`：同一已取消 Desktop 原 run，两端 status/stop 四项回读均通过，未新发消息。
- `desktop-final-modules-resume/summary.json`：新包31个检查，30通过，仅mcp-call失败。启动日志确认重复arg/env保留，0次tool call。全部Desktop专用会话归档，连接器与项目删除并回读；原页面已恢复。
- `headless/terminal-readback.json`：11 个 turn / 9 个新建会话均终态；会话已归档，MCP 和专用项目已删除。

## 可重跑入口

使用绝对路径的已安装候选、隔离账号配置和全新私有输出目录。未知写入结果先按保存的 ID 回读，禁止重发。新 runner 将候选内容 hash 与参数绑定到 manifest；候选变化、输入变化或旧目录无 manifest 时拒绝借用缓存结果。修正 runner 后的语法检查不等于重新完成真实测试。

- `scripts/headless-e2e.mjs`：基础、附件、本地、MCP、后台；非交互执行不代替权限批准。
- `scripts/e2e-headless-commands.mjs`：会话、项目、模型管理。
- `scripts/e2e-headless-modes.mjs`：模式、企业知识、后台和停止。
- `scripts/e2e-desktop-comprehensive.mjs`：Desktop 业务流程。
- `scripts/e2e-automations.mjs`：两端定时任务 CRUD，90 天后单次测试任务，测试后删除。

## 命令逐项实测

“通过”指该行记载的实际路径；“部分”明确保留未验证分支。全量列表等明确标注的既有证据不冒充今天新跑。

| ID | 命令 | Desktop | Headless | 实际路径与边界 |
| --- | --- | --- | --- | --- |
| C01 | `help [命令路径]` | 通过 | 通过 | 安装包帮助入口；无需远端调用 |
| C02 | `version` | 通过 | 通过 | version / --version / -v |
| C03 | `status` | 通过 | 通过 | 真实状态回读 |
| C04 | `capabilities` | 通过 | 通过 | 真实能力查询 |
| C05 | `profiles` | 通过 | 通过 | 有效 profile 参数范围另测拒绝 |
| C06 | `usage` | 通过 | 通过 | 真实额度接口 |
| C07 | `runtimes` | 通过 | 通过 | 真实 runtime 列表 |
| C08 | `sessions list` | 通过 | 通过 | 全量列表证据见旧验收；本轮另测 limit/archived |
| C09 | `sessions current` | 通过 | 通过 | 专用会话 current 回读 |
| C10 | `sessions create [消息]` | 通过 | 通过 | 有消息创建；Headless 无消息草稿另测 |
| C11 | `sessions open <会话ID>` | 通过 | 通过 | 专用会话打开/选中 |
| C12 | `sessions read <会话ID>` | 通过 | 通过 | 消息和 limit 回读 |
| C13 | `sessions send <会话ID> <消息>` | 部分 | 部分 | 普通发送、附件通过；Desktop MCP实际调用失败，Headless MCP创建实测通过，MCP续聊未补测 |
| C14 | `sessions status <会话ID>` | 通过 | 通过 | 指定 run 回读 |
| C15 | `sessions wait <会话ID>` | 通过 | 通过 | 同 IDs 恢复；JSON/schema 校验 |
| C16 | `sessions stop <会话ID>` | 通过 | 通过 | 修复后同一原 run 两端均 cancelled/stopped:true；无子任务，子任务终止另有覆盖边界 |
| C17 | `projects list` | 通过 | 通过 | 项目实际列表 |
| C18 | `projects create <名称>` | 通过 | 通过 | 两端带 workspace 创建、列表回读通过，专用项目已清理 |
| C19 | `models` | 通过 | 通过 | Desktop 需处于聊天页面 |
| C20 | `model` | 通过 | 通过 | 实际模型回读 |
| C21 | `model current` | 通过 | 通过 | 实际模型回读 |
| C22 | `model select <模型名称>` | 通过 | 通过 | Desktop 7 个模型逐一回读，Headless 改动后恢复 |
| C23 | `model reasoning <等级>` | 通过 | 通过 | Desktop 原 low 网络失败保留；新命名独立设置+回读通过 |
| C24 | `mcp list` | 通过 | 通过 | 两端真实连接器列表 |
| C25 | `mcp register <名称>` | 通过 | 通过 | 旧 chunk 问题修复后，两端 READY |
| C26 | `mcp remove <连接器ID>` | 通过 | 通过 | 两端删除与缺失回读；Headless另确认本地配置清理 |
| C27 | `automations list` | 通过 | 通过 | 修复后真实 list |
| C28 | `automations get <任务ID>` | 通过 | 通过 | 创建/修改/删除后 get |
| C29 | `automations create` | 通过 | 通过 | 原 UTC 毫秒输入复测 verified |
| C30 | `automations update <任务ID>` | 通过 | 通过 | 标题、提示词、时间更新 verified |
| C31 | `automations delete <任务ID>` | 通过 | 通过 | 删除后 get/list 回读 |
| C32 | `skin [on/off/status]` | 部分 | 通过 | Desktop 未安装皮肤；设置切换与 not-installed 已验证 |
| C33 | `update` | 部分 | 部分 | 当前版本检查完成；没有可升级版本，未执行实际安装分支 |
| C34 | `update check` | 通过 | 通过 | 真实 npm registry |
| C35 | `update auto [on/off/status]` | 通过 | 通过 | 隔离设置 on/status/off/status |
| C36 | `update notify [on/off/status]` | 通过 | 通过 | 隔离设置 on/status/off/status |
| C37 | `login` | 不适用 | 通过 | Desktop 拒绝；Headless Cookie 登录及本人扫码登录均通过 |
| C38 | `logout` | 不适用 | 通过 | Desktop 拒绝；隔离 profile 登出后 status 未登录 |
| C39 | `cdp status` | 通过 | 不适用 | Headless 实际命令拒绝 |
| C40 | `cdp launch` | 部分 | 不适用 | 普通 Doubao 从未运行启动成功，Work 已就绪路径通过；重启分支未执行 |
| C41 | `sessions archive <会话ID>` | 通过 | 通过 | 两端本轮 verified 回读 |
| C42 | `sessions unarchive <会话ID>` | 通过 | 通过 | 两端本轮 verified 回读 |
| C43 | `sessions pin <会话ID>` | 通过 | 通过 | 两端本轮 verified 回读 |
| C44 | `sessions unpin <会话ID>` | 通过 | 通过 | 两端本轮 verified 回读 |
| C45 | `sessions rename <会话ID> <标题>` | 通过 | 通过 | 两端本轮 verified 回读 |
| C46 | `sessions move <会话ID> <项目ID或完整名称或none>` | 通过 | 通过 | 项目及 none 回读 |

## 选项逐项实测

每个选项以实际业务路径为准，不将 5,738 个解析用例描述为远端 E2E。组合的笛卡尔积没有穷举。

| ID | 选项 | 状态 | 已测路径与缺口 |
| --- | --- | --- | --- |
| O01 | `--help`、`-h` | 通过 | 根/子命令帮助；不会提交消息 |
| O02 | `--version`、`-v` | 通过 | 两个独立版本 flag 与 version |
| O03 | `--json` | 通过 | 数据命令 JSON 与退出码；帮助/版本保留文本 |
| O04 | `--platform` | 通过 | work/doubao/headless 只读；web 映射同一 Headless 账号 |
| O05 | `--app` | 通过 | work 业务、doubao 启动与只读 |
| O06 | `--profile` | 通过 | Desktop 目录与 Headless 隔离 profile；不适用命令实际拒绝 |
| O07 | `--timeout` | 通过 | 真实查询、发送和 wait/stop 使用超时 |
| O08 | `--all` | 通过 | Headless 本轮 archived 全量；两端普通全量使用既有真实证据 |
| O09 | `--limit` | 通过 | list/read 实际限制；所有边界数值仍由解析测试覆盖 |
| O10 | `--run` | 通过 | status/wait 按同一 run 回读；原被取消 run 修复后两端 stop 明确确认 |
| O11 | `--wait` | 通过 | 等待完成与不带 wait 的后台路径 |
| O12 | `--mode` | 部分 | goal/work 完成；chat 完成但精确回复断言失败，原始失败保留 |
| O13 | `--model` | 通过 | 真实模型发送；Desktop 7 个可用模型仅切换回读，并非每个模型都发送任务 |
| O14 | `--reasoning` | 通过 | Headless 回读通过；Desktop 原网络失败保留，low 已独立设置+回读通过 |
| O15 | `--attach` | 通过 | Headless 文本+图片；Desktop 重复文件上传、回复 marker 与附件回读通过 |
| O16 | `--runtime` | 通过 | local/cloud 真实执行与上下文回读 |
| O17 | `--project` | 通过 | 项目 ID/none 与工作目录；不是所有歧义组合的远端实测 |
| O18 | `--enterprise-knowledge` | 通过 | 两端真实请求；Desktop 上下文 projectId/enterpriseKnowledge 回读 |
| O19 | `--workspace` | 通过 | 两端创建项目绑定、目录回读；local 文件读取 |
| O20 | `--no-skills` | 通过 | 实际 local 任务使用 |
| O21 | `--permission` | 部分 | AskOnRisk 安全读取通过；非TTY FullAccess拒绝通过；Headless FullAccess及AlwaysAsk批准/拒绝已补测 |
| O22 | `--mcp` | 未通过 | Headless AlwaysAsk现场批准后真实调用通过；Work completed但服务器0call、无pong |
| O23 | `--expect-json` | 通过 | 真实回复 JSON 验证 |
| O24 | `--reply-schema` | 通过 | 真实回复 Schema 验证与明确失败出口 |
| O25 | `--command` | 通过 | 两端 stdio MCP 注册 READY |
| O26 | `--arg` | 通过 | 两端真实注册；Desktop 重复 arg 包含选项形态文本 |
| O27 | `--env` | 部分 | Desktop启动日志确认重复env保留；Headless工具读取marker待人工 |
| O28 | `--file` | 通过 | 两端定时任务create/update实际读取JSON并回读 |
| O29 | `--cookie-file` | 通过 | 隔离profile导入并认证；秘密文件已删除 |
| O30 | `--yes` | 部分 | Work已有CDP路径接受--yes；实际重启确认分支未执行 |
| O31 | `--target` | 通过（拒绝） | 两端外部CLI进程拒绝，exit1 |
| O32 | `--` | 通过 | Desktop实际literal发送；JSON放在--之前 |
| O33 | `--archived` | 通过 | 两端已归档列表查询 |

## 自动化回归与最终包

- 修复后 Node 22.16.0 / 24.10.0 各 516 项通过；两种 Node 的生产依赖隔离安装、125 个帮助入口及后台 worker 入口验证通过。
- 原 Node 22 并行回归曾触发旧 Web stop 测试的 35ms 调度预算问题；将预算改为 1000ms，保留原业务断言，focused 与两版本完整回归均通过。原失败日志保留。
- `release-install` 安装包的 52 个运行时文件与工作树源码/编译产物逐字节一致。没有更新用户全局 CLI，没有发版。
- 子任务 `AGWTaskTerminate` 现代具名导出已确认，并对旧/新导出做终止+回读测试；本轮未新增真实多子任务取消场景，不冒充远端证明。

## 未完成项

以下旧清单中的人工项以本文件 2026-10-30 补测状态为准；多子任务取消和真实重启已补测，皮肤仅完成真实 CLI 视觉集成夹具，实际升级安装的版本元数据夹具边界如上。

- Desktop `--mcp` 仍未通过：独立 CLI 样本及全新原生 UI 会话均为 0 次实际调用；聊天页和后台页直接调用原生 MCP bridge 各成功 1 次。结构化错误及原生日志将问题缩小到 native callTool dispatch 之前，根因未确定。详见 [诊断记录](desktop-mcp-model-contract.md)。测试资源已清理，未重发原任务。
- 原列出的人工扫码、Headless FullAccess、AlwaysAsk 和 Headless MCP 项均已补测，详见补测状态；这不意味着所有后端、模型与参数组合均已穷举。
- 多子任务取消、真实重启和升级安装已补测。皮肤的真实 CLI 注入/恢复夹具通过，但没有第三方兼容皮肤包的视觉验收。升级分支使用候选副本的旧版本元数据夹具，实际下载和安装的是 registry 包。
- chat 严格文本断言与一次新模型 JSON 断言失败保留：前者多句点，后者附加字符；CLI 对无效 JSON 正确返回非零，不能把原正向断言改记为成功。
