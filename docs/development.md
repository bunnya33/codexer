# 开发文档

## 环境与边界

开发机使用 Node 24、npm 和 Git。`npm ci` 按根 lockfile 安装 Expo、React、Electron、Fastify 和测试工具。普通 PC 用户使用成品安装包，不需要这些开发环境。官方 Codex 是本机执行前提，不由本项目重新分发。

目录和模块边界见 [架构](architecture.md)。协议变更先改 `packages/protocol`，再同步 Relay、Agent 和 React Native 客户端。Electron 的 React 窗口只通过 `DesktopApi` 操作；不要把 bearer session、密码、Node API 或任意文件读写暴露给窗口。

## 日常命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev:relay` | 开发 Relay |
| `npm run local:start` / `local:stop` / `local:status` | 本机 Relay/Agent 开发服务管理 |
| `npm run dev:agent -- login --username <account>` | 开发 Agent 的账号登录；密码由标准输入提供 |
| `npm run dev:web` | React Native Web 开发 |
| `npm run mobile:start` | Expo 原生开发 |
| `npm run dev:admin` | 独立 React 后台，5174，代理本机 Relay |
| `npm run dev:desktop` | 构建并启动 Electron 控制台 |
| `npm run build:server` | 按 `tsconfig.server.json` 编译 Relay/安装运维脚本、导出控制端 Web、构建 Admin |
| `npm run build:desktop` | 打包主进程/preload/Agent 并构建 React 控制台 |
| `npm run package:server` | 已完成 server build 后生成统一服务器发布包 |
| `npm run package:desktop:win` / `package:desktop:mac` | 对应平台的安装包 |
| `npm run users -- list` | 开发环境账号管理；其他子命令见脚本提示 |

服务器开发首次生成的管理员配置在本地 `.local/relay-admin-account.secret`，生产通过受限环境配置或安装器生成。使用新的普通测试账号，禁止把自己的真实部署地址和凭据写进源码或测试。

Electron 使用 esbuild 将 PC Agent 的 JS 依赖全部打进 `worker.cjs`，使用 utilityProcess 和 Electron 内置 Node/SQLite，不运行外部系统 Node。Vite 渲染器产物、PNG 托盘图标和 preload 一起进入 asar。图标可通过 `node scripts/generate-desktop-icons.mjs` 重生成。

隔离验收可通过 `CODEXER_USER_DATA_DIR` 使用专用临时配置目录，并跳过真实系统登录项修改；`CODEX_REMOTE_DESKTOP_ENDPOINT` 与 `CODEX_THREAD_ID` 指向测试 IPC/合成会话。正式使用留空这些开发变量，不用真实任务做自动控制测试。

## 变更检查

```bash
npm run typecheck
npm run mobile:typecheck
npm test
npm run check:docs
npm run build:server
npm run build:desktop
```

涉及移动端原生适配时再运行 `npm run mobile:export`；涉及 Electron 系统功能时，在对应平台验证并打包。测试使用本地临时 Relay、合成账号和 FakeDesktop，避免连接真实用户服务/执行会话。

`desktop-controller` 测试账号凭据不进入 UI、登录取消、断开任务保留、撤销会话、HTTP 与存储约束；`agent-disconnect` 验证真实本地 socket/Relay 下的暂停和恢复；`admin-client` 与 Relay 静态路由测试验证后台入口/资源与控制端隔离。

## 修改注意事项

断开不得调用 `PcAgent.stop()`；stop 会停止本地适配器和 App Server。远程回调需要检查当前 socket，排队操作在执行前再次检查，任务已开始后允许继续。运行配置/账号切换需检查任务状态。

Agent 开发 CLI 统一为 `npm run dev:agent`，动作包括 `login`、`check-login`、`run`、`status`。`login` 从标准输入读取密码，不把密码放进命令参数；密码不会写入设备凭据。普通 PC 用户使用 Electron。旧 Windows/macOS 源码启动器和重复配对脚本已删除，详见 [清理说明](cleanup.md)。

`inspect:bundle`、`probe:desktop`、`check:live` 与 `check:control/model-usage/effort-images/stop/approval/input` 用于官方运行时兼容调查与人工验收，不随服务器编译产物发布。这些工具可能操作指定的官方会话，只对明确准备的测试任务运行；自动测试不调用它们。`scripts/create-image-fixture.ps1` 为图片验收生成本地测试图，保留供 Windows 维护者使用。

`check:live` 默认报告在 `.local/diagnostics/live-evidence.json`，`probe:desktop` 默认在 `.local/desktop-ipc-probe.json`；不要用 `--report` 将真实环境数据写进源码目录。发布使用 [发布文档](release.md)；新仓库使用 [安全导出](new-repository.md)，不要携带旧 `.git`。
