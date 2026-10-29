# CLI 真实 E2E 验收

日期：2026-10-29。范围：PR #31 的安装候选，Desktop（Doubao Work/CDP）和 Headless（HTTPS）。普通 Doubao 额外验证启动、只读接口和平台选择，不等同于第三套完整业务验收。

## 结论

本轮可自动执行的验证已完成记录，不能声明全部通过。Desktop MCP 实际工具调用仍失败，人工权限/扫码项已按用户要求暂缓。模拟接口、解析兼容性与帮助测试不计入真实服务端验收。人工项按用户要求暂缓；原始失败证据保留，修复后使用独立目录记录。

本轮发现并修复定时任务时间回读误判：服务端将 UTC 毫秒时间转换为任务时区、秒精度，现比较同一秒的时间点。Desktop、Headless 的创建、查询、修改、删除已重新实测通过；6 条测试定时任务全部删除并回读确认。

Desktop 当前版本的附件叶子模块/重导出、项目设备 helper 和具名 skills facade 已适配；附件上传、工作目录绑定、企业知识均已用新安装包实测通过。MCP 固定旧 chunk 已修复，注册/list/remove 通过；实际调用仍失败：任务 completed 但专用服务器日志 0 call、没有预期 pong。发送回执包含 localConnectors 和工具 schema，精确 run 保留 local/AskOnRisk；助手使用了其他工具，但没有 connector.call，也无待批准证据。具体路由原因尚未确定，不能归为人工权限问题或记为通过。

Desktop 协议额外修正：保留完整模型参数、使用原生 client_env_id、按应用区分 agent workspace。Node 22/24 各 525 项自动测试及隔离打包检查通过；这些结果不改变 MCP 未通过结论。详见 [协议与诊断记录](desktop-mcp-model-contract.md)。

## 验收边界

- 候选来自隔离 npm 安装。发现问题后只同步修复的运行时文件，并保存变更 hash；最终包检查另行记录。
- 部分真实测试使用 Node 26.7.0，部分使用 Node 22.16.0；不能宣称真实账号 E2E 已在 Node 22/24 全部重复。自动化回归与打包测试另列。
- 专用测试会话、项目、连接器、定时任务与私有文件用于验收；不更改用户原有业务资源。应用界面临时切到专用会话后恢复。
- 命令退出 0 不足以证明效果；写入必须回读，MCP 必须有实际工具结果或日志。
- `stop` 需区分“命令返回、任务已终态”与“确实取消了运行中的任务”。Desktop 原任务服务端已中断，CLI 漏读用户消息标记；修复后同一 run 在两个后端的 status/stop 均为 cancelled，stopped:true。Headless 自建 cloud 请求此前已自然完成，未命中运行中取消。
- `update` 当前最新版本路径通过，没有据此声称实际升级安装路径已执行。Desktop skin 未安装，验证的是设置持久化及 not-installed 行为，未验证皮肤视觉应用。

## 人工项（用户已选择稍后执行）

1. 新鲜扫码登录（Cookie 文件导入登录/退出已完成）。
2. Headless 每轮 FullAccess 终端确认与真实执行。
3. AlwaysAsk 权限批准/拒绝的交互流程。
4. Headless MCP 正向工具调用所需的现场批准。注册、READY、删除及回读已完成，未将未获批准的调用记为成功。

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
| C13 | `sessions send <会话ID> <消息>` | 部分 | 部分 | 普通发送、附件通过；Desktop MCP实际调用失败，Headless MCP待人工 |
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
| C37 | `login` | 不适用 | 部分 | Desktop 拒绝；Headless Cookie 登录通过，扫码待人工 |
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
| O21 | `--permission` | 部分 | AskOnRisk 安全读取通过；非TTY FullAccess拒绝通过；正向FullAccess/AlwaysAsk待人工 |
| O22 | `--mcp` | 未通过 | Headless 需现场批准；Desktop completed但服务器0call、无pong |
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

- Desktop `--mcp` 仍未通过：独立 CLI 样本及全新原生 UI 会话均为 0 次实际调用；聊天页和后台页直接调用原生 MCP bridge 各成功 1 次。结构化错误及原生日志将问题缩小到 native callTool dispatch 之前，根因未确定。详见 [诊断记录](desktop-mcp-model-contract.md)。测试资源已清理，未重发原任务。
- 上述四项人工登录/权限流程尚未执行。
- 未实测多子任务取消、真实重启确认、已安装皮肤的视觉效果、实际版本升级安装。这些分支不能由模拟或其他成功路径替代。
- chat 严格文本断言与一次新模型 JSON 断言失败保留：前者多句点，后者附加字符；CLI 对无效 JSON 正确返回非零，不能把原正向断言改记为成功。
