# Codexer Agent Qt

连接器使用 Qt 6.8.3 Widgets 原生界面，后台复用已有 TypeScript `ConnectorController` 与 `PcAgent`，通过私有标准输入输出 JSON 通道连接。没有 WebEngine、WebView、Chromium 或 Electron 运行时。Control 保留 React Native，不在此次迁移范围。

版本仍读取 `../desktop/package.json`，配置、设备身份和凭据保持既有目录。Windows 支持 DPAPI 原生登录与 Electron `v10` 凭据迁移；macOS 复用原钥匙串实现，但此轮仅在 Windows 实际编译与验收。

## 构建

安装 Qt 6.8.3 的 qtbase（Windows `win64_msvc2022_64`）、Visual Studio C++ 桌面工具、Windows SDK、CMake 与 Node 24。设置 `CODEXER_QT_ROOT` 指向 Qt SDK 目录，运行根项目的 `npm run build:qt-agent` 或 `npm run package:desktop:win`。本地默认 Qt 路径为 `.local/qt/6.8.3/msvc2022_64`。可用 `CODEXER_CMAKE` 指定 CMake。

`stage` 包含原生程序、可替换的 Qt DLL、插件、VC 运行库、Node、后台 bundle 及许可证。`release` 包含安装版和便携版。打包复用已有 NSIS 工具，输出中不包含 Electron；安装包本身使用相同应用 ID `com.codexer.connector`。

`npm run check:qt-agent` 只用隔离合成配置，验证原生启动、DPAPI 往返、已有原生登录、旧 Electron 登录迁移、设备身份保留、单实例、后台命令和内存采样，不连接真实账号。`CODEXER_USER_DATA_DIR` 可指定隔离配置，但不能与生产配置并发运行。

托盘保留显示、重启、退出确认、运行时刷新和更新入口；「会话与运行时」及托盘提供「释放空闲会话」。所有本 Agent 写入者安全空闲时，通过初始化替代服务并停止旧 app-server 释放实际写入锁。运行中任务、待交互及未保存新会话继续保留；初始化失败保留旧服务。当前 Codex 的取消订阅接口不会释放写入锁。操作不删除历史，不抢占其他应用。

Qt 采用动态链接 LGPL 库，许可证和对应源码链接随包提供；可用兼容的修改版 Qt 库重新链接/替换。Qt 源码与构建说明见 [Qt 6.8.3](https://github.com/qt/qtbase/tree/v6.8.3) 和上述构建入口。Windows 与 macOS 的实际构建及实机验证结果分开记录。
