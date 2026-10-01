# Web 控制端产物

这里不单独维护控制 UI。`apps/mobile` 的 React Native/Expo 源码通过 `npm run build:web` 导出到 `dist`，Relay 在 `/` 提供。

生产网页自动连接当前站点的 Relay，登录仅输入账号密码，无需配置服务器 IP 或端口。开发时由 `dev:web` 的环境配置指定独立 Relay。

独立 React 管理后台由 `apps/admin` 构建，在 `/admin/` 提供；两个入口使用不同资源和登录存储。详见 [架构](../../docs/architecture.md) 和 [移动/Web 文档](../../docs/mobile.md)。
