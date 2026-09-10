# 项目复审与修复记录

本次审查覆盖配置、CLI、Herdr 运行适配、任务状态机、Git 工作树、结果证据、持久化和恢复流程。保留现有命令与旧版 camelCase 状态文件兼容性。

## 已修复的问题

| 问题 | 修复与验证 |
| --- | --- |
| 类型与启动参数写死为 Codex | 支持 Codex、OpenCode、Pi、Gemini，并兼容 Claude Code；分别生成原生参数、角色权限与会话恢复参数。配置示例采用用户指定的四种类型。 |
| 重试可能接入同目录其他角色的最近会话 | 按类型、身份和目录保存明确 session 引用；Pi、Gemini 支持 ID 和文件路径。兼容旧版纯 ID 记录；运行记录增加可选 `agentKind`。 |
| 独立测试失败仍可获批 | 审查批准前强制检查测试通过。回归测试复现了旧版错误的 Completed 结果。 |
| 审查者可以修改已测试的工作树 | 审查与集成确认后检查 HEAD 和工作树；验证命令也不能改变被验证的提交。 |
| 测试返工丢失审查意见 | 将具体问题传入 tester 的 `reworkIssues`。 |
| 并行任务重规划覆盖其他任务成果 | 在当前批次结束后重新读取状态再规划；保留已批准/完成的证据，替换任务使用新 ID。测试覆盖两个不同类型 coder 的并行流程。 |
| 编码、测试、审查中断后恢复停滞 | 重新核实 coder 提交和 tester 的纯测试提交，再进入测试与审查；覆盖 9 种中断/提交组合。 |
| 集成中断后重复 cherry-pick | 从 Git 重建已应用提交前缀并核对 patch ID；失败 pick 回滚，保留成功前缀。 |
| 删除工作树后重建丢失 task base | 重建已记录的任务工作树时保留原始基准与任务提交范围。 |
| Git 报错被误认为工作树干净 | 检查 Git 退出码；文件列表改用 NUL 分隔，正确保留中文、空格和换行。 |
| 验证程序缺失或卡住，状态未正确落盘 | 缺失、失败、超时均记录为验证失败；可配置超时，Unix 下清理验证进程组。 |
| 多个 CLI 同时改写状态，锁失败误伤其他任务 | 增加跨进程的仓库级文件锁；执行错误处理与任务锁共用生命周期，不吞掉存储错误。 |
| 不安全任务 ID 可越过 tasks 目录写文件 | 持久化前验证 ID，检查文件系统大小写冲突和快照 ID 一致性；初始化最后发布 plan。 |
| 提示中未闭合的结果标记遮挡真正结果 | 从最后一个可解析标记读取结果，先保留原始文本，必要时再恢复终端软换行。 |

## 配置与验收

完整配置见 [examples/mixed-agents.toml](examples/mixed-agents.toml)，使用方法见 [README.md](README.md)。原有全 Codex 配置仍有效。新增 `agent_timeout_seconds`、`validation_timeout_seconds`，旧配置省略时均为 3600 秒。

各角色的 `thinking` 可省略或设为 `default`。Pi 支持其原生思考档位，OpenCode 显式档位作为 `reasoningEffort` 传给支持它的 provider；Gemini 保留原生模型配置，拒绝不能映射的显式档位。启动差异集中在私有 `agent_launch` 模块。

自动化验收使用临时 Git 仓库、真实 Git 操作、模拟 agent 结果和可执行的 Herdr 替身，覆盖完整生命周期及上述故障路径。检查命令：

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
```

新增类型的验收覆盖只读/可写角色、带引号和空格的目录、正确的退出命令、指定 session 恢复、旧 session 文件格式兼容，以及四类型团队经过完整 Git 生命周期。

最新本地验收：49 项测试通过，1 项真实 Herdr 冒烟测试未运行；格式检查、Clippy（warnings 视为错误）、diff 检查及 release 构建均通过。Pi 本机版本为 0.84.4。

真实 Herdr 冒烟测试保留为显式 opt-in。此次环境有 Herdr、Codex 和 Pi，缺少 OpenCode、Gemini、Claude CLI；Pi 的参数已通过本机帮助核实。未执行真实混合团队会话，也未改变用户的终端布局。自动化通过不等同于已验证账号的模型可用性或外部服务稳定性。

参数依据 [OpenCode CLI](https://opencode.ai/docs/cli/)、[Pi 文档](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、[Gemini 参数定义](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)和 [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)。Herdr 进程、目录和 session 字段依据[官方 CLI 文档](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.0/docs/next/website/src/content/docs/cli-reference.mdx)及本机只读查询。各原生工具权限与 Codex 文件系统沙箱的区别见 README。
