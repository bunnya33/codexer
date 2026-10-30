# Codexer Agent

Windows / macOS PC 连接器的共享控制器、版本来源与旧 Electron 回退工程。2026-10-30 用户要求优先将连接器改为 Qt；新版原生界面见 [Qt Agent](../agent-qt/README.md)。产品名、窗口、安装包和快捷方式使用 Codexer Agent，图标为蓝色终端与绿色连接点。

`npm run package:desktop:win` 生成 Qt Agent，输出至 `apps/agent-qt/release`。旧 Electron Windows 包改用 `npm run package:desktop:electron:win`；`build:desktop` 与 `dev:desktop` 保留历史调试用途。Mac 既有 Electron 发行入口仍为 `npm run package:desktop:mac` 或 `npm run package:desktop:mac:local -- --arm64`，未完成 macOS Qt 实机验收前不替换发行架构。

保留旧应用 ID、配置目录、设备身份、系统加密凭据、后台与启动偏好；从原生 Agent 回退时兼容 `session.native.enc`。使用见 [PC 文档](../../docs/pc-setup.md)，Mac 见 [macOS](../../docs/mac.md)，决策见 [桌面架构](../../docs/desktop-native.md)。
