# macOS 原生客户端

Windows 与 macOS 在同一主线维护 `apps/control-native`，共用 React Native 界面、设置与会话业务、桥接协议及 PC Agent 核心。产品版本来自 `apps/control-native/package.json`，本次源版本为 `0.2.9`。Mac 使用 React Native macOS 0.83.0 / React Native 0.83.10 / React 19.2.3，最低 macOS 14；Windows 保留其兼容的 RNW 版本，平台依赖各自锁定。

## 当前状态

Mac 已接入共用原生项目及 AppKit 系统适配。本机目前只有 Command Line Tools，没有完整 Xcode，尚未完成整个应用编译、DMG/ZIP 生成和原生应用实机验收。当前安装的 PC Agent `0.1.16` 仍是可运行的旧 Electron 维护版。不能用 Metro、Codegen、类型检查或 AppKit 文件编译检查代替原生应用交付。

## 构建原生安装包

需要完整 Xcode（包括 macOS SDK 与首次启动组件）、Node 24、Ruby 3.2 或更新及 Bundler。只安装 `xcode-select --install` 提供的命令行工具不足以构建 React Native macOS。

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
npm ci
npm ci --prefix apps/control-native/macos
cd apps/control-native/macos
bundle install
cd ../../..
npm run package:macos-native
```

命令会安装 CocoaPods 依赖、编译原生宿主、打包共用 JS/Agent、附带当前架构的 Node 运行时，并制作 DMG、ZIP、SHA-256 与构建信息。默认同时生成 Codexer PC Agent 和 RelayDesk 控制端：

```sh
npm run package:desktop:mac
npm run package:control-desktop:mac
```

输出位于 `apps/control-native/release`，完整运行目录在 `apps/control-native/stage`。安装包版本与 Windows 使用同一个源版本；不得仅改文件名冒充同步版本。默认使用本机 ad-hoc 签名；外部分发需要设置 `CODEXER_MAC_SIGN_IDENTITY` 为自己的 Developer ID，并按 [发布约定](release.md) 完成 notarization。无签名/公证记录时不能声称已经公证。

仅准备共用 UI、Codegen 和 Agent（不编译 AppKit 应用）可运行：

```sh
node scripts/build-native-macos.mjs --agent --prepare-only
node apps/control-native/check-types.cjs --macos
npm run check:macos-native
CODEXER_NATIVE_SERVICE="$PWD/apps/control-native/macos/build/service/sidecar.cjs" node --test apps/control-native/test/sidecar.test.cjs
```

最后一组只检查 JavaScript、桥接定义、系统适配编译及加密协议，不生成可安装的原生应用。完整 Xcode 构建成功后还需实际启动原生应用验证登录、连接、托盘、权限、文件与预览，再替换 Applications 中的旧程序。

## 配置和凭据

Agent 沿用 `~/Library/Application Support/@codexer/desktop`，保留旧 `settings.json`、设备安装标识、授权目录、自动连接与登录启动设置；控制端使用 `~/Library/Application Support/@codexer/control-desktop`。原生凭据写入 `session.native.enc` / `control-session.native.enc`，密钥保存于系统 Keychain，使用带完整性校验的版本化加密封装。

Agent 首次启动会尝试读取旧 `session.enc`。Electron macOS v10 凭据使用旧应用的 Safe Storage 钥匙串项解密；成功后才写入原生加密文件，不能通过创建新设备或明文保存来绕过迁移。钥匙串被拒绝、旧会话失效或原本未登录时，需要用户授权钥匙串或重新登录。退出登录会清除旧/新会话，避免下次从旧文件恢复已退出的账号。

默认关闭窗口继续在菜单栏运行，菜单提供打开、设置与退出；启用“关闭窗口时退出进程”后显示退出确认。登录启动使用系统 SMAppService；系统要求批准后台项目时应由用户在系统设置中允许。内容预览使用隔离 WKWebView，应用主界面由 React Native / AppKit 原生渲染。

隔离验收可设置 `CODEXER_NATIVE_DATA_DIR`，可选 `CODEXER_NATIVE_MODE=agent|control`。指定测试目录时不会修改系统登录启动项。测试不得读取真实登录凭据或把测试会话写入真实配置目录。

旧 Electron 构建仅保留明确的回退入口 `npm run package:desktop:mac:legacy` / `npm run package:desktop:mac:local:legacy`，不作为后续原生交付。
