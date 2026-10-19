# RelayDesk 控制端

Windows 新版使用 [React Native for Windows](../control-native/README.md)。原生界面、宿主、平台适配和安装包位于 `apps/control-native`；根目录 `npm run package:control-desktop:win` 已切换到原生构建，输出 `RelayDesk-Native-Setup-0.2.0-x64.exe`。

本目录保留 Electron 旧版维护源码：主进程管理窗口、托盘、地址配置与 WebContentsView，控制页来自服务器 Web 导出。它不作为新版 Windows 原生客户端交付。

旧版开发可运行 `npm run dev:control-desktop`。仅维护旧版时，使用 `npm run build:control-desktop`，再执行 `npm run package:win --workspace @codexer/control-desktop`。

RelayDesk 用户数据位于 `%APPDATA%\CodexerControl`。原生版兼容已有服务器地址与可迁移登录凭据。图标源文件保留在 `assets/icon.svg`，可用 `node scripts/generate-control-icons.mjs` 更新 PNG 与 ICO。
