# 桌面客户端技术约定

2026-10-30 用户更新决定：**优先将 PC 连接器 Codexer Agent 改为 Qt，以降低内存；Codexer Control 暂不迁移，继续使用 React Native 原生宿主。** 本条取代 2026-10-24 连接器使用 Electron 的约定；控制端约定保持。

- Codexer Agent 使用 `apps/agent-qt` 的 Qt Widgets 界面和同进程 C++/Qt 后台；2026-10-30 用户进一步确认后台也须移除 Node 以降低常驻内存。沿用共享协议与行为，TypeScript 仅保留旧发行入口及迁移对照。不使用 Qt WebEngine/WebView 承载管理界面。Windows 默认 `package:desktop:win` 生成 Qt 包；旧 Electron 显式入口保留用于回退。macOS Qt 源码与实际编译验收分开记录，未完成验收前保留既有发行版。
- Codexer Control 的 Windows/macOS 共用 `apps/control-native/src`、`apps/mobile` 的界面与业务状态，Windows 使用 React Native for Windows，macOS 使用 React Native macOS。主界面本机渲染，随客户端安装包交付。预览用户网页可使用隔离 WebView。
- 两类产品在 `main` 维护，平台差异只放进相应系统适配层；不得为 Windows/Mac 长期维护独立功能分支或复制整套业务界面。
- Agent 版本来自 `apps/desktop/package.json`，Control 版本来自 `apps/control-native/package.json`；各产品两平台使用同一版本来源。UI、后台与安装包读取对应来源，不另写版本常量。
- 两个产品使用不同的图标：Agent 是蓝色终端连接标记，Control 是紫色屏幕对话标记。窗口、托盘、安装包、快捷方式、macOS Bundle 显示名和 Windows 资源都使用完整产品名。
- 改名保留应用 ID（Agent `com.codexer.connector`、Control `com.codexer.control`）、既有配置目录、设备身份及凭据加密身份。不能只改 productName 后丢失原有设置或创建重复设备。
- 保留托盘/菜单栏、默认关闭留在后台、退出确认、自动连接、重启、运行时刷新、客户端更新和登录项。Qt Agent 兼容 `session.native.enc` 及旧 Electron 的 `session.enc`；仅在新加密登录写入成功后视为迁移完成，退出登录清除两者。不能用重新生成设备身份绕过凭据迁移。
- `apps/control-desktop` 的 Electron 控制端只保留历史维护入口；其内部 IPC/工程名可沿用旧名，不得把旧工程名当作新的用户可见产品名。
- 交付时分别说明源码、构建、安装包和实机验收结果。Qt 和 Control 都必须实际原生编译后才能宣称构建通过；JS 打包或类型检查不能代替。内存对比说明采样进程范围和任务状态。不要因 Agent 迁移而改动 Control 的宿主技术。

实现和发布入口见 [桌面架构约定](docs/desktop-native.md)。
