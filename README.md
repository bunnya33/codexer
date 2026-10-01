# Codexer

从手机或浏览器控制自己电脑上的 Codex。控制端和 PC 使用同一账号登录，由 Relay 转发命令、同步状态；PC 无需开放公网入站端口。

## 四个模块，三个交付物

| 模块 | 技术 | 职责与交付 |
| --- | --- | --- |
| 控制客户端 | React Native + Expo + TypeScript | iOS、Android、Web 共用 UI 和远程控制逻辑；源代码在 `apps/mobile` |
| PC 连接器 | Electron + React + TypeScript | Windows/macOS 完整控制台，内置 Node 和 PC Agent；安装包或便携版 |
| 管理后台 | React + Vite + TypeScript | 独立的 `/admin/` 页面，创建账号、重置密码、禁用账号 |
| Relay | Node + Fastify + WebSocket | 登录认证、账号隔离、设备状态、命令与历史转发；PGlite 或 PostgreSQL |

服务端交付物同时包含 **Relay、Web 控制端、管理后台**，一次安装、一个服务、一个访问端口。移动 App 单独安装，PC 连接器单独安装。

## 开始使用

1. 服务器安装统一服务包，见 [服务器一键安装](docs/server-install.md)。首次安装会生成管理员账号。
2. 管理员进入服务器地址的 `/admin/`，创建普通账号，见 [管理后台](docs/admin.md)。
3. PC 安装 Codexer，填写服务器地址和账号密码，登录并连接。**用户不需要安装 Node/npm**；本机仍需安装并登录官方 Codex，见 [PC 安装与连接](docs/pc-setup.md)。
4. 在服务器首页或移动 App 用同一账号登录，选择电脑、项目和会话，见 [控制功能](docs/usage.md)。

PC 控制台提供连接、断开、重连、退出账号、设备配置、诊断、托盘、开机启动和自动连接。“断开”暂停重连及新远程指令，保留已经开始的本机任务；退出整个程序会停止连接器管理的 App Server。

Linux/systemd 服务器从当前源码安装：

```bash
curl -fsSL https://raw.githubusercontent.com/bunnya33/codexer/main/bootstrap.sh | sudo env CODEXER_REPO_URL=https://github.com/bunnya33/codexer.git CODEXER_REF=main bash
```

安装器交互询问服务器访问地址，具体要求及发布包安装方式见 [服务器一键安装](docs/server-install.md)。

## 文档入口

完整目录见 [文档索引](docs/README.md)，整体结构见 [架构与功能分工](docs/architecture.md)。开发、打包、迁移到新仓库分别见 [开发文档](docs/development.md)、[本地发布](docs/release.md)、[新仓库导出](docs/new-repository.md)。

## 当前交付范围

Windows x64 提供安装包与便携版；macOS 提供 arm64/x64 的 DMG/ZIP 打包配置，需要在 Mac 上构建、签名及实机验收。移动端原生 JS 导出不等同于 APK/IPA。Linux/systemd 与 Docker 安装流程提供脚本、配置和本地检查，实际部署应按验收步骤确认。详细结果见 [验证范围](docs/validation.md)。

所有部署示例、测试使用虚构域名或保留示例 IP；不预置真实服务器地址、账号或密码。源码仓库为 [bunnya33/codexer](https://github.com/bunnya33/codexer)，从当前整理后的内容创建初始版本。安装包与服务器发布包单独分发，旧 Git 历史和本地运行数据不属于源码交付。
