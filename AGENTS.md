# 桌面客户端技术约定

2026-10-24 用户更新决定：**PC 连接器恢复 Electron，产品名为 Codexer Agent；PC 控制客户端产品名为 Codexer Control，Windows 和 macOS 控制端继续使用 React Native 原生宿主。** 本条取代 2026-10-19「两类桌面客户端都使用 Native」及后续 Mac Agent 原生迁移约定。

- Codexer Agent 的 Windows/macOS 共用 `apps/desktop` 的 Electron 主进程、本地 React 管理界面、受限 preload IPC 和 `apps/pc-agent` 后台核心。默认 `package:desktop*` 必须生成 Electron Agent；不再交付原生 Agent。
- Codexer Control 的 Windows/macOS 共用 `apps/control-native/src`、`apps/mobile` 的界面与业务状态，Windows 使用 React Native for Windows，macOS 使用 React Native macOS。主界面本机渲染，随客户端安装包交付。预览用户网页可使用隔离 WebView。
- 两类产品在 `main` 维护，平台差异只放进相应系统适配层；不得为 Windows/Mac 长期维护独立功能分支或复制整套业务界面。
- Agent 版本来自 `apps/desktop/package.json`，Control 版本来自 `apps/control-native/package.json`；各产品两平台使用同一版本来源。UI、后台与安装包读取对应来源，不另写版本常量。
- 两个产品使用不同的图标：Agent 是蓝色终端连接标记，Control 是紫色屏幕对话标记。窗口、托盘、安装包、快捷方式、macOS Bundle 显示名和 Windows 资源都使用完整产品名。
- 改名保留应用 ID（Agent `com.codexer.connector`、Control `com.codexer.control`）、既有配置目录、设备身份及凭据加密身份。不能只改 productName 后丢失原有设置或创建重复设备。
- 保留托盘/菜单栏、默认关闭留在后台、退出确认、自动连接和登录项。原生 Agent 退回 Electron 时须处理现有 `session.native.enc`，成功转存到系统加密的 `session.enc` 后再删除旧文件；退出登录须清除两者。
- `apps/control-desktop` 的 Electron 控制端只保留历史维护入口；其内部 IPC/工程名可沿用旧名，不得把旧工程名当作新的用户可见产品名。
- 交付时分别说明源码、构建、安装包和实机验收结果。Control 必须实际原生编译后才能宣称原生构建通过；JS 打包或类型检查不能代替。不要因 Agent 选择 Electron 而把控制端一并改成 Electron。

实现和发布入口见 [桌面架构约定](docs/desktop-native.md)。
