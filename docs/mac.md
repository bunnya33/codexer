# macOS 连接器

Electron 客户端同时配置 macOS arm64（Apple Silicon）和 x64（Intel），打包目标为 DMG/ZIP。用户无需安装 Node。本次开发机是 Windows，未生成或验证真实 Mac 安装包，不应把构建配置视为实机支持验收。

## 安装和运行

在 Mac 构建并签名发布后，打开 DMG，把 Codexer 拖到 Applications，启动后按 [PC 连接器](pc-setup.md) 使用账号登录。后台入口在菜单栏，关闭窗口默认保留本机服务。开机启动通过系统登录项配置，用户可在系统设置中管理。

macOS GUI 的 PATH 与终端不同。程序自动检查 `/Applications/Codex.app/Contents/Resources/codex`、用户 Applications、`/opt/homebrew/bin/codex`、`/usr/local/bin/codex` 和进程 PATH。官方安装结构如果变化，请在设置中手动选 Codex 可执行文件；数据目录默认 `~/.codex`。

会话由 Electron safeStorage 使用系统 Keychain 保护。密码不保存。凭据无法解密时重新登录，不回退为明文。首次运行可能出现系统 Keychain 权限提示，需要系统授权。

## 开发和发布

在 macOS 安装 Node 24，项目根目录执行：

```bash
npm ci
npm run typecheck
npm run package:desktop:mac
```

输出位于 `apps/desktop/release`。签名与 notarization 需要开发者自己的 Apple Developer 凭据，见 [发布文档](release.md)。Windows 无法完成 macOS 签名与真实平台测试。

## 实机验收清单

- Apple Silicon/Intel 上安装、首次启动、升级和卸载。
- Keychain 保存/恢复、退出账号清除、改密后失效。
- 菜单栏显示、关闭窗口、登录项、自动连接。
- 自动程序发现、手动程序路径、官方 Codex 登录和目录读取。
- 桌面 IPC 的 socket 路径与当前官方版本兼容性；现有适配路径为 `$CODEX_HOME/ipc/ipc.sock`，尚未实机确认。
- App Server 模式的任务发送、图片、审批、停止和队列。
- 正在运行任务时断开/退出登录后任务保留；重新连接恢复同步。
- 网络变化、休眠唤醒、会话到期与撤销。

如果桌面 IPC 无法接入但 App Server 可用，可选择“仅官方 App Server”；仍需验证同一会话 writer 的占用和释放行为，不能据此宣称桌面实时跟随已通过。
