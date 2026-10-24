# macOS 原生 PC Agent

此次范围是 **Codexer PC 连接器（PC Agent）**。Mac Agent 与 Windows Agent 在 `main` 中共用 `apps/control-native/src/AgentApp.tsx`、后台 sidecar、控制器与桥接协议；只把系统 API 放入 `macos/` / `windows/`。没有安装或发布 Mac RelayDesk 控制端。

产品版本来自 `apps/control-native/package.json`，本次为 `0.2.9`。Mac 使用 React Native macOS 0.83.0 / React Native 0.83.10，最低 macOS 14；Windows 保留兼容的 RNW 版本。完整原生构建在 GitHub macos-15 上完成，本机使用构建产物运行验收。此轮交付 arm64，未生成或验收 Intel Mac 安装包。

## 安装和构建

使用 `Codexer-Native-0.2.9-arm64.dmg` 或对应 ZIP，把 `Codexer.app` 放到 Applications。包内自带 Node 和 Agent，本机用户无需安装 Node、npm 或 Xcode。升级前退出旧 Codexer，保留原配置目录。

从源码构建需要完整 Xcode、Node 24、Ruby 3.2+ 和 Bundler。只安装 Command Line Tools 不够。

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
npm ci
npm ci --prefix apps/control-native/macos
cd apps/control-native/macos
bundle install
cd ../../..
npm run package:desktop:mac
```

命令会编译原生宿主、打包共用 Agent 界面和后台、附带 Node，并生成 DMG / ZIP / SHA-256。输出位于 `apps/control-native/release`，完整应用在 `apps/control-native/stage/Codexer-0.2.9-macos-arm64/Codexer.app`。

默认使用 ad-hoc 签名，按嵌套顺序签署 Hermes、Node、原生模块和应用。ad-hoc 宿主允许加载随包的无共同 Team ID 框架；Developer ID 构建保留库验证。当前安装包没有 Developer ID 公证。外部分发的签名及 notarization 见 [发布约定](release.md)。SVG 图标已适配 Mac Fabric 的 `drawRect` 绘制路径。

```sh
node scripts/build-native-macos.mjs --agent --prepare-only
npm run check:macos-native
node scripts/accept-native-macos.mjs
```

`--prepare-only` 不编译应用；启动验收脚本使用完整原生 Agent、合成配置，检查 bridge / sidecar、版本及重复实例退出。

## 设置、凭据和后台

Agent 沿用 `~/Library/Application Support/@codexer/desktop`，保留 `settings.json`、设备安装标识、授权目录、自动连接和登录启动设置。原生会话写入 `session.native.enc`，随机密钥保存于 Keychain，文件采用带完整性校验的加密封装。

首次启动兼容旧 `session.enc`。Electron v10 的旧 Safe Storage 项使用 npm 应用名 `@codexer/desktop`，兼容历史 `Codexer` 名称；只有成功解密才保存为原生格式。原本未登录、凭据被撤销或钥匙串访问被拒绝时，需要重新登录或授权。退出登录会清除旧、新会话，避免恢复已退出的账号。

默认关闭窗口继续在菜单栏后台运行，菜单提供打开、设置及退出。勾选“关闭窗口时退出进程”后显示退出确认。登录启动使用 SMAppService；系统要求批准后台项目时由用户在系统设置中允许。

隔离验收使用 `CODEXER_NATIVE_DATA_DIR`，不会修改正式配置或系统登录项。实际构建与本机升级记录见 [原生验收](../apps/control-native/VALIDATION.md)。旧 Electron Agent 回退入口是 `package:desktop:mac:legacy`，不作为后续原生版本交付。
