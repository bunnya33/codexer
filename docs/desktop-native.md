# 桌面原生化约定

2026-10-19 用户确认：后续桌面客户端统一使用 Native 实现。覆盖 RelayDesk 会话控制端和 Codexer PC 连接器，Windows 使用 React Native for Windows，macOS 使用 React Native macOS。React Native、原生宿主和组件库的具体版本以可构建、可验收的兼容组合为准。

## 共用主线与版本

Windows 和 macOS 共用 `apps/control-native/src` 的应用入口、PC Agent 管理界面、控制端界面、桥接协议及 Node sidecar，在同一主线提交和同步功能。Windows 的 C++ 宿主放在 `windows/`，Mac Agent 的 AppKit / React Native macOS 宿主放在 `macos/`；只有系统功能使用平台适配，不能另建一套 Mac 业务界面或长期维护平台分支。

产品版本唯一来源是 `apps/control-native/package.json`，界面从宿主读取版本，sidecar 构建时注入同一版本，安装包也使用该版本。此次源版本为 `0.2.9`。Windows 使用 React Native Windows 0.84，Mac 使用当前支持 React Native 0.83.10 的 React Native macOS 0.83.0，依赖分别锁定，避免把不兼容的平台宿主塞进一个运行时。

## 此次 PC Agent 迁移范围

本次执行仅升级 Mac **Codexer PC 连接器（PC Agent）**，与 Windows Agent 共用原生方案及 `main`。RelayDesk 控制端不在本次 Mac 安装和发布范围；原有 Windows 控制端继续维护。

## 当前验收状态

Windows 已有 RNW 原生发行版。本次共用代码应同时通过 Windows/Mac 类型检查，并分别完成平台原生构建后才能发布新安装包。

Mac 新增 Fabric / TurboModule 宿主、钥匙串加密与旧 Electron v10 凭据迁移、菜单栏后台、关闭与退出、登录启动、文件选择、图片转换、系统剪贴板和隔离 WKWebView 内容预览。Agent 继续使用旧 Mac 配置目录 `~/Library/Application Support/@codexer/desktop`，保留安装标识和已有设置；新加密文件使用 `session.native.enc`，不把凭据降级为明文。

完整 Windows x64 / Mac arm64 原生编译与安装包使用同一提交的 GitHub Actions；Mac 构建产物在当前电脑完成本机运行检查。当前开发机只有 Command Line Tools，本机构建仍需要完整 Xcode。测试和实际安装范围记录在 `apps/control-native/VALIDATION.md`。

默认 macOS 打包入口已改为原生构建，旧 Electron 打包仅保留 `:legacy` 后缀入口用于回退维护。替换时保留旧应用备份及原有配置，实际升级记录见验收文档。

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
