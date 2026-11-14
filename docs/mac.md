# macOS Codexer Agent / Codexer Control

2026-10-30 起，**Codexer Agent 优先使用 Qt Widgets 与同进程 C++ 后台**；**Codexer Control 保留 React Native macOS 原生实现**。两者有不同图标与应用名，在同一 `main` 分支维护，详见 [桌面架构约定](desktop-native.md)。

## Codexer Agent

### Qt macOS arm64

2026-11-13 在本机完成 Qt Agent 0.2.36 的实际原生编译、DMG/ZIP 打包和 Applications 替换验收。安装包为 `apps/agent-qt/release/Codexer-Agent-Qt-0.2.36-mac-arm64.dmg`，包内不包含 Electron、Node 或 JavaScript 运行时。本地使用 ad-hoc 签名，未做 Apple 公证；结果与限制见 [验证记录](validation.md)。

同日已进一步构建并安装 Qt Agent 0.2.38，包为 `apps/agent-qt/release/Codexer-Agent-Qt-0.2.38-mac-arm64.dmg` 和同名 ZIP。后台、界面、协议回归及安装后原身份／登录／设置保留、Relay／桌面／运行时连接核对通过；旧程序和配置保存在 `.local/agent-upgrades/20261113-qt-0.2.38`。仍为本机 arm64 ad-hoc 包，未公证或验证 Intel。

2026-11-14 再次 fetch 核对最新 `main`（`2ce9a57`），Agent 版本仍为 0.2.38；已重新原生编译、打包并替换本机程序。后台 123 项、界面 18 项及协议 338 例通过，DMG／ZIP 与签名 stage 一致。已在原生窗口确认原账号及连接状态，原登录、设备身份和全部设置保持；旧程序、配置、原同名安装包和本轮回执保存在 `.local/agent-upgrades/20261114-qt-0.2.38`。本轮未修改文件传输速度策略，也未发布远程更新。

构建需要 Node 24、Qt 6.8.3 的 qtbase/qtwebsockets、CMake 和 Command Line Tools。`CODEXER_QT_ROOT` 指向 SDK，`CODEXER_CMAKE` 可指定 CMake，`npm run build:qt-agent` 生成带 Qt 库和插件的 `apps/agent-qt/stage/Codexer Agent.app`。本机验证使用 CMake 3.31.10 与 macOS 15.4 SDK；可用 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk` 指定该 SDK，避免新版 SDK 缺少 Qt 6.8.3 所需的 AGL 链接文件。

Qt 同时自动查找独立 `Codex.app` 和 `ChatGPT.app` 内的 Codex CLI。沿用原配置和安装身份，兼容旧 Electron `session.enc` 及原生 `session.native.enc`；首次钥匙串授权需在系统窗口完成。退出登录清除两种登录文件。替换前退出旧进程，保留程序与配置备份。

2026-11-14 下载性能修复进一步将 Qt Agent 升至 `0.2.39`：文件只读请求独立调度，不再等待后台维护队列。arm64 原生编译、回归、DMG／ZIP 与正式应用替换已完成；用户完成首次钥匙串授权后，原生窗口确认原账号和连接，状态文件确认原设备身份、全部设置及 Relay／桌面／运行时连接保持。新版 Relay 链路的同一份 IPA 已三次下载完成；其中最后一次完成区间为 3.30–4.71 秒，只代表 Mac 浏览器。备份及安装回执在 `.local/agent-upgrades/20261114-qt-0.2.39`，最新完整连接验收记录已更新为 `0.2.39`。基准条件及配套 Relay 版本见 [文件下载性能](file-download-performance.md)。

### 历史 Electron 构建入口

安装 `Codexer-Agent-<版本>-mac-arm64.dmg` 或 ZIP，将 `Codexer Agent.app` 放入 Applications。Intel Mac 使用 x64 包。包内提供 Electron/Node 和 Agent，用户无需安装 Node、npm 或 Xcode。替换旧 `Codexer.app` 前退出旧连接器，保留配置目录。

```sh
npm ci
npm run package:desktop:mac:local -- --arm64
```

开发构建需要 Node 24 和 Command Line Tools（编译原生凭据迁移小工具），不需要完整 Xcode。输出在 `apps/desktop/release`。正式双架构构建使用 `npm run package:desktop:mac`，签名、公证配置见 [发布约定](release.md)。本地 ad-hoc 包没有 Apple 公证。

Agent 沿用 `~/Library/Application Support/@codexer/desktop`，保留服务器、账号、installationId、Codex 路径、授权目录及启动偏好。历史 Electron Safe Storage 身份保持不变；原生 Agent 的 `session.native.enc` 使用原钥匙串密钥读取并转存为 Electron 加密的 `session.enc`。原加密文件只在成功转存后删除；钥匙串拒绝访问或服务器撤销会话时仍需授权或重新登录。

钥匙串使用异步初始化，窗口会先显示，等待授权时不阻塞界面；拒绝访问不会降级为明文存储。

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
