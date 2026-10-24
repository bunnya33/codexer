# Codexer Control 历史 Electron 控制壳

Windows/macOS 的新版控制客户端名为 **Codexer Control**，使用 [React Native 原生实现](../control-native/README.md)。根命令 `package:control-desktop:win` / `package:control-desktop:mac` 生成原生 Control，输出到 `apps/control-native/release`。

本目录保留旧 Electron 控制壳维护源码，主进程管理窗口、托盘、地址与服务器 WebContentsView。它不作为新版原生 Control 交付。2026-10-24 恢复 Electron 的决定只针对 **Codexer Agent**，不把 Control 一并改回 Electron，详见 [桌面约定](../../docs/desktop-native.md)。

历史维护用 `npm run dev:control-desktop`，或 `npm run build:control-desktop` 后运行 `npm run package:win --workspace @codexer/control-desktop`。旧壳的可见名称也改为 Codexer Control，内部 Safe Storage / IPC 名称保留兼容。

原有应用 ID 和 `%APPDATA%\CodexerControl` 数据目录不变。紫色对话图标源在 `assets/icon.svg`，`node scripts/generate-control-icons.mjs` 生成 PNG、ICO、ICNS，供两平台原生 Control 使用；与 Agent 的蓝色终端图标区分。
