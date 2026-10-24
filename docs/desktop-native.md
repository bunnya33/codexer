# 桌面架构与产品命名

2026-10-24 用户确认：PC Agent 恢复 Electron，命名为 **Codexer Agent**；PC 控制端统一命名为 **Codexer Control**。这个决定适用于 Windows 和 macOS，取代 2026-10-19 将 Agent 与控制端全部迁为 Native 的约定。

| 产品 | 用途 | 实现 | 代码与版本来源 | 图标 |
| --- | --- | --- | --- | --- |
| Codexer Agent | 在被控制电脑登录、连接 Relay、执行本机任务 | Electron + 本地 React 管理界面 + PC Agent | `apps/desktop` / `apps/desktop/package.json` | 蓝色终端与绿色连接点 |
| Codexer Control | 远程选择设备、项目和会话并操作 Codex | React Native for Windows / React Native macOS | `apps/control-native` / `apps/control-native/package.json` | 紫色屏幕与青色对话框 |

两个产品都在 `main` 维护。Windows/macOS 复用各产品的业务代码与版本，只把系统 API 放入平台适配层。服务器继续使用 Go，服务器版本与桌面客户端独立。

## 构建入口

- `npm run package:desktop:win`：Electron Agent，Windows x64。
- `npm run package:desktop:mac`：Electron Agent，macOS arm64/x64；本机 ad-hoc 构建用 `npm run package:desktop:mac:local -- --arm64`。
- `npm run package:control-desktop:win`：原生 Control，Windows x64。
- `npm run package:control-desktop:mac`：原生 Control，当前 Mac 架构；完整构建需要 Xcode。

Agent 输出到 `apps/desktop/release`，Control 输出到 `apps/control-native/release`。原生构建脚本拒绝 `--agent`，防止以后再次把 PC 连接器切回 Native。原生工程保留的 Agent 模式只属于历史迁移代码，不是交付入口。

Agent 的 Electron UI、preload、主进程和后台 worker 随包交付，用户无需安装 Node。Control 的原生 UI 同样随安装包交付；服务器提供 API、实时状态与文件数据。`apps/control-desktop` 的 Electron 控制壳保留历史维护用途，不能代替新版原生 Control。

## 改名与迁移

产品显示名改变，但应用 ID 保持 Agent `com.codexer.connector`、Control `com.codexer.control`。内部工程名、模块名、IPC 通道及历史钥匙串名称保留兼容，不要求与显示名相同。

Agent 在 macOS 沿用 `~/Library/Application Support/@codexer/desktop`，Windows 优先沿用 `%APPDATA%\Codexer`；若仅存在旧 Electron `%APPDATA%\@codexer\desktop` 则使用旧目录。保留 `settings.json`、installationId、授权目录、后台和自动连接设置。

Electron Agent 保留历史 Safe Storage 应用身份。若发现原生 `session.native.enc`，使用原来的 macOS Keychain 密钥或 Windows 当前用户 DPAPI 解密，成功写入 Electron 系统加密的 `session.enc` 后再移除原生文件；失败时保留文件并提示重新登录。退出登录清除两种文件，避免恢复已退出的账号。迁移不会保存密码或输出凭据。

Control 继续使用既有数据目录、系统凭据库及原生桥接协议。两个程序各自具有单实例保护。替换客户端时退出旧产品进程，保留配置与应用备份，避免旧、新版本同时连接。

## 验证要求

分别记录实际编译、安装包和目标系统验收。Agent 需检查密码输入、按钮与回车提交、登录失败提示、设置/身份保留、凭据迁移、托盘和重复实例。Control 的改名需检查原生宿主、可执行文件、安装资源、窗口标题及不同图标，并明确未在目标系统实测的部分。

使用与构建见 [Agent](pc-setup.md)、[macOS](mac.md)、[Control 原生项目](../apps/control-native/README.md) 和 [发布](release.md)。历史原生迁移记录保留在 [验收记录](../apps/control-native/VALIDATION.md)，不代表当前 Agent 仍采用 Native。
