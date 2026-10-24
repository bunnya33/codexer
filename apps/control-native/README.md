# 原生桌面与 PC Agent

Windows 既有 RelayDesk 控制端和 PC Agent 使用 React Native Windows。此次迁移范围是 **Codexer PC Agent**：把 Mac PC 连接器同步到 Windows Agent 的原生方案，两平台共用 `src/AgentApp.tsx`、`src/sidecar.ts`、控制器和桥接协议，并在 `main` 上维护。没有安装或发布 Mac RelayDesk 控制端。

PC Agent 产品版本统一来自本目录 `package.json`，本次为 `0.2.9`。Windows 使用 RNW 0.84 / Fabric；Mac 使用 React Native macOS 0.83 / Fabric，兼容依赖分别锁定。Mac 系统适配放在 `macos/`，共用业务和 UI 不复制到平台子项目。

Windows x64 与 Mac arm64 的 Agent 安装包已经由同一提交的 GitHub Actions 完整构建，实际验证和升级记录见 [验收记录](VALIDATION.md)。Mac 本机构建需要完整 Xcode，步骤见 [Mac 原生构建](../../docs/mac.md)。

## PC Agent 安装

Windows 使用 `Codexer-Native-Setup-0.2.9-x64.exe`；Mac 使用 `Codexer-Native-0.2.9-arm64.dmg` 或 `Codexer-Native-0.2.9-arm64-mac.zip`，将 `Codexer.app` 放进 Applications。Windows 最低 10 1809 x64，Mac 最低 macOS 14；附带 Node，不要求用户安装开发工具。此次 Mac 包为 ad-hoc 签名，未做 Developer ID 公证；未生成或验收 Intel Mac 包。

升级沿用原来的账号设置、设备标识、授权目录、自动连接和关闭行为。Windows 数据目录为 `%APPDATA%\Codexer`，Mac 为 `~/Library/Application Support/@codexer/desktop`。凭据使用 Windows DPAPI / Mac Keychain 加密迁移，旧会话失效或原本未登录时需要重新登录。

默认关闭窗口继续在托盘或菜单栏后台运行；菜单可打开、进入设置和退出。启用“关闭窗口时退出进程”后，退出需要确认。PC Agent 的连接、登录启动、目录授权和诊断使用同一份原生管理界面。

## PC Agent 构建

```sh
npm ci
# Windows
npm ci --prefix apps/control-native
npm run package:desktop:win
# Mac，需要完整 Xcode 和 Bundler
npm ci --prefix apps/control-native/macos
npm run package:desktop:mac
```

`npm run package:desktop` 按当前系统选择原生 Agent。Windows/macOS 在同一主线维护，不再为 Mac Agent 另建功能分支。旧 Electron Agent 仅保留 `:legacy` 后缀的回退构建入口。输出位于 `apps/control-native/release`，完整运行目录在 `stage`。实际测试边界见 [验收记录](VALIDATION.md)。

## 既有 Windows 控制端

以下为原有 Windows RelayDesk 的使用和验收入口，不属于此次 Mac PC Agent 替换范围。

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

本项目当前交付 Windows；macOS、iOS 和 Android 使用各自的宿主与发布流程，本次没有生成它们的安装包。
