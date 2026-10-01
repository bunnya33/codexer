# React 账号管理后台

独立 React/Vite 应用，只管理用户，不读取 PC 会话，不建立控制 WebSocket。构建产物 `dist` 由 Relay 在 `/admin/` 同源提供，与服务端统一安装。

根目录 `npm run dev:admin`（5174），`npm run build:admin` 构建。接口、账号流程与独立会话说明见 [后台文档](../../docs/admin.md)。
