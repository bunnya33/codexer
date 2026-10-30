# 桌面架构与产品命名

2026-10-30 用户确认：优先将 **Codexer Agent** 连接器改用 Qt，降低桌面常驻内存；**Codexer Control** 暂不改动，保留 React Native 原生宿主。此决定取代 2026-10-24 连接器恢复 Electron 的技术约定。此次 Windows Qt 实际编译与交付，macOS Qt 源码需另行编译和实机验收，既有 Mac 发行版暂保留。

| 产品 | 用途 | 实现 | 代码与版本来源 | 图标 |
| --- | --- | --- | --- | --- |
| Codexer Agent | 在被控制电脑登录、连接 Relay、执行本机任务 | Qt Widgets + 本地 Node / PC Agent 核心 | `apps/agent-qt` / `apps/desktop/package.json` | 蓝色终端与绿色连接点 |
| Codexer Control | 远程选择设备、项目和会话并操作 Codex | React Native for Windows / React Native macOS | `apps/control-native` / `apps/control-native/package.json` | 紫色屏幕与青色对话框 |

两个产品都在 `main` 维护。Windows/macOS 复用各产品的业务代码与版本，只把系统 API 放入平台适配层。服务器继续使用 Go，服务器版本与桌面客户端独立。

## 构建入口

- `npm run build:qt-agent`：Qt 6.8.3 原生连接器编译与独立运行目录，`CODEXER_QT_ROOT` 指定 SDK。
- `npm run package:desktop:win`：Qt Agent，Windows x64 安装版与便携版。
- `npm run check:qt-agent`：隔离配置验证凭据迁移、身份、单实例与内存。
- `npm run package:desktop:electron:win`：历史 Electron Windows 回退包。
- `npm run package:desktop:mac`：Electron Agent，macOS arm64/x64；本机 ad-hoc 构建用 `npm run package:desktop:mac:local -- --arm64`。
- `npm run package:control-desktop:win`：原生 Control，Windows x64。
- `npm run package:control-desktop:mac`：原生 Control，当前 Mac 架构；完整构建需要 Xcode。

Qt Agent 输出到 `apps/agent-qt/release`，旧 Electron 输出到 `apps/desktop/release`，Control 输出到 `apps/control-native/release`。React Native 工程保留的 Agent 模式只属于历史迁移代码，不是交付入口。

Qt Agent 的 Widgets 原生界面、动态 Qt 库与独立 Node 后台随包交付，用户无需安装 Qt 或 Node，不附带 Chromium/Electron。复用已有控制器、协议、设备身份及任务逻辑，不使用 WebEngine 或 WebView 加载应用主界面。Control 的原生 UI 随安装包交付；服务器提供 API、实时状态与文件数据。构建与许可证见 [Qt Agent](../apps/agent-qt/README.md)。

## 改名与迁移

产品显示名改变，但应用 ID 保持 Agent `com.codexer.connector`、Control `com.codexer.control`。内部工程名、模块名、IPC 通道及历史钥匙串名称保留兼容，不要求与显示名相同。

Agent 在 macOS 沿用 `~/Library/Application Support/@codexer/desktop`，Windows 优先沿用 `%APPDATA%\Codexer`；若仅存在旧 Electron `%APPDATA%\@codexer\desktop` 则使用旧目录。保留 `settings.json`、installationId、授权目录、后台和自动连接设置。

Qt Agent 优先读取已有 `session.native.enc`，Windows 使用当前用户 DPAPI，macOS 沿用 `com.codexer.connector.NativeVault` 钥匙串身份。旧 Windows Electron `v10` 登录通过 `Local State` 中的 DPAPI 密钥解密后写入系统加密的 `session.native.enc`，保留旧加密源便于回退；失败保留源文件并提示重新登录。退出登录清除两种文件，避免恢复已退出的账号。迁移不会保存密码或输出凭据。

Control 继续使用既有数据目录、系统凭据库及原生桥接协议。两个程序各自具有单实例保护。替换客户端时退出旧产品进程，保留配置与应用备份，避免旧、新版本同时连接。

## 验证要求

分别记录实际编译、安装包和目标系统验收。Agent 需检查密码输入、按钮与回车提交、登录失败提示、设置/身份保留、凭据迁移、托盘和重复实例。内存对比说明进程范围和任务状态，不能把不同负载的采样差额当成固定节省量。Qt macOS 源码不代表实际编译或实机验收。Control 的改名需检查原生宿主、可执行文件、安装资源、窗口标题及不同图标，并明确未在目标系统实测的部分。

使用与构建见 [Agent](pc-setup.md)、[macOS](mac.md)、[Control 原生项目](../apps/control-native/README.md) 和 [发布](release.md)。历史原生迁移记录保留在 [验收记录](../apps/control-native/VALIDATION.md)，不代表当前 Agent 仍采用 Native。
