# Windows / macOS 共用原生客户端

RelayDesk 控制端和 Codexer PC Agent 共用 `src/App.tsx`、`src/AgentApp.tsx`、`src/sidecar.ts` 与平台桥接协议，Windows/macOS 在同一主线同步功能。Windows 使用 RNW 0.84 / Fabric，macOS 使用 React Native macOS 0.83 / Fabric；两端产品版本统一来自本目录 `package.json`，本次源码版本为 `0.2.9`。

macOS 的依赖单独锁定在 `macos/package-lock.json`，共享业务和 UI 不复制到 Mac 子项目。平台组件版本不同源于各平台宿主的兼容要求。界面随客户端交付，服务器提供 API 和实时数据。

**本次 Mac 状态：** 共用界面类型检查、Metro 生产打包、TurboModule Codegen、AppKit 适配编译检查与凭据封装测试可独立完成；完整应用、DMG 和实机验收还需要完整 Xcode。这台开发机目前只有 Command Line Tools，不能把源码接入标记为已交付原生安装包。构建方式见 [Mac 原生构建](../../docs/mac.md)。

## 安装与使用

控制端运行 `RelayDesk-Native-Setup-0.2.4-x64.exe`；PC Agent 本次打包为 `Codexer-Native-Setup-0.2.7-x64.exe`，基于服务器 v0.3.20 对应源码重新构建，保留压缩会话读取、远程权限设置、Browser / Computer Use 授权以及具体登录错误与失败诊断。本次为打包更新，不新增 Agent 连接功能；分享有效期与安装包分发由服务器处理。远程权限功能需配合服务器 0.3.17 或更新版本及相应控制端使用。本次只交付 Agent 安装包。

RelayDesk 0.2.4 修复首次账号密码登录时报 `undefined is not a function`，同时修复附件取消和音频释放中的同类超时兼容问题。保留长消息底部跟随及三套皮肤。支持 Windows 10 1809 及以上 x64；打包附带 Windows App Runtime 和 Node，无需安装开发工具。HTML/音频内容预览使用系统 Microsoft Edge WebView2 Runtime，主界面不依赖 WebView2。

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

增加 `--fresh-login` 时不预置会话，需从真实登录表单输入合成账号 `native-fixture`、密码 `native-fixture-password-12345`。脚本验证密码登录请求、加密保存凭据、历史及实时同步，不能用迁移已有登录状态的检查代替首次登录。

Windows 的既有安装包与本次 `0.2.9` 源码要分别记录。macOS 完整编译与运行验收通过后才能替换本机旧 Electron 应用；iOS/Android 继续使用移动端宿主。
