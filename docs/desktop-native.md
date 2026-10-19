# 桌面原生化约定

2026-10-19 用户确认：后续桌面客户端统一使用 Native 实现。覆盖 RelayDesk 会话控制端和 Codexer PC 连接器，Windows 使用 React Native for Windows，macOS 使用 React Native macOS。React Native、原生宿主和组件库的具体版本以可构建、可验收的兼容组合为准。

## 当前状态

Windows 新版 `0.2.0` 位于 `apps/control-native`。RelayDesk 复用移动端 React Native 会话组件；Codexer PC Agent 的管理界面使用 React Native 原生组件重写。两者共用 RNW 0.84 / Fabric / Windows App SDK 宿主，界面与 Hermes bundle 随安装包交付。

后台复用现有 PC Agent TypeScript 核心，使用随包附带的 Node，通过本机 stdio RPC 连接原生宿主；DPAPI、托盘、窗口、文件对话框、图片压缩与系统操作由 C++ 原生层实现。网页和音频内容预览使用隔离 WebView2 窗口。Windows 安装 EXE 使用 NSIS，electron-builder 仅用于制作安装包，不包含 Electron 应用运行时。

旧的 `apps/control-desktop`、`apps/desktop` Electron 源码仍保留用于旧版维护与尚未迁移的 macOS 发布；不作为本次 Windows 原生交付。安装、构建和验收方式见 [Windows 原生项目](../apps/control-native/README.md)。

## 后续实现

会话、目录、模型设置、登录、连接状态和设备设置等应用界面在本机使用原生组件渲染，UI 代码随客户端安装包交付。服务器负责认证、API、WebSocket、状态与文件数据；桌面 UI 的更新随客户端版本交付，不能继续将刷新服务器网页作为原生桌面界面的升级方式。

控制端继续复用 `apps/mobile` 中的 React Native 组件及 `packages/client-shared` 的协议与业务逻辑，为 Windows/macOS 补齐平台适配。Web、iOS 和 Android 继续保留各自入口。预览用户网页等内容可以使用隔离 WebView，应用主界面不能依赖服务器 HTML。

PC 连接器复用现有 PC Agent 核心、协议和连接生命周期，以本机通信连接原生 UI 与后台运行时。后台可继续使用 TypeScript/Node，并随安装包提供所需运行时，最终用户无需自行安装 Node；不因更换 UI 改写已验证的任务控制语义。

## 迁移验收

- 本地原生界面可在服务器不可达时启动，展示地址、登录及连接失败状态；窗口不加载服务器首页作为应用主界面。
- 控制端保留会话/项目导航、历史与实时消息、底部跟随、顶部自动分页、队列编辑/引导、模型与强度、提问、文件和图片预览等功能。
- 两类桌面客户端保留托盘、默认关闭缩小到托盘、勾选关闭时退出及退出确认，并核对隐藏、恢复、重连和进程清理。
- PC 连接器保留登录/断开/重连、自动连接、登录项、设备设置、诊断及 Codex 运行时发现；迁移设置、设备身份和系统加密凭据，升级时避免生成重复设备。
- 分别完成 Windows/macOS 原生构建、安装包生成与目标系统实机验收，明确未完成的平台；类型检查、Web 导出或仅打包 Electron 不代表原生交付完成。

现有客户端操作见 [Windows 控制端](../apps/control-desktop/README.md)、[PC 连接器](pc-setup.md) 和 [macOS](mac.md)。
