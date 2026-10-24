# Codexer Agent

Windows / macOS PC 连接器。2026-10-24 用户决定恢复 Electron，实现由两平台共用的本地 React 管理界面、受限 preload IPC、Electron 主进程和 PC Agent worker 组成。产品名、窗口、安装包和快捷方式使用 Codexer Agent，图标为蓝色终端与绿色连接点。

从根目录运行 `npm run build:desktop`、`npm run dev:desktop`，或 `npm run package:desktop:win` / `npm run package:desktop:mac`。Mac 本机 ad-hoc 包用 `npm run package:desktop:mac:local -- --arm64`。输出到本目录 `release`。

保留旧应用 ID、配置目录、设备身份、系统加密凭据、后台与启动偏好；从原生 Agent 回退时兼容 `session.native.enc`。使用见 [PC 文档](../../docs/pc-setup.md)，Mac 见 [macOS](../../docs/mac.md)，决策见 [桌面架构](../../docs/desktop-native.md)。
