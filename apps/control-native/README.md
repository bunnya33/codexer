# Codexer Control 原生桌面端

Windows / macOS 的会话控制客户端统一名为 **Codexer Control**，使用紫色屏幕与青色对话图标。Windows 使用 React Native for Windows，Mac 使用 React Native macOS，两平台共用 `src`、`apps/mobile` 的业务界面与同一 `main`。`RelayDesk` / `RelayDeskNative` 保留为内部工程和模块名，不是产品显示名。

2026-10-24 用户决定：PC 连接器 **Codexer Agent 恢复 Electron**，默认构建入口改回 `apps/desktop`。本目录不再生成 Native Agent；保留的 Agent 源码只作为历史迁移代码。两类产品的明确分工见 [桌面架构](../../docs/desktop-native.md)。

Control 产品版本来自本目录 `package.json`，平台 React Native 依赖使用各自 lockfile，不能强行统一不兼容的 RN 版本。安装包内附 Node、sidecar 和本地原生 UI，主界面不依赖服务器网页。网页/HTML/音频预览使用隔离系统 WebView。

## 构建

Windows 需要 Node 24、Visual Studio C++ 桌面工具、Windows SDK 和 NuGet：

```powershell
npm ci
npm ci --prefix apps/control-native
npm run package:control-desktop:win
```

Mac 需要 Node 24、完整 Xcode、Ruby 和 Bundler：

```sh
npm ci
npm ci --prefix apps/control-native/macos
cd apps/control-native/macos
bundle install
cd ../../..
npm run package:control-desktop:mac
```

输出在 `release`，完整目录在 `stage/Codexer Control-<版本>`（Windows）或 `stage/Codexer Control-<版本>-macos-<架构>`。可执行文件叫 `Codexer Control.exe` / `Codexer Control.app`。不要单独复制宿主 EXE，必须保留完整运行库、Bundle、runtime 和 service。

`--stage-only` 只生成运行目录，`--skip-build` 复用相同版本的已有编译结果；`--agent` 会提示使用 Electron Agent 打包命令。安装器仍使用 electron-builder / NSIS，但 Control 不包含 Electron/Chromium 主界面运行时。

## 设置与验证

Control 保留应用 ID `com.codexer.control`，Windows 使用 `%APPDATA%\CodexerControl`，Mac 使用 `~/Library/Application Support/@codexer/control-desktop`。退出、菜单、凭据和配置延用原有逻辑；改名不迁移到新的空目录。默认关闭缩小到托盘/菜单栏，退出前确认。

```sh
node apps/control-native/check-types.cjs
node apps/control-native/check-types.cjs --macos
node scripts/build-native-sidecar.mjs
node --test apps/control-native/test/sidecar.test.cjs
node scripts/accept-native-macos.mjs
```

Windows 原生验收使用 `npx tsx scripts/accept-native-windows.ts --control`，`--fresh-login --keep` 可打开合成账号登录页面进行实际操作。测试使用 `CODEXER_NATIVE_DATA_DIR` 独立目录，不写正式配置、凭据或启动项。实际编译、包和实机边界见 [验收记录](VALIDATION.md)。Mac 安装与构建见 [macOS](../../docs/mac.md)。
