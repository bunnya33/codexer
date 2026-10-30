# Codexer Agent Qt

连接器使用 Qt 6.8.3 Widgets 原生界面，后台为同进程 C++/Qt 工作线程（0.2.17 起），通过 Qt queued signals 与界面通信。网络、Codex RPC/桌面 IPC、目录和历史、审批、队列、SQLite、图片/文件/预览与更新下载均由原生代码处理。没有 Node、JavaScript 引擎、WebEngine、WebView、Chromium 或 Electron 运行时。Control 保留 React Native，不在此次迁移范围。

版本仍读取 `../desktop/package.json`，配置、设备身份和凭据保持既有目录。Windows 支持 DPAPI 原生登录与 Electron `v10` 凭据迁移；macOS 复用原钥匙串实现，但此轮仅在 Windows 实际编译与验收。

0.2.18 的 `connector_ui` 按 Electron 原版实现连接状态、设置与诊断三页侧栏，保留原版卡片、登录/账号切换、设置草稿与手动保存、目录选择/移除、开关、更新状态及断开/退出登录确认。自定义标题栏支持最小化、最大化/还原、拖动、双击、边缘缩放；Windows 保留系统缩放框架，通过 DWM 绘制细描边、柔和阴影及 Windows 11 圆角，最大化遵守显示器工作区。Qt 原生对话框、字体度量与平台窗口外观仍存在细微差异。

## 构建

安装 Qt 6.8.3 的 qtbase 和 qtwebsockets（Windows `win64_msvc2022_64`）、Visual Studio C++ 桌面工具、Windows SDK、CMake 与 Node 24。设置 `CODEXER_QT_ROOT` 指向 Qt SDK 目录，运行根项目的 `npm run build:qt-agent` 或 `npm run package:desktop:win`。本地默认 Qt 路径为 `.local/qt/6.8.3/msvc2022_64`。可用 `CODEXER_CMAKE` 指定 CMake。

`stage` 包含原生程序、可替换的 Qt DLL、插件、VC 运行库及许可证；不包含 node.exe、agent.cjs 或 Electron。`release` 包含安装版和便携版。打包复用已有 NSIS 工具，输出中不包含 Electron；安装包本身使用相同应用 ID `com.codexer.connector`。

`npm run check:qt-backend` 运行隔离原生回归与共享 Zod 协议对照；设置 `CODEXER_NATIVE_REAL_WRITER=1` 可额外使用全新临时 CODEX_HOME 验证真实 writer 释放，不发送模型任务。

同一命令也运行 Qt UI 交互回归。设置 `CODEXER_UI_SCREENSHOTS` 可生成三页、连接状态、确认窗与窄窗截图。`npm run check:qt-memory` 在 Windows 使用正常启动而非截图 smoke 模式，分别测量可见窗口、托盘冷启动的 5/30 秒内存以及首次显示恢复；不使用账号、不连接 Relay、不发送模型请求、不裁剪工作集。`measure-qt-memory.ps1` 用 Windows 原生工作集查询按私有分配、DLL 映射与字体映射记录来源。

字体仅选择当前平台的实际字体。Windows 将不存在的 macOS 字体写进全局 QSS 会触发大量字体回退，旧版的这部分开销已移除。启动先聚焦状态区域，避免空闲时提前加载搜狗等输入法模块；用户编辑时仍正常启用输入法。托盘冷启动延后创建完整窗口；打开后保留界面与草稿。诊断列表只在日志变化且页面可见时更新。内存 smoke 默认不截图；显式 `CODEXER_QT_SMOKE_CAPTURE=1` 才捕获，避免截图分配混入空闲数据。最终 Windows 构建在正常启动 5 秒后约为可见窗口 39 MiB 工作集 / 10 MiB 私有提交、托盘冷启动 27 / 4.6 MiB；采样范围与验收限制见 [验证记录](../../docs/validation.md)。

`npm run check:qt-agent` 只用隔离合成配置，验证原生启动、DPAPI 往返、已有原生登录、旧 Electron 登录迁移、设备身份保留、单实例、后台命令和内存采样，不连接真实账号。`CODEXER_USER_DATA_DIR` 可指定隔离配置，但不能与生产配置并发运行。

托盘保留显示、重启、退出确认、运行时刷新和更新入口；「会话与运行时」及托盘提供「释放空闲会话」。所有本 Agent 写入者安全空闲时，通过初始化替代服务并停止旧 app-server 释放实际写入锁。运行中任务、待交互及未保存新会话继续保留；初始化失败保留旧服务。当前 Codex 的取消订阅接口不会释放写入锁。操作不删除历史，不抢占其他应用。

Qt 采用动态链接 LGPL 库，许可证和对应源码链接随包提供；可用兼容的修改版 Qt 库重新链接/替换。Qt 源码与构建说明见 [Qt 6.8.3](https://github.com/qt/qtbase/tree/v6.8.3) 和上述构建入口。Windows 与 macOS 的实际构建及实机验证结果分开记录。

Qt WebSockets 对应源码：[qtwebsockets 6.8.3](https://github.com/qt/qtwebsockets/tree/v6.8.3)。Zstd 1.5.7 仅静态链接解压部分，下载 SHA256 固定于 CMake；许可证随包交付。
