# Windows 原生客户端

RelayDesk 控制端和 Codexer PC Agent 管理界面共用 React Native for Windows 0.84 原生宿主；应用界面随安装包交付，更新界面需要更新客户端。服务器继续提供 API 和实时数据。

## 安装与使用

控制端运行 `RelayDesk-Native-Setup-0.2.2-x64.exe`；PC Agent 可继续使用 `Codexer-Native-Setup-0.2.0-x64.exe`。0.2.2 在设置中新增默认、暖白纸张和暖棕暗色皮肤，选择立即生效并保存在本机，代码、文件差异和窗口标题栏一同换色；包含 0.2.1 的多行消息发送后底部跟随修复。支持 Windows 10 1809 及以上 x64；打包附带 Windows App Runtime 和 Node，无需安装开发工具。HTML/音频内容预览使用系统 Microsoft Edge WebView2 Runtime，主界面不依赖 WebView2。

升级前请从旧版托盘退出对应客户端，避免同一设备运行两套 Agent。安装程序支持选择目录；卸载默认保留账号配置。RelayDesk 与 Agent 分别使用 `%APPDATA%\CodexerControl`、`%APPDATA%\Codexer`，兼容旧版地址、设备身份、设置及可解密的登录凭据；原生凭据由 Windows DPAPI 加密。服务端已经撤销或过期的会话仍需重新登录。

默认关闭窗口缩小到托盘，双击托盘恢复。设置中可启用“关闭窗口时退出进程”；退出前弹框确认。托盘右键支持打开、设置与退出。PC Agent 的连接、自动连接、开机启动、授权目录和诊断均在原生设置内管理。

控制端保留项目/会话、模型与强度、队列编辑/引导、图片和文件、历史与实时状态。图片选择使用 Windows 文件对话框，未发送图片可点击预览；桌面不提供拍照入口。Enter 发送、Shift+Enter 换行。网页内容在独立隔离预览窗口打开。

## 构建

开发机安装 Node 24 x64、Visual Studio 2026 C++ 桌面工具（v145）、Windows SDK、NuGet。也可通过 `CODEXER_MSBUILD` 和 `CODEXER_PLATFORM_TOOLSET` 指定兼容工具链。

```powershell
npm ci
npm ci --prefix apps/control-native
node scripts/build-native-windows.mjs
```

输出在 `apps/control-native/release`；`stage/<产品名>-<版本号>` 是完整可运行目录。`--control` 只构建控制端，`--agent` 只构建 Agent，`--stage-only` 只生成运行目录，`--skip-build` 复用已有 Release。独立的 native 项目不进入根 workspace，以隔离移动端 RN 版本。

安装 EXE 使用 NSIS，electron-builder 仅负责压缩安装文件；运行目录没有 Electron/Chromium 应用运行时。不要单独复制小型宿主 EXE，必须保留同目录的运行库、Bundle、runtime 和 service。

```powershell
node apps/control-native/check-types.cjs
node scripts/build-native-sidecar.mjs
node --test apps/control-native/test/sidecar.test.cjs
npx vitest run tests/desktop-controller.test.ts tests/conversation-scroll.test.ts tests/mobile-relay.test.ts tests/mobile-relay-integration.test.ts
npx tsx scripts/accept-native-windows.ts
```

验收使用 `CODEXER_NATIVE_DATA_DIR` 指定独立测试目录；此模式不会写入 Windows 开机启动项。`CODEXER_NATIVE_MODE=control|agent` 可覆盖 EXE 名称识别。实际安装请保持 EXE 名称为 `RelayDesk.exe` / `Codexer.exe`。

隔离验收脚本会把完整运行目录复制到系统临时目录，使用本机模拟服务器与合成账号验证两套原生宿主启动、真实 DPAPI 凭据迁移、历史读取及 WebSocket。验收记录和当前限制见 [验收记录](VALIDATION.md)。

`npx tsx scripts/accept-native-windows.ts --control --keep` 仅打开隔离控制端并保留窗口，支持发送合成消息和分段回复，便于检查多行发送后的底部跟随。测试消息只发送到本机模拟服务。

本项目当前交付 Windows；macOS、iOS 和 Android 使用各自的宿主与发布流程，本次没有生成它们的安装包。
