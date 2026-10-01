# PC Agent 核心

Node/TypeScript 本机服务，由 Electron utilityProcess 内置运行。负责 Codex 适配、项目/会话扫描、状态同步、命令幂等、队列和用量；不是另一个控制客户端。

`PcAgent.disconnect()` 只暂停远程通道，`reconnect()` 明确恢复，`stop()` 关闭本机服务与 App Server。不要用 stop 实现 UI 断开。CLI `npm run dev:agent` 仅保留作开发/兼容入口，普通用户使用 Electron 安装包。

账号登录/接口见 [API](../../docs/api.md)，状态与任务边界见 [架构](../../docs/architecture.md)，用户操作见 [PC 文档](../../docs/pc-setup.md)。
