# 官方运行时可行性研究（历史）

2026-09 的调查确认：Windows 官方 Codex 桌面拥有内部 IPC 和独立 stdio App Server。桌面打开时 Agent 可跟随现有 owner；桌面释放会话 writer 后，可用单独 App Server 恢复同一持久化会话。不能把另一 App Server 当作正在运行的官方桌面进程。

调查没有修改官方应用文件，也没有公开本机运行时端口。当时 Windows 验证包含实际发送与精确 turn 停止；App Server 还覆盖审批和用户输入。内部 IPC 方法和模拟 owner 测试不能代替每个官方版本的实机兼容验收。

主要风险是内部 IPC 的消息版本、socket 路径和 owner/writer 生命周期随官方升级变化。遇到未知协议需停止控制并重新验证，不能绕过不兼容状态继续发送。

本次架构已加入账号隔离、统一 React Native 控制端、独立 React 后台、Electron PC 连接器与统一服务器安装。当前功能以 [架构](architecture.md)、[使用指南](usage.md) 和 [验证范围](validation.md) 为准。macOS IPC 路径仍需实机确认。

旧 JSON 调查数据已从 `docs` 清除，清理前副本仅保存在 Git 忽略的本地回退目录，不进入源码导出或服务器发布包。历史调查结论不代表当前全部功能或平台已验收，详见 [清理说明](cleanup.md)。
