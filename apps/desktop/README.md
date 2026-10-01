# Electron PC 连接器

Windows/macOS 完整控制台：状态、账号登录、连接/断开/重连、设备设置、诊断、托盘和启动偏好。内置 Electron Node/SQLite，PC 用户无需 Node；本机需要已安装并登录官方 Codex。

`src/main.ts` 管理系统功能和凭据，`controller.ts` 管理状态/操作，`preload.ts` 暴露窄 IPC，`worker.ts` 在 utilityProcess 内运行 PC Agent，`src/renderer` 是 React UI。包内不含用户真实设置。

根目录 `npm run dev:desktop` 开发；`npm run package:desktop:win` / `package:desktop:mac` 打包，输出 `release`。使用见 [PC 文档](../../docs/pc-setup.md)，Mac 范围见 [macOS](../../docs/mac.md)，发行见 [发布](../../docs/release.md)。
