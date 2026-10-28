# CLI 重构验收基线

更新时间：2026-10-28（Asia/Shanghai）。

原始清单基于 `a51e5c99f0b495242435b224c4a9fbf18f9a8dc1`。PR #28 已合并；本轮固定源码基线为主干 `3dae8b4de6910cc943bd033aedbb056c25855625`。该提交的文件树与最初用于验证的集成基线 `cf927638ff3bcf0a0884f87ad08ea22fab3f4caa` 完全相同。新增 6 个 session 管理命令及 `--archived` 已纳入清单。

本文件用于后续 TypeScript / CLI 框架重构的逐项验收。写入清单不代表验证通过。历史测试和真实账号结果不能替代候选版本验证。命令/选项矩阵的“通过”仅指本轮解析、拒绝、帮助及分派兼容性；业务回归、安装产物和真实账号验证分别记录，不能相互替代。

## 验收规则

相同输入应保持后端选择、账号选择、请求参数、JSON 结构、退出码及副作用一致。需要改变的行为先写入“行为差异记录”，不得在迁移中静默修正。

- 命令表逐行验证；动作枚举、兼容别名和 Desktop 的 work/doubao 两种应用分别展开。
- 选项表逐行验证：有效值、非法值、缺值、默认值、边界、重复参数、命令前后位置、适用和禁止的命令组合。只对适用的类型展开用例，不机械穷举所有组合。
- 旧版/新版差分只运行纯解析或隔离的模拟请求；不重复创建真实任务。
- 真实账号关键流程只发送必要用例，检查服务端回读；超时或结果不明先查 conversation ID / run ID，不自动重发。
- 每个具体用例记录：基线与候选提交、平台、完整脱敏 argv、准备条件、预期与实际结果、退出码、副作用、复现步骤、证据位置。
- 状态只使用：通过、失败、不适用、未验证；括号可注明拒绝测试等边界。“不适用”必须写原因；失败或必需项未验证时不得宣称验收完成。
- 首轮框架迁移范围为命令定义、参数解析、别名与帮助，复用已有业务服务及 CDP/HTTPS 适配器。

## 命令矩阵

以下路径均位于 `doubao` 后。Desktop 使用 `--platform work` 或 `--platform doubao`；Headless 使用 `doubao headless …`。

`D / H` 表示 Desktop / Headless。“通过（拒绝）”表示该平台不支持此命令或选项，已验证拒绝行为。

| ID | 命令 | 行为 / 平台差异 | D 兼容性 | H 兼容性 |
| --- | --- | --- | --- | --- |
| C01 | `help [命令路径]` | 查看根帮助和各级帮助，不执行业务命令 | 通过 | 通过 |
| C02 | `version` | 输出 CLI 版本；同时覆盖 `--version`、`-v` | 通过 | 通过 |
| C03 | `status` | 查看桌面应用状态 / Headless 登录状态 | 通过 | 通过 |
| C04 | `capabilities` | 查询能力，保留两种后端实际差异 | 通过 | 通过 |
| C05 | `profiles` | 列出账号配置 | 通过 | 通过 |
| C06 | `usage` | 查询额度 | 通过 | 通过 |
| C07 | `runtimes` | 查询 cloud/local 可用性 | 通过 | 通过 |
| C08 | `sessions list` | 列表、分页、runtime 标记、来源与完整性 | 通过 | 通过 |
| C09 | `sessions current` | Desktop 当前页面 / Headless 当前会话记录 | 通过 | 通过 |
| C10 | `sessions create [消息]` | 无消息的 Headless 仅重置当前会话为草稿，不创建服务端空会话 | 通过 | 通过 |
| C11 | `sessions open <会话ID>` | Desktop 打开应用会话 / Headless 设置当前会话 | 通过 | 通过 |
| C12 | `sessions read <会话ID>` | 读取消息及数量限制 | 通过 | 通过 |
| C13 | `sessions send <会话ID> <消息>` | 发送后续消息，继承或覆盖任务上下文 | 通过 | 通过 |
| C14 | `sessions status <会话ID>` | 查询任务状态，可指定 run ID | 通过 | 通过 |
| C15 | `sessions wait <会话ID>` | 等待完成，覆盖超时和恢复 | 通过 | 通过 |
| C16 | `sessions stop <会话ID>` | 停止任务，覆盖未确认停止的非零退出码 | 通过 | 通过 |
| C17 | `projects list` | 查询项目及文件夹，覆盖完整分页 | 通过 | 通过 |
| C18 | `projects create <名称>` | 创建项目，可指定 workspace | 通过 | 通过 |
| C19 | `models` | 列出可用模型 | 通过 | 通过 |
| C20 | `model` | 等同于 `model current`；Headless 帮助未单独列出 | 通过 | 通过 |
| C21 | `model current` | 当前模型和推理强度 | 通过 | 通过 |
| C22 | `model select <模型名称>` | 选择模型，可设置推理强度 | 通过 | 通过 |
| C23 | `model reasoning <等级>` | 设置推理强度 | 通过 | 通过 |
| C24 | `mcp list` | 列出连接器 | 通过 | 通过 |
| C25 | `mcp register <名称>` | 注册 stdio 连接器，包含参数和环境变量 | 通过 | 通过 |
| C26 | `mcp remove <连接器ID>` | 移除并验证结果；不得仅凭请求成功判定 | 通过 | 通过 |
| C27 | `automations list` | 列出定时任务 | 通过 | 通过 |
| C28 | `automations get <任务ID>` | 查询单个任务 | 通过 | 通过 |
| C29 | `automations create` | 从 `--file` 创建 | 通过 | 通过 |
| C30 | `automations update <任务ID>` | 从 `--file` 更新 | 通过 | 通过 |
| C31 | `automations delete <任务ID>` | 删除任务 | 通过 | 通过 |
| C32 | `skin [on/off/status]` | 省略为 status；Headless 接受设置但不应用桌面皮肤 | 通过 | 通过 |
| C33 | `update` | 检查并更新 CLI | 通过 | 通过 |
| C34 | `update check` | 检查更新 | 通过 | 通过 |
| C35 | `update auto [on/off/status]` | 自动更新设置；省略为 status | 通过 | 通过 |
| C36 | `update notify [on/off/status]` | 更新提醒设置；省略为 status | 通过 | 通过 |
| C37 | `login` | 扫码或 Cookie 文件导入 | 通过（拒绝） | 通过 |
| C38 | `logout` | 退出登录 | 通过（拒绝） | 通过 |
| C39 | `cdp status` | 检查本地 CDP | 通过 | 通过（拒绝） |
| C40 | `cdp launch` | 启用 CDP，必要时确认重启 | 通过 | 通过（拒绝） |
| C41 | `sessions archive <会话ID>` | 归档会话 | 通过 | 通过 |
| C42 | `sessions unarchive <会话ID>` | 恢复归档会话 | 通过 | 通过 |
| C43 | `sessions pin <会话ID>` | 置顶会话 | 通过 | 通过 |
| C44 | `sessions unpin <会话ID>` | 取消置顶 | 通过 | 通过 |
| C45 | `sessions rename <会话ID> <标题>` | 重命名，标题上限 20 个 UTF-16 单元 | 通过 | 通过 |
| C46 | `sessions move <会话ID> <项目ID或完整名称或none>` | 移动项目或清除项目 | 通过 | 通过 |

创建、删除、更新、退出登录、重启应用、改变模型或设置等用例优先使用隔离目录和模拟服务。真实账号验证不机械执行全部写操作；使用专用测试资源，记录必要的实际覆盖与未覆盖项。

## 选项矩阵

“适用范围”指正常业务执行路径，不包含帮助提前返回。帮助路径另行验证。

| ID | 选项 | 值 / 范围 / 组合要求 | D 兼容性 | H 兼容性 |
| --- | --- | --- | --- | --- |
| O01 | `--help`、`-h` | 根命令和各级命令帮助，不能触发业务副作用 | 通过 | 通过 |
| O02 | `--version`、`-v` | 独立版本入口，与 `version` 对比 | 通过 | 通过 |
| O03 | `--json` | 业务结果 JSON；版本/帮助保持其实际文本行为 | 通过 | 通过 |
| O04 | `--platform` | work / doubao / headless；web 兼容映射至 headless | 通过 | 通过 |
| O05 | `--app` | work / doubao；与 Headless 命名空间冲突 | 通过 | 通过 |
| O06 | `--profile` | 账号配置；具体范围见下表 | 通过 | 通过 |
| O07 | `--timeout` | 有限正数秒，默认 120；具体范围见下表 | 通过 | 通过 |
| O08 | `--all` | 仅 sessions list；不能与显式 --limit 同用 | 通过 | 通过 |
| O09 | `--limit` | 默认 20；list 1–100；read Desktop 1–1000、Headless 1–100 | 通过 | 通过 |
| O10 | `--run` | 12–24 位数字；仅 sessions status/wait/stop | 通过 | 通过 |
| O11 | `--wait` | 仅有消息的 sessions create/send | 通过 | 通过 |
| O12 | `--mode` | 仅 sessions create；Desktop goal；Headless chat/work/goal | 通过 | 通过 |
| O13 | `--model` | sessions create/send；可用模型完整名称 | 通过 | 通过 |
| O14 | `--reasoning` | low / medium / high / xhigh / max；create/send、model select | 通过 | 通过 |
| O15 | `--attach` | create/send；文件路径，可重复；校验文件与上传失败 | 通过 | 通过 |
| O16 | `--runtime` | create/send；local / cloud | 通过 | 通过 |
| O17 | `--project` | create/send；项目 ID、完整名称或 none；覆盖同名项目歧义 | 通过 | 通过 |
| O18 | `--enterprise-knowledge` | create/send；验证账号能力与实际上下文 | 通过 | 通过 |
| O19 | `--workspace` | create/send、projects create；目录路径 | 通过 | 通过 |
| O20 | `--no-skills` | create/send；验证实际请求中的技能配置 | 通过 | 通过 |
| O21 | `--permission` | AlwaysAsk / AskOnRisk / FullAccess；本地任务，详见上下文用例 | 通过 | 通过 |
| O22 | `--mcp` | create/send；6–24 位数字 ID，可重复；Desktop 要求 --wait 且不能带附件 | 通过 | 通过 |
| O23 | `--expect-json` | create/send/wait；create/send 要求 --wait | 通过 | 通过 |
| O24 | `--reply-schema` | create/send/wait；Schema 文件路径；create/send 要求 --wait | 通过 | 通过 |
| O25 | `--command` | mcp register；stdio 服务可执行文件路径 | 通过 | 通过 |
| O26 | `--arg` | mcp register；可重复；值可以是 --help 等带横线文本 | 通过 | 通过 |
| O27 | `--env` | mcp register；KEY=VALUE，可重复；不在报告中暴露敏感值 | 通过 | 通过 |
| O28 | `--file` | automations create/update 必填；读取并校验 JSON | 通过 | 通过 |
| O29 | `--cookie-file` | 仅 Headless login；不在报告中暴露 Cookie | 通过（拒绝） | 通过 |
| O30 | `--yes` | 仅 Desktop cdp launch；确认重启 | 通过 | 通过（拒绝） |
| O31 | `--target` | 遗留 CDP 参数；当前可达业务命令均拒绝 | 通过（拒绝） | 通过（拒绝） |
| O32 | `--` | 后续全部视为原文；help、--help、模型名或消息中的横线均不再解析 | 通过 | 通过 |
| O33 | `--archived` | 仅 sessions list；列出已归档会话 | 通过 | 通过 |

### 命令范围

| 选项 | Desktop | Headless |
| --- | --- | --- |
| `--profile` | status、usage、runtimes、projects、sessions、mcp、models、model、automations | 同左，额外支持 login、logout |
| `--timeout` | automations 全部；projects list；sessions list/read/create/send/wait/stop/archive/unarchive/pin/unpin/rename/move；mcp register | login/status/models/profiles/usage/runtimes；sessions、projects、model、mcp、automations 全部 |

`profiles` 不接受 `--profile`。Desktop 的 `sessions status` 不接受 `--timeout`。不支持的命令与选项组合必须验证拒绝，不能只覆盖有效组合。

## 专项用例

| ID | 检查项 | 验收标准 | 状态 | 本轮证据 / 边界 |
| --- | --- | --- | --- | --- |
| V01 | 后端入口和别名 | headless 命名空间与 --platform headless 相同；web 两种入口均映射 Headless；保留冲突拒绝 | 通过 | cli-compatibility / cli / headless-cli；冻结解析差分 |
| V02 | 平台默认和账号隔离 | 覆盖 macOS/Linux 默认选择、work/doubao、环境覆盖、活动/非活动 profile；跨账号不得串用数据或游标 | 通过 | app / profiles / headless-profiles / list-services；跨账号保护为模拟验证，真实账号只验证同一账号 |
| V03 | 帮助与原文 | 覆盖 help 路径、--help、-h、-- 分隔、MCP --arg --help；帮助不登录、不联网、不更新、不启动应用、不访问任务文件 | 通过 | cli.test：网络、文件、进程调用拦截；安装包帮助检查 |
| V04 | 参数顺序与重复值 | 命令前后选项、重复标量、重复集合参数、未知选项、多余位置参数、空值；与旧解析器逐项对比 | 通过 | 5,738 个冻结用例，包括全部 22 个取值选项的空字符串 |
| V05 | 全量 sessions | >1 页、末页、重复 ID、坏游标、超时、空列表；--all 的完整性字段与退出码准确 | 通过 | list-services / headless-services；真实两端各 117 页、2338 个会话 |
| V06 | runtime 分类 | 对比服务端记录和 Desktop 明确选择；未加载会话不能因 getState 默认 Cloud 被错误覆盖 | 通过 | sessions / list-services；真实两端全部 ID/runtime 一致 |
| V07 | Desktop 缓存降级 | 缓存来源、complete:false、hasMore:null；缓存不能宣称全量成功；API 失败不能静默当作缓存成功 | 通过 | sessions / list-services：离线缓存与错误路径模拟 |
| V08 | 项目列表与请求负载 | 两个适配器使用同一列表规则；比较实际 runtime、permission、project、workspace 请求字段 | 通过 | list-services / context / project-create；真实 5 个项目 ID 一致；分派和解析边界等价 |
| V09 | 新任务默认上下文 | Desktop local / FullAccess；Headless cloud，本地任务默认 AskOnRisk；默认省略不能扩大权限 | 通过 | context / task-context / headless-local-runtime；省略与默认回归 |
| V10 | 跟进继承 | runtime、权限、项目、同设备 workspace 的继承与显式覆盖；旧会话缺元数据不能擅自变成本地任务 | 通过 | task-context；真实两端跟进回读 |
| V11 | 项目切换和清除 | 切换项目、--project none、显式重选同项目；正确重算 workspace，不错误沿用旧目录 | 通过 | task-context；真实两端清除项目后 workspace 重算 |
| V12 | workspace 优先级 | 显式目录 → 同设备且未显式选项目的原目录 → 当前设备项目主目录/首目录 → 生成目录 | 通过 | task-context / context，受控设备与目录夹具 |
| V13 | 跨设备保护 | 其他本地设备/app 的会话要求显式 --runtime local 或 cloud；本地选项不能绕过保护 | 通过 | task-context / context，跨设备/app 模拟 |
| V14 | cloud 参数限制 | cloud 与 mcp/workspace/permission/no-skills 冲突时拒绝；切换 cloud 后无本地 workspace 等字段残留 | 通过 | options-contract / task-context；真实 cloud 回读 |
| V15 | 权限输入与恢复 | 三种权限、规范化拼写、非法保存值和显式修复；Headless FullAccess 提交及恢复均要求新交互确认 | 通过 | cli / mcp-permissions / headless-approval / headless-worker |
| V16 | FullAccess 拒绝 | 非 TTY、拒绝或取消时，不创建目录、不启动任务、不提交远端请求；无需真实执行高权限任务 | 通过 | headless-approval / headless-security / headless-worker；未真实提交 FullAccess |
| V17 | 模型、推理与 mode | 校验可用模型、五档推理、chat/work/goal 的后端差异与版本能力门禁；验证推理是否需要模型参数 | 通过 | features / automation / cli；能力门禁与解析回归，未在真实账号切换全部模型 |
| V18 | 回复校验 | 合法/非法 JSON、合法/非法 Schema、缺文件、未完成回复；JSON 字段、stderr、退出码与基线一致 | 通过 | validate / cli：回复及 Schema 正反例 |
| V19 | 任务生命周期 | create/send/status/wait/stop；成功、失败、超时、取消、不明提交；保留 receipt 和可恢复 ID，不自动重发 | 通过 | turns / headless-turn / background；真实创建跟进成功，超时与不明提交为模拟 |
| V20 | 后台本地任务 | 不带 --wait 时 detached worker 的路径、账号、权限及项目一致；父进程退出后可查询/恢复/停止 | 通过 | headless-worker / background；生产包子进程到达隔离 login_required；未新建真实脱离终端长任务 |
| V21 | MCP 与附件 | 重复连接器/参数/环境变量、附件文件失败、Desktop 组合限制；真实工具结果不能仅采信模型文字 | 通过 | headless-mcp / headless-attachments / mcp-permissions；模拟工具/附件，未新建真实 MCP 服务 |
| V22 | 自动任务 | 隔离模拟服务覆盖 CRUD、JSON 字段校验、找不到任务、接口失败；真实账号写操作按必要范围执行 | 通过 | scheduled-tasks / automation；模拟 CRUD，未改用户真实定时任务 |
| V23 | 设置、更新和皮肤 | 隔离设置目录验证 on/off/status；模拟更新服务，不意外更新全局命令或修改用户日常配置 | 通过 | skin / update / update-cli；隔离配置和模拟更新 |
| V24 | 错误与输出契约 | 比较 stdout/stderr、JSON 字段/类型/null、退出码、错误顺序；不把必要平台差异误当重构回归 | 通过 | cli / headless-cli / update-cli；冻结解析错误；业务分派和后置校验正文逐字节一致 |
| V25 | 自动回归 | 基线与候选各运行相关测试及全套测试；Node 22/24；使用 TS 时开启严格检查及外部数据运行时校验 | 通过 | 本地 Node 22.16.0 / 24.10.0 各 496 项；typecheck 通过；GitHub CI 状态以本轮 PR 的 Node 22/24 检查为准 |
| V26 | 打包安装 | npm pack 后安装到隔离前缀；验证 bin、编译输出、静态资源、子进程入口、动态加载及后台 worker | 通过 | verify-package：两种 Node 生产依赖隔离安装、125 个帮助入口、后台 worker |
| V27 | 真实账号关键流程 | Desktop 与 Headless 各验证：local AskOnRisk 创建 → 省略参数跟进 → 清除项目 → 切换 cloud；服务端回读确认 | 通过 | 安装产物真实账号共 8 轮；回读与固定回复验证；两个测试会话最终已归档 |

## 验证证据

验收开始时固定旧版和候选提交，保存依赖版本、Node 版本、操作系统、候选 tarball 校验值和实际执行入口。需要其他 Node 版本下限时单独记录，不能静默提高 `engines`。

每个矩阵 ID 展开成具体用例；平台和变体用后缀区分，例如 `O09-H-read-101`。一行父项只有在所有必需子用例完成后才可标为通过。

| 用例 ID | 基线 / 候选提交 | 平台 / Node | 脱敏 argv 与前置条件 | 预期 | 实际 / 退出码 / 副作用 | 复现步骤与证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 待填写 | — | — | — | — | — | — | 未验证 |

真实账号证据记录会话/run 的可追溯标识及服务端回读字段。私有响应、账号标识、任务标题、Cookie、Token 和 MCP 环境变量不提交到仓库；文档只引用脱敏摘要和私有证据位置。

## 已知差异与残留

这些是基线源码观察，不代表候选已验证，也不自动授权改变行为。

| ID | 观察 | 后续处理要求 |
| --- | --- | --- |
| K01 | web / --platform web 在 CLI 被归一化为 Headless；底层仍有旧 Web 分支和 --target 定义 | 保留兼容入口；删除死代码与改变公开行为分别记录 |
| K02 | Desktop 帮助仍称权限需每轮重复、遗漏恢复 FullAccess；当前 PR 实现已继承保存的本地权限 | 帮助与实现的修正作为明确差异验收 |
| K03 | Headless 根帮助没有单列 model，但实现支持 model = model current | 帮助补全不应改变命令行为 |
| K04 | Headless 根帮助把 sessions create 写为必须带消息；实现允许无消息返回本地 draft | 区分本地草稿与服务端会话，不能误写为创建服务端空会话 |
| K05 | 部分 Desktop 选项已被接受，但根帮助没有逐命令列全，例如 timeout/profile | 从选项契约及实际运行验证生成完整帮助，不能只照旧帮助复制 |

## 行为差异记录

| ID | 旧行为 | 新行为 | 原因与确认依据 | 受影响命令 / 选项 | 验证用例 / 结果 |
| --- | --- | --- | --- | --- | --- |
| D01 | Headless 根帮助和子命令选项使用各自的列表顺序 | 统一命令/选项定义后的顺序 | 仅调整帮助显示顺序；命令语法、业务输出、退出码无变化 | Headless help | 125 个安装后帮助入口验证通过 |
| D02 | 源码 checkout 可直接运行入口 | checkout 需要先 npm run build | TypeScript 编译边界；npm test/pack 自动构建；安装包已包含编译输出 | 开发与打包 | Node 22/24 隔离生产依赖安装通过 |

## 完成条件

- 命令、选项及专项用例逐项有可追溯结论；所有必需项通过，不适用项有原因。
- 解析差分、模拟请求/副作用对比、Node 22/24 回归、候选包隔离安装验证通过。
- 用用户账号完成两种后端的必要关键流程，读取服务端结果；明确区分源代码、测试、安装产物和真实账号证据。
- 所有行为变化有明确记录；失败和未覆盖项不能计为通过。真实账号未运行的高风险分支明确给出模拟/隔离证据和验证边界。
- 最终 PR 附命令/选项覆盖结果、差异记录、测试结果、打包验证及脱敏真实账号验收摘要。

## 本轮验证记录（2026-10-28）

- `src/command/*.mts`：TypeScript 严格模式下的命令定义、选项定义、Commander 参数解析和帮助。业务适配器继续使用原实现。
- Commander 固定 `13.1.0`，保持包声明 `node >=22`；TypeScript 固定 `5.9.3`，只用于开发构建。
- 冻结差分：5,738 个 argv 用例，覆盖三个显式后端、Linux/macOS 默认、有效/无效组合、重复参数、缺值、边界、help 与 `--` 原文。期望值从固定基线的隔离 Git archive 生成；不调用真实账号。测试用例中的 commandPaths 统计包含命名空间，和上方 C01–C46 的业务清单计数口径不同。
- 基线全套测试 495 项；候选 Node 22.16.0 和 Node 24.10.0 各 496 项通过。其中 1 项自动测试包含上述 5,738 个差分用例，不能把它们混报为 5,738 个独立业务测试。
- `run(options)` 业务分派函数与基线逐字节一致；抽离到 `cli-validation.mjs` 的后置校验正文与基线逐字节一致。5738 个解析结果/错误相等，加上该边界检查，构成命令层兼容性的证据；不声称所有远端功能都已重新实测。
- Node 22/24 均通过生产包隔离安装：不安装开发依赖、不执行安装脚本，125 个帮助入口、web 别名、后台进程启动均通过。后台进程使用无凭证隔离目录，正常到达预期 login_required，不使用用户会话。
- 安装产物真实账号验收：Desktop/CDP 与 Headless/HTTPS 同一账号，共 8 轮完成；初始/跟进固定回复、AskOnRisk 继承、项目与 workspace 继承、清除项目后的 workspace 变化、cloud 无本地 workspace 均已回读确认。
- 两端各验证 rename、pin、unpin、move 到项目、move none、archive、unarchive，并最终归档测试会话。全部返回 verified:true。
- 全量列表两端各 117 页，2,338 个会话 ID/runtime 完全相同，无重复、hasMore:false、complete:true；项目列表各 5 个，ID 一致。
- 完整日志及真实账号私有证据目录：`~/.local/state/doubao-cli/validation/cli-refactor-2026-10-28/`。`receipt.json` 记录候选 tarball integrity；52 个已安装运行时文件与当前源码/编译产物逐一一致。

复现命令（在仓库根目录运行）：

```sh
npm ci
npm run build
npm run typecheck
node --test test/cli-compatibility.test.mjs
npm test
npm run test:package
```

重建冻结期望值仅用于审查基线，不能用候选版本覆盖原期望来消除差异：

```sh
node scripts/generate-cli-compatibility.mjs 3dae8b4de6910cc943bd033aedbb056c25855625
```

## 源码依据

- [TypeScript 命令定义](../src/command/commands.mts)
- [TypeScript 选项定义](../src/command/options.mts)
- [Commander 解析与兼容归一化](../src/command/parser.mts)
- [命令执行与退出码](../src/cli.mjs)
- [后置参数校验](../src/cli-validation.mjs)
- [冻结差分测试](../test/cli-compatibility.test.mjs)
- [隔离安装验收](../scripts/verify-package.mjs)
- [选项适用范围与位置参数约束](../src/options-contract.mjs)
- [Headless 校验、草稿与任务执行](../src/headless.mjs)
- [runtime、项目与 workspace 共享解析](../src/task-context.mjs)
- [权限解析与继承](../src/permissions.mjs)
- [Headless FullAccess 确认](../src/headless-approval.mjs)
- [共享列表与分页服务](../src/list-services.mjs)
- [Desktop 列表适配器](../src/desktop-list-client.mjs)
- [皮肤设置](../src/skin/index.mjs)
