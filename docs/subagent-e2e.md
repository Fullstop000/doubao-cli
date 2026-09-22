# 整轮任务与子任务验收

2026-09-22，本机 DoubaoWork 2.30.5、Doubao 2.30.2，0.11.0 整轮任务与子任务支持的发布前验收。0.10.0 不包含这些变更。

## 变更

- `create/send --wait` 等待本轮 organizer、子任务和主会话最终回复；附件、文本和 MCP 共用结果读取。
- 返回 `runId`；新增 `sessions status/wait --run`，超时保留任务，可在新进程续等。
- 返回 `waiting_input` 和问题/审批选项，CLI 不代答。`reply` 仅在整轮成功时返回，产物元数据在 `artifacts`。
- `sessions stop --run` 停止关联父子任务，回读确认。保存取消结果，避免官方把被中止线程标成 completed 后，CLI 报整轮成功。

## 实机结果

| 场景 | 结果与证据 |
| --- | --- |
| 原问题复现 | 0.10.0 提前返回委派文字；同轮稍后产生主汇总。`live-initial.json`、`live-snapshot.json` |
| Work 并行子任务 | organizer + 两个子任务，等到 `CLI_SUBAGENT_V2_DONE` 主汇总，3/3 completed。`candidate-work.json` |
| 无等待、短超时、新进程续等 | 返回固定 runId，短等待退出 1，另一进程取得 `RESUME_DONE` 和 3 个完成任务。`resume-*.json` |
| 普通流恢复 | 复用原请求 unique_key/local_message_id 和 recovery_option，回到同一 runId。`recovery-created.json`、`recovery-final.json` |
| 轮次隔离 | 新轮进行时读取、停止已完成旧轮；新轮随后完成，`sessions wait --expect-json` 通过。`isolation-*.json` |
| 附件 + 子任务 | 上传合成文本，两个子任务完成后返回正确标记和主汇总，3/3 completed。`attachment-result.json` |
| 附件无等待 | send 返回 runId，另一进程 wait 取得附件标记。`attachment-nowait-retry.json`、`attachment-nowait-final.json` |
| 待输入 | 真实澄清工具生成 A/B 选项，create --wait 返回 waiting_input、reply:null、退出 1；status 再次读到问题。`pending-v4.json`、`pending-status-final.json` |
| MCP 超时恢复 | 8 秒超时后续等，12 秒工具返回 pong；本地日志只有一次 start 和一次 result，未重复调用。`mcp-timeout.json`、`mcp-final.json`、`mcp-calls.jsonl` |
| 父子任务取消 | 停止前 3 个线程均运行；停止后无 running/unknown，stop/status 返回 cancelled，另一等待进程退出 1。`stop-v3-*.json` |
| Work 缺失回退 | 仅在测试进程隐藏 Work 安装探测，默认连接普通 Doubao 9225；真实生成和新进程续等得到 `FALLBACK_SUBAGENT_OK`、3/3 completed。`fallback-*.json` |
| 清理 | 临时 MCP 连接器账号与运行时均移除，前后原有连接器列表相同；待输入测试已停止，恢复测试前页面。`mcp-removed.json`、`mcp-before.json`、`mcp-after.json`、`cleanup-*.json` |

87 项单元测试通过，skill 校验通过。`npm pack` 后在隔离目录安装，逐文件核对包内源码一致；安装包的 capabilities、JSON 续等、已取消状态、普通版回退状态查询均通过。

全部原始证据保存在 `.e2e/subagent-audit/`，含本机会话内容，不提交 Git。单元测试、打包和隔离安装见该目录的 `unit.txt`、`pack.json`、`installed-check.json`。

## 已处理的失败

- 直接请求线程终止接口返回 HTTP 400，改用 App 的 AGWTaskTerminate 服务并完成真实复测。
- 官方线程在取消后可能仍标 completed。CLI 持久化自己的取消请求和确认结果，另一个等待进程也返回 cancelled。
- 运行中的控制卡片可能尚未写入历史接口；从主流/异步流保存控制块，历史中的已处理状态优先。
- 多个编辑器存在时可能选中隐藏模型按钮；改为查找可见控件。没有重启、深链打开或显式激活 App。
- 清理后发现飞书独立 MCP runtime 还保留一个测试 server；确认进程命令行只指向本轮测试脚本后发送 SIGTERM。两套 Doubao 工具目录均无测试连接器，未停止 App 或其他连接器。
- 一次附件 create 停留在本地临时会话，未取得服务端 ID，未报成功；错误现在携带 localMessageId 并提示先确认发送状态。附件 create + 子任务和附件 send 无等待已分别通过；服务端未接受消息时仍不能保证可恢复。

## 边界

- 这不是所有 CLI 指令的重新全量验收；基础双应用覆盖见 `doubaowork-e2e.md`。本轮针对新增生命周期能力。
- quick-reply 审批分支有单元覆盖，实机待输入验证的是澄清问题；未自动提交任何审批。
- 产物字段有单元覆盖。实机 artifact 请求只生成普通代码块，不能据此声称真实文件/画布产物回收已验证。
- 真实 MCP 验证了主任务工具的超时续等，未验证子任务内部调用自定义 MCP。
- 模拟断流验证游标续接/子流发现；实机验证跨进程、超时恢复。没有故意断网或重启 App。
- 普通版回退采用安装探测夹具，未卸载 Work。取消真实验证在 Work；不据此声称普通版子任务取消也完成实机验收。
- 任务查询限最近 100 条主会话消息、100 个线程、每线程 20 页。超限或历史缺失明确失败；未实现完整历史导出、完整子任务列表、事件订阅。
- 监听前台期间包含用户切到 Work 的记录，不能证明全程无前台出现；实现没有主动激活窗口，未把前台状态作为测试前置。
