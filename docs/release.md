# 本地发布与打包

打包只生成本地文件。Electron 命令固定 `--publish never`，不会自动上传到 GitHub，也没有内置更新服务器。

## Windows

在 Windows 开发机执行：

```powershell
npm ci
npm run typecheck
npm test
npm run package:desktop:win
```

输出 `apps/desktop/release/Codexer Setup 0.1.4.exe`（NSIS）和 `Codexer 0.1.4.exe`（便携），以及 `win-unpacked` 验收目录。包内是 Electron 的 Node/SQLite、Agent bundle 和 React UI，不要求最终用户安装 Node。两个包未配置发行签名；当前 `signExecutable:false` 保留图标/元数据但跳过应用签名。商业发行需维护者自行配置可信 Windows 签名证书/服务并调整该选项，不能把工具出现 signing 日志当作已签名。

Electron 二进制下载失败时先检查网络、代理和 DNS，不关闭 TLS 校验。可以使用官方校验和验证后将官方解压目录交给 electron-builder 的 `electronDist`；这个选项只用于打包，最终用户仍无需 Node。

## macOS

在 Mac 执行 `npm ci` 后 `npm run package:desktop:mac`，输出 arm64/x64 DMG 和 ZIP。配置开启 hardenedRuntime 和必要 JIT entitlement。签名需要 `CSC_LINK`/`CSC_KEY_PASSWORD` 等维护者提供的开发者证书；notarization 使用 electron-builder 支持的 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 或其支持的 API key 配置。私密值只通过本地环境/CI secrets 注入。

未提供凭据时得到开发测试包，不能声称通过 Gatekeeper/notarization。真正发行前分别验证两种架构、登录项、Keychain、官方运行时和休眠重连，见 [macOS](mac.md)。本次不跨平台伪造 Mac 验收。

## 统一服务器包

```bash
npm run build:server
npm run package:server
```

输出 `release/codexer-server-0.1.0.tar.gz` 和 `.sha256`，包含 Relay 编译产物、控制端/后台静态文件、锁定依赖清单、安装器和文档。不含 node_modules、真实配置、旧 Git 历史或 Electron 二进制。服务器安装时自动装 Node/生产依赖，看到 bundle 标记后直接使用已构建网页。

同一个包同时升级 Admin 和 Relay，避免接口与 UI 不一致。安装、校验、回退见 [服务器安装](server-install.md)。源码的 Dockerfile 独立执行完整服务器构建，也跳过 Electron 下载。

## 移动 App

Web 随统一服务包发布。iOS/Android 由 Expo/EAS 或原生工具构建和签名，见 [移动客户端](mobile.md)。JS export 是构建检查，不代替可安装文件或商店审核。

## 版本与升级

PC 连接器与服务端可独立升级版本；同步对应 package 和锁文件的 workspace 版本，移动 App 发布时同步移动配置版本；先运行类型、行为、文档与平台检查，记录 [验证范围](validation.md)。Windows 安装新版替换程序，应用数据保留；便携版使用固定路径替换。Mac 替换 Applications 中的应用。当前没有自动下载更新功能。

`0.1.4` 支持点击选项即发、异步消息按题回答、自定义文字手动提交及气泡内浅色问题/深色答案。需要同时更新 PC 连接器及服务器 Web 资源，旧 Agent 不支持按题回传或结构化展示字段；单独刷新浏览器不能解决。服务器升级按 [安装文档](server-install.md) 操作。

源码使用 `https://github.com/bunnya33/codexer` 的 `main` 分支。安装包与服务器包仍在本地；将这些文件上传到 Release 是独立发布步骤，构建命令不会自动执行上传。
