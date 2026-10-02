# React 管理控制台

独立 React/Vite 侧栏控制台，管理控制端账号、后台管理员、登录策略和服务器更新，不读取 PC 会话、不建立控制 WebSocket。构建产物 `dist` 由 Relay 在 `/admin/` 同源提供，与服务端统一安装。两类账号使用独立登录入口。

根目录 `npm run dev:admin`（5174），`npm run build:admin` 构建。接口、账号流程与独立会话说明见 [后台文档](../../docs/admin.md)。
