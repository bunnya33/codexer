# Relay 服务

Relay 是控制客户端和 PC 之间的认证与通信中转。采用 Node、Fastify 5、WebSocket、TypeScript/Zod：Fastify 负责 HTTP 路由、校验和插件，WebSocket 承载状态同步与命令；它不运行 Codex 模型任务。

## 职责

- 账号登录、scrypt 密码哈希、后台可配置的控制端登录超时、退出/改密/禁用撤销；PC Agent 7 天会话独立。
- 设备账号归属、同账号可见、Agent 会话限定设备，跨账号请求返回 404。
- 维护设备在线状态、快照、epoch/seq 增量和重连同步。
- 转发命令、历史、图片与会话文件请求，记录命令结果并处理超时与幂等。会话文件按需从 PC 流式回源，不缓存或持久化内容。
- 同源提供控制端 `/`、后台 `/admin/` 以及 API `/v1/*`。

PC 主动连接 Relay，电脑无需公网端口。Agent 离线时拒绝新命令；Relay 不能替代 PC 执行任务。服务重启后 PC 自动重连，客户端补齐状态。

微信 ClawBot 也在服务器运行，按账号独立绑定与收发。使用、隔离、监听范围和密钥备份见 [微信接入](weixin.md)。

## 配置

| 环境变量 | 默认/用途 |
| --- | --- |
| `RELAY_HOST` | 源码默认 `127.0.0.1`；安装器/容器使用 `0.0.0.0` |
| `RELAY_PORT` | 源码/容器默认 8787；systemd 安装按访问地址选择 |
| `RELAY_ALLOWED_ORIGINS` | 逗号分隔浏览器来源；生产同源页面可直接访问 |
| `RELAY_WEB_DIR` | 默认 `apps/web/dist`，React Native Web 静态资源 |
| `RELAY_ADMIN_DIR` | 默认 `apps/admin/dist`，React Admin 静态资源 |
| `RELAY_DATA_DIR` | 默认 `.local/relay`，PGlite 数据目录 |
| `RELAY_WEIXIN_ENABLED` | 默认开启微信 ClawBot；`false` 禁用 |
| `RELAY_WEIXIN_KEY` | 可选 64 位十六进制加密密钥，默认保存在数据目录的 `weixin.key` |
| `DATABASE_URL` | 设置后使用外部 PostgreSQL，未设置使用 PGlite |
| `RELAY_ADMIN_USERNAME` / `RELAY_ADMIN_PASSWORD` | 初次创建管理员的账号与密码 |
| `RELAY_ADMIN_PASSWORD_B64` | 安装器的密码编码字段；编码不等于加密 |
| `RELAY_ADMIN_FILE` | 开发环境首次生成管理员的本地凭据文件 |

已有管理员时改环境变量不会自动修改数据库里的密码，使用管理操作重置。数据库只存密码哈希与会话哈希；安装配置中的初始管理员密码仍是敏感数据，需要文件权限和备份保护。

PGlite 适合单实例自建，部署简单；多实例数据库或运维需求使用 PostgreSQL。但当前 WebSocket 在线连接表保存在单进程内，多 Relay 副本需要额外共享连接路由，不能仅换 PostgreSQL 就横向扩容。

设备状态按会话拆分持久化：`snapshots` 保存设备元数据，`snapshot_threads` 保存各会话预览，普通事件只更新变化的会话。对外仍提供原 v1 完整快照及事件重放；事件、序号、会话状态和微信完成通知在同一事务内提交。旧完整快照在启动时自动进行事务迁移，失败不会丢失原快照。升级前按常规流程备份数据库，迁移后的数据库不直接交给旧版服务读取。

服务端按业务目录组织，目录职责、格式化命令和开发约定见 [Relay 开发结构](../apps/relay/README.md)。设备任务按设备排队、不同设备并行，账号与会话变更通过全局屏障保持撤销语义。清理独立分批执行；广播使用设备订阅索引并复用序列化结果。管理员通过 [Relay 性能指标](relay-metrics.md) 查看排队、数据库、事件处理与资源数据。

## 运行和校验

开发 `npm run dev:relay`；构建 `npm run build:server`；生产 `npm run start:relay`。安装器使用 systemd；容器使用 Node 直接运行编译入口。

`GET /health` 只证明服务进程响应，不证明账号、静态资源或某 PC 运行环境正常。完整验收要同时检查 `/`、`/admin/`、登录、PC 在线和一次真实授权任务。

错误用稳定代码返回，服务关闭、401、会话撤销与命令结果见 [API](api.md) / [协议](protocol.md)。命令 accepted 仅说明 Relay 已接收，不能当作任务已完成；不确定结果先检查实际会话再重试。
