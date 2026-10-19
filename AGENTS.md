# 桌面客户端技术约定

用户于 2026-10-19 确认：后续桌面客户端统一使用 Native 实现。此约定适用于 RelayDesk 控制端和 Codexer PC 连接器的 Windows/macOS 桌面界面。

- 桌面 UI 使用 React Native 原生宿主：Windows 使用 React Native for Windows，macOS 使用 React Native macOS。依赖版本须按目标平台支持情况锁定并实际构建验证。
- 会话、目录、登录和设置等应用界面在本机原生渲染，随客户端安装包交付；服务器提供 API、实时状态和文件数据。
- 不以 Electron、react-native-web 或 WebView 加载整个控制页面作为原生桌面迁移的交付结果。网页内容预览可使用隔离 WebView，但应用主界面仍须原生实现。
- 复用已有 React Native 组件、共享业务状态、协议和 PC Agent 核心；平台功能通过原生适配层实现。PC Agent 后台核心可继续使用现有 TypeScript/Node，不要求为原生 UI 重写任务逻辑。
- 保留现有托盘、关闭行为及退出确认、凭据与设备身份、自动连接和登录项等功能。迁移必须覆盖新旧配置与凭据兼容，不能假定替换 UI 就已完成升级。
- 当前 `apps/control-desktop` 与 `apps/desktop` 仍是 Electron 实现；修复现有发行版不代表完成原生迁移。交付时明确区分原生构建、安装包、实机验收与旧架构维护结果。

范围、现状与迁移验收见 [桌面原生化约定](docs/desktop-native.md)。
