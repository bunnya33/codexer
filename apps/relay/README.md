# Go Relay

Go 实现的认证、HTTP/WebSocket 中转和静态页面服务。默认使用纯 Go SQLite（WAL），保留外部 PostgreSQL 支持。服务器只有一个执行文件，内嵌控制端和后台页面，运行时无需 Node。

前端继续使用 React / React Native，PC Agent 继续使用 Electron 的 JavaScript。Node 只用于这些前端/客户端的构建，以及首次读取旧 PGlite 数据时的兼容导入。

## 构建与运行

```bash
npm ci
npm run build:server
./dist/codexer serve
npm run package:server
```

构建需要 Go 1.26 及以上、Node 22.13 及以上。直接开发 Go 服务用 `go run ./cmd/codexer serve`；未构建前端时可设置 `RELAY_WEB_DIR` 和 `RELAY_ADMIN_DIR`。发布包按操作系统与架构分别生成。见 [安装](../../docs/server-install.md)、[迁移与回归](../../docs/go-migration.md)。

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `server.go` / `routes.go` | HTTP、静态页面、生命周期、FIFO 设备队列与身份变更屏障 |
| `transport.go` / `transfers.go` | Agent/客户端连接、同步、指令、历史、图片和文件回源 |
| `previews.go` | 受限网页预览、路径/浏览器运行时改写、SSE 和 WebSocket |
| `accounts.go` / `bootstrap.go` | 账号、Node 兼容 scrypt、登录策略、会话撤销和初始化 |
| `store.go` / `sync_store.go` / `postgres.sql` | SQLite/PostgreSQL、事务、快照拆分、重放与图片保存 |
| `weixin*.go` | 微信扫码、验证、加密绑定、轮询、通知、回复和事务收发队列 |
| `updates.go` / `metrics.go` | 后台更新接口和聚合运行指标 |
| `validation.go` / `projection.go` / `protocol/` | 共享协议 schema、跨字段检查、UTF-16 长度与浏览器预览资源 |
| `../../cmd/codexer` / `../../internal/management` | 单文件入口、管理命令、安装配置、旧库导入和受限升级器 |

快照元数据与会话行分开保存；事件只写变化的会话。序号、事件、快照和完成通知在同一个事务提交。读取完整快照使用一致性事务，PostgreSQL 采用 repeatable read。

同一设备使用 FIFO 队列，不同设备可并行；账号与会话变更等待已登记工作完成，后续请求重新鉴权。WebSocket 收发具有缓冲预算，慢连接单独关闭。等待历史、图片、文件或预览回包时释放设备队列。

清理每批最多 500 行、每类目标最多 20 批。通常每 5 分钟运行，达到预算后 5 秒续跑，轮次不重叠。关闭时取消后续清理并排空已登记任务。保留事件 24 小时、完成的微信收发记录 30 天；命令幂等记录和 pending 通知保留。

`go test ./...` 验证原生实现，`npm test` 先运行 Go 测试，再用实际 Go 服务验证客户端和 Agent。`go test -race ./...` 检查并发访问；可用 `CODEXER_TEST_POSTGRES_URL` 指定独立 PostgreSQL 测试库。更改协议后运行 `npm run build:protocol`，生成文件必须随源码提交。
