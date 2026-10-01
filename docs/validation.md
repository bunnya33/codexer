# 验证范围

本次开发环境：Windows x64，Node 24，Electron 44.5.1。仅使用本地临时 Relay、合成账号和 FakeDesktop 做自动测试，未修改真实服务器，也未执行 GitHub 上传。

## 已验证的行为

- 分离的 `/` 和 `/admin/` HTML/资源，不遮蔽 API，后台无设备请求/控制 WebSocket。
- 账号密码、设备归属、跨账号权限、改密/禁用/注销、会话失效。
- PC 控制器的安全存储约束、会话不进入 UI、取消登录、HTTP 显式选择。
- 断开关闭远程通道、停止重连与新指令、暂停队列，同时保留本机适配器和活动任务；明确连接后恢复队列与相同 epoch。
- Electron utilityProcess 的内置 Node 24.21.0 可运行 `node:sqlite`，Agent 无需系统 Node。
- 现有消息、历史、图片、模型、用量、命令幂等等行为测试。

## 构建与界面检查

本地检查已通过：根/React Admin/Electron/React Native 类型检查，完整行为测试（新增登录写入取消测试后合计 160 项），Web/Admin/Electron 构建，iOS/Android JS 导出，26 份文档的链接/索引/示例 IPv4 检查，Git Bash 的安装脚本语法检查与 Compose 配置解析。

Windows x64 已生成 NSIS 安装包和便携版。Electron 实际窗口使用隔离配置验证登录、设置/重启恢复、诊断和窄窗布局；真实 utilityProcess + 本地 Relay + FakeDesktop 验证账号登录、DPAPI 加密文件、连接/断开/重连/退出账号以及任务保留。React Admin 浏览器验收覆盖普通用户拒绝、创建账号、重置密码、禁用、刷新恢复、退出、390px 布局和不请求设备/控制 socket。

`win-unpacked/Codexer.exe` 在只含 Windows System32 的 PATH 下完成同一连接验收，确认运行不依赖系统 Node。统一服务器包在独立目录仅安装 186 个生产依赖后，通过 Relay 初次建库/管理员初始化、两个网页入口、认证与验收会话注销；未安装 Electron/Expo。源码导出清单及示例地址检查通过，不包含 `.git`、`.local`、真实配置或历史 JSON 数据。

自定义标题栏的 Windows 窗口验收通过：46px 固定标题区域、拖动/按钮非拖动区域、最小化、最大化/还原状态同步、关闭后进入托盘和重新显示。窗口不显示默认 Windows 标题栏。

目录清理后复核账号登录 CLI、安装器配置参数和独立服务器编译范围；旧配对入口、源码启动器、历史 JSON 和移动端后台样式已清除。服务器编译产物只包含 Relay 及安装/运维脚本的依赖，不包含测试、Electron、PC Agent 或开发验收程序，详见 [清理说明](cleanup.md)。

生产 Web 登录页已移除服务器地址输入，自动使用当前站点。浏览器验收覆盖仅账号/密码字段、错误密码后重试、同源 REST/WebSocket、刷新恢复登录、清除旧版本保存的其他服务器会话及 390px 布局；React Native 类型检查和 Web 构建通过。移动 App 仍保留地址配置。

## 平台与生产验收

| 范围 | 本次界限/还需检查 |
| --- | --- |
| Windows | 本地打包和窗口验证；发行签名、全新机器安装/卸载、系统登录项注册与实际官方 Codex 版本任务验收；隔离测试跳过真实登录项修改 |
| macOS | 配置 arm64/x64 打包，Windows 无法做 Mac 签名、Keychain、登录项和 IPC 实机验收 |
| Android/iOS | 类型和 JS 导出；真实 APK/IPA、设备手势、后台联网、系统权限和商店发行未验收 |
| Linux systemd | 安装脚本、配置、资源与本地验证；需要实际 Linux systemd 首装/更新/回滚验收 |
| Docker/HTTPS | Dockerfile/Compose/Caddy 配置；需要具备 Docker 的环境及真实域名证书验收 |

生产部署按顺序验证：健康接口、两个网页入口、管理员登录及创建普通账号、PC 同账号登录、设备在线、一次明确授权的测试任务、断开期间任务持续、重连恢复、改密失效、备份恢复。

历史 [可行性研究](feasibility.md) 的 Windows 官方运行验证针对当时版本，不等同于本次跨平台客户端的全量验收。
