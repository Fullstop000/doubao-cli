# Doubao 双应用验收

2026-09-21，本机 DoubaoWork 2.30.5、Doubao 2.30.2。本文记录 CLI 0.10.0 的发布前验收。

Work 的 149 项命令、回读和安装检查通过；普通 Doubao 自动回退的 171 项检查通过。后台专项两版各 24 项通过，最新单元测试 68/68。计数按检查名称去重，使用最后一次结果，包含复测；阶段汇总不计入检查数。

| 范围 | 实测内容 | 结果 |
| --- | --- | --- |
| 基础 | help、version、status、profiles、capabilities；profile 目录名和显示名 | 通过 |
| 应用选择 | 默认 Work、显式选择、错误应用端口拒绝、无授权重启拒绝 | 通过 |
| CDP | status、授权 launch、已启动时 launch/launch --yes | 通过 |
| 会话 | list、current、空白 create、带消息 create、open、read、limit、send、--wait、无等待后回读、`--` 字面消息 | 通过 |
| JSON | 合法回复、schema 校验、非法回复退出非零、schema/参数在发送前拒绝 | 通过 |
| 模型 | Work 全部 8 个、普通版全部 7 个模型切换并回读；草稿切换；每次发送指定模型 | 通过 |
| 推理 | low、medium、high、xhigh、max 修改并回读 | 通过 |
| 附件 | 单文件、重复 --attach、多文件内容标记、图片颜色、重复图片数量及消息回读 | 通过 |
| 中断 | 真实生成中停止、页面仍显示旧消息时停止、服务端中断标记回读、空闲停止、无效会话报错 | 通过 |
| MCP | 注册到 READY、重复 --arg/--env、工具目录、多轮调用、本地 server 结果 | 通过 |
| 权限 | 默认 FullAccess、AlwaysAsk、AskOnRisk、显式 FullAccess、恢复默认；请求值 2/0/1/2/2、workspace、空 skill 列表 | 通过 |
| 清理 | 连接器账号记录消失、本地工具目录移除、临时 server 退出、原有企查查状态不变 | 通过 |
| 更新 | update check、update、auto on/off/status；独立安装目录内执行真实 npm 升级并回读版本 | 通过 |
| 打包 | npm pack、独立安装、包内源文件与工作树逐文件一致；安装后的 status/models/read/mcp/stop | 通过 |
| 异常输入 | 无效应用/profile/ID/模型/推理/权限、缺失附件、附件目录、冲突参数、无效 schema 和命令 | 通过 |

本轮修复：

- 使用所选应用的协议、端口、数据目录和实时模型参数；不会因登录或 CDP 失败切到另一个应用。
- 从当前账号的 IndexedDB 快照列出会话，从页面路由取得当前会话。
- 修正 Work 深链，回读消息时刷新并等待附件挂载，发送附件前等待编辑器状态提交。
- 模型和推理修改后核对服务端状态，避免旧页面显示误导结果。
- 停止操作查询服务端最新消息，发出中断请求并核验结果。
- MCP 删除先核对账号记录，再确认本地工具移除；模块调用等待页面和代码块就绪。
- MCP 强制要求消息和 `--wait`；JSON 校验配置在发送前检查；非活动 profile 拒绝消息、模型和连接器操作。
- 普通命令缺少聊天页时直接报错，不再隐式调用深链唤起窗口；显式 `sessions open` 保留。

复跑：

```bash
npm test
npm run test:e2e -- --app work
npm run test:e2e -- --fallback
```

需要所选应用已登录并开启 CDP。测试使用合成消息和附件，创建临时 MCP 连接器；会保留测试会话，清理连接器并恢复开始时的页面。请顺序运行，避免同时操作同一应用。

逐项命令、输出和时间保存在 `.e2e/work/results.jsonl`，最新汇总为 `.e2e/work/summary.json`，本地工具日志为 `.e2e/work/mcp-calls.jsonl`；这些含本机会话标识的文件不进入 Git。单元测试输出在 `.e2e/unit-final.txt`。

普通 Doubao 回退补测：

- 本机普通 Doubao 2.30.2，Profile 1。使用测试进程 preload 仅将 `/Applications/DoubaoWork.app` 的存在检查返回 false；默认命令不传 `--app`，其余文件读取、进程检查和连接均使用实机。未移动或卸载 Work。
- 经授权重启普通版到 9225，完成全部 CLI 命令回归：会话、7 个模型、5 档推理、JSON、文件、图片、中断、MCP、异常输入及更新。隔离安装后的候选包也验证了 status、models、read、mcp list、stop。
- MCP 五轮返回真实 server 结果；权限请求值为 2/0/1/2/2。每轮核对 `aid=582478`、普通版 Profile 1 工作目录，以及 server 的父进程属于 `/Applications/Doubao.app`。
- 删除后，两套应用的账号目录与本地工具目录均不再包含测试连接器，临时 server 退出；企查查仍启用。Work 的 PID、页面、草稿和附件数不变，普通版恢复初始页面和空白输入。
- 首次停止测试的准备消息在 120 秒内未产出回复，CLI 退出非零并自动中断；服务端回读为 `is_interrupted=true`。同一测试复测通过。此轮没有发现需要修改产品代码的回退缺陷。
- 171/171 检查通过，记录在 `.e2e/fallback/results.jsonl`、`.e2e/fallback/summary.json`；工具日志为 `mcp-calls.jsonl`，中断回读为 `stop-readback.json`、`stop-timeout-conversation.json`。单元测试为 62/62，输出在 `.e2e/unit-fallback.txt`。

后台专项：

- Work 与自动回退的普通版各 24/24，包括会话创建、发送、读取、模型和推理切换、文件上传、空闲停止、MCP 注册/真实调用/删除、页面恢复。使用已有 CDP，未执行 `sessions open` 或重启。
- 使用 AppKit 读取前台应用，目标采样间隔 50 ms；Work 记录 1391 次、普通版 1577 次，未采到任何一次 Doubao/DoubaoWork 前台状态。期间捕获了用户在飞书、浏览器和 Codex 间切换；不把用户切换其他应用判为失败。
- Work 首次清理断言未等待编辑器挂载，把空字符串与空编辑器换行判为不同；测试已修正，恢复页面、空草稿和原有连接器的核验通过。产品操作及该次前台采样均通过，原始失败记录保留。
- 6 项缺页回归覆盖两版的读取、推理和附件发送：返回明确错误，未启动深链或焦点恢复进程。全部单元测试 68/68，见 `.e2e/unit-background.txt`。
- 复跑：`node scripts/e2e-background.mjs --app work --output .e2e/background-work`，再运行 `node scripts/e2e-background.mjs --fallback --output .e2e/background-fallback`。两目录分别保留命令结果、`foreground.jsonl` 和真实 MCP 日志。

边界：

- 验证针对上述应用版本和当前账号；应用内部接口变化后需复测。全部模型验证了选择和回读，实际生成分别以 GPT-6 Astra、GPT-5.6 Sol 为主；发生过一次生成超时，不能据此保证服务始终可用。
- Work 缺失由测试进程夹具模拟；其后的普通 Doubao 命令、模型生成、附件上传和 MCP 执行均为实机。未验证卸载 Work 的操作。
- 前台采样不能排除采样间隔内的极短激活；没有持续证明应用启动/重启、显式深链和所有外部工具都不激活窗口。此次普通调用无前台依赖，缺聊天页不会自动唤起。
- AskOnRisk/AlwaysAsk 的请求值和工具执行均验证；这不代表每次 MCP 调用都会弹审批，也不限制 MCP server 进程自身权限。
- 消息读取依赖页面已加载内容，不能视作完整历史导出；离线 profile 的旧格式缓存不保证包含新版会话。
- 本报告中的更新安装测试只作用于独立目录；实际升级安装分支在 Work 回归中验证，普通版验证了检查、当前版本无需升级和自动更新设置。正式发布和本机升级单独验证。
