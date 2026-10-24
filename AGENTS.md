# 桌面客户端技术约定

用户于 2026-10-19 确认：后续桌面客户端统一使用 Native 实现。此约定适用于 RelayDesk 控制端和 Codexer PC 连接器的 Windows/macOS 桌面界面。

- 桌面 UI 使用 React Native 原生宿主：Windows 使用 React Native for Windows，macOS 使用 React Native macOS。依赖版本须按目标平台支持情况锁定并实际构建验证。
- 会话、目录、登录和设置等应用界面在本机原生渲染，随客户端安装包交付；服务器提供 API、实时状态和文件数据。
- 不以 Electron、react-native-web 或 WebView 加载整个控制页面作为原生桌面迁移的交付结果。网页内容预览可使用隔离 WebView，但应用主界面仍须原生实现。
- 复用已有 React Native 组件、共享业务状态、协议和 PC Agent 核心；平台功能通过原生适配层实现。PC Agent 后台核心可继续使用现有 TypeScript/Node，不要求为原生 UI 重写任务逻辑。
- 保留现有托盘、关闭行为及退出确认、凭据与设备身份、自动连接和登录项等功能。迁移必须覆盖新旧配置与凭据兼容，不能假定替换 UI 就已完成升级。
- Windows/macOS 在同一主线维护 `apps/control-native/src` 中的界面、桥接协议、业务逻辑和 Agent；只把系统 API 适配放入 `windows/`、`macos/` 或平台后缀文件。不得为两个平台长期维护独立功能分支或复制整套应用界面。
- 两端的产品版本统一读取 `apps/control-native/package.json`，禁止在界面、宿主或 sidecar 中另写版本号。平台 React Native 依赖分别锁定在对应 lockfile，不能为统一版本号强行使用平台尚不支持的 RN 版本。
- 默认桌面打包命令必须生成 Native 客户端。旧 `apps/control-desktop`、`apps/desktop` Electron 实现仅保留明确标记的回退维护入口。交付时区分源码接入、原生编译、安装包与实机验收；不得用 JS 打包或类型检查声称原生构建通过。

范围、现状与迁移验收见 [桌面原生化约定](docs/desktop-native.md)。
