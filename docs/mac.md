# macOS Codexer Agent / Codexer Control

2026-10-24 起，**Codexer Agent 恢复 Electron**；**Codexer Control 保留 React Native macOS 原生实现**。两者有不同图标与应用名，在同一 `main` 分支维护，详见 [桌面架构约定](desktop-native.md)。

## Codexer Agent

安装 `Codexer-Agent-<版本>-mac-arm64.dmg` 或 ZIP，将 `Codexer Agent.app` 放入 Applications。Intel Mac 使用 x64 包。包内提供 Electron/Node 和 Agent，用户无需安装 Node、npm 或 Xcode。替换旧 `Codexer.app` 前退出旧连接器，保留配置目录。

```sh
npm ci
npm run package:desktop:mac:local -- --arm64
```

开发构建需要 Node 24 和 Command Line Tools（编译原生凭据迁移小工具），不需要完整 Xcode。输出在 `apps/desktop/release`。正式双架构构建使用 `npm run package:desktop:mac`，签名、公证配置见 [发布约定](release.md)。本地 ad-hoc 包没有 Apple 公证。

Agent 沿用 `~/Library/Application Support/@codexer/desktop`，保留服务器、账号、installationId、Codex 路径、授权目录及启动偏好。历史 Electron Safe Storage 身份保持不变；原生 Agent 的 `session.native.enc` 使用原钥匙串密钥读取并转存为 Electron 加密的 `session.enc`。原加密文件只在成功转存后删除；钥匙串拒绝访问或服务器撤销会话时仍需授权或重新登录。

关闭窗口默认留在菜单栏后台。设置中的启动和退出偏好继续有效。隔离测试用 `CODEXER_USER_DATA_DIR`，不会写正式配置或登录项。

## Codexer Control

Control 使用原生 React Native macOS 宿主，最低 macOS 14。构建需要完整 Xcode、Node 24、Ruby 和 Bundler：

```sh
npm ci
npm ci --prefix apps/control-native/macos
cd apps/control-native/macos
bundle install
cd ../../..
npm run package:control-desktop:mac
```

输出在 `apps/control-native/release`，应用名为 `Codexer Control.app`，使用紫色对话图标。它的 bundle ID、配置和加密凭据身份保留。原生工程的 `RelayDeskNative` 只是内部工程名。当前电脑只有 Command Line Tools，完整原生编译由 GitHub Actions 完成；包生成与实机验收分别记录。
