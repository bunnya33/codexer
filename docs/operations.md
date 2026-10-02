# 运维与故障排查

## HTTPS：Docker + Caddy

服务器具备 Docker 和 Compose，域名解析到服务器并开放 TCP 80/443。在源码根目录：

```bash
cp infra/.env.example infra/.env
# 编辑 infra/.env：REMOTE_DOMAIN、POSTGRES_PASSWORD、管理员账号密码
docker compose --env-file infra/.env -f infra/compose.yaml up -d --build
```

Caddy 自动管理该域名证书并反向代理 Relay。访问 `https://你的域名/` 和 `/admin/`；PC 使用相同 HTTPS 根地址。PostgreSQL 不对外暴露，Relay 仅在容器网络暴露 8787。数据库密码使用随机 base64url 字符避免 URI 编码问题；管理员密码至少 12 字符。`.env` 不提交、不分享。

更新执行同一条 Compose 构建命令，不删除 volumes。查看状态/日志：

```bash
docker compose --env-file infra/.env -f infra/compose.yaml ps
docker compose --env-file infra/.env -f infra/compose.yaml logs --tail=100 relay caddy
```

如在 systemd 安装前放置自己的反向代理，让代理转发整个站点（含 WebSocket）到本机端口；执行 `sudo codexer origins https://relay.example.com` 加入实际 HTTPS 来源。该命令保持首项 HTTP 运维地址和本机监听端口，不自动申请证书。公网可仅开放代理的 443，限制 Relay 直连端口。代理要允许 WebSocket upgrade 与图片请求大小。

## 状态和账号恢复

systemd：`sudo codexer status`、`sudo codexer logs`、`sudo codexer restart`；浏览器账号管理见 [Admin](admin.md)。管理员密码使用 `sudo codexer password`，同时更新数据库与受限配置。若曾在后台改密，CLI 提示时输入当前管理员密码。后台与控制端使用独立账号；现有管理员用于 PC 时需创建控制端账号后重新登录。

安装器管理的服务器支持后台稳定 Release 更新，自动安装默认关闭，见 [服务器更新](server-update.md)。PGlite 停服备份期间先 `sudo systemctl stop codexer-updater.timer`，确认没有更新任务正在执行，再停止 Relay；备份后启动 Relay 和 timer，避免更新与复制数据库重叠。

Docker 的命令行账号管理：

```bash
docker compose --env-file infra/.env -f infra/compose.yaml exec relay node dist/scripts/manage-users.js list
docker compose --env-file infra/.env -f infra/compose.yaml exec relay node dist/scripts/manage-users.js create 用户名
docker compose --env-file infra/.env -f infra/compose.yaml exec relay node dist/scripts/manage-users.js password 账号ID
```

命令使用当前容器配置中的管理员密码，创建/改密在终端提示输入。若曾通过 API 修改管理员密码，需要同步受限配置；已有管理员时仅改环境变量不会重置数据库密码。不要删除数据库来“恢复”账号。

## 备份与恢复

PGlite 需要停服复制完整数据库目录；不能运行中只复制几个文件：

```bash
sudo systemctl stop codexer-relay
sudo tar -czf /root/codexer-backup.tar.gz /var/lib/codexer /etc/codexer
sudo chmod 600 /root/codexer-backup.tar.gz
sudo systemctl start codexer-relay
```

备份含管理员配置、会话及任务数据，按凭据保护。恢复先停服，将备份恢复至原路径、确认 `/var/lib/codexer` 属于 codexer 且目录 0700，配置 root:codexer 0640；使用匹配版本启动，检查登录与设备。恢复前额外保留当前数据副本。

外部 PostgreSQL 使用 `pg_dump`/`pg_restore`。Docker 示例：

```bash
docker compose --env-file infra/.env -f infra/compose.yaml exec -T postgres pg_dump -U codex_remote -d codex_remote -Fc > codexer-postgres.dump
```

恢复前停止 Relay，备份现有库，在明确的目标库用 `pg_restore`；同时备份 `infra/.env` 和 Caddy volumes。不要执行 `docker compose down -v`，它会删除持久数据。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| `/health` 正常，页面 404 | Web/Admin 是否构建并复制；`RELAY_WEB_DIR`、`RELAY_ADMIN_DIR` 是否正确 |
| 后台不是账号管理页 | `/admin/` 必须指向 React Admin 产物，不能复用控制端 bundle |
| 看不到 PC | PC 与控制端是否同账号；PC 是否已连接；该账号是否改密/禁用 |
| PC 远程已连接、本机等待 | 官方 Codex 是否安装/登录；数据/程序路径；运行方式；诊断代码 |
| 手动断开后未自动恢复 | 预期行为，点击连接；启动自动连接只作用于下次启动 |
| 登录失败或 HTTP 被拒 | HTTPS 根地址、账号密码、会话/账号状态；内网测试可明确允许 HTTP |
| PC 连上即断开，反复 `1008` | 老版本可能无法保存含 NUL 的命令输出；更新 Relay 或连接器。新版本显示拒绝原因并暂停无效重试，保留账号与本机任务 |
| `relay-storage-error` / `1011` | 检查 Relay 脱敏诊断 `sqlState`、数据库状态及磁盘；连接器会退避重试。不要删除数据库或会话来修复存储错误 |
| browser origin denied | 正确的 HTTPS/开发来源加入 `RELAY_ALLOWED_ORIGINS`，不可带路径 |
| unknown/超时结果 | 操作可能已执行，先看真实会话，避免立即重复发送 |
| Mac 找不到 Codex | GUI PATH 不同，手动选程序；检查 App Server 和 IPC 的实机兼容性 |
| 端口冲突/安装中止 | 确认监听进程，不让安装器覆盖其他服务；使用新端口或正确迁移 |

PC 导出脱敏诊断即可，勿分享 `settings.json`、`session.enc`、完整数据目录或真实地址。系统 journal/代理日志可能包含操作环境信息，分享前同样检查。运行时原理见 [架构](architecture.md) / [Relay](relay.md)。

Relay 在校验、广播和 JSONB 保存设备观测消息前，将实际 NUL 和不完整 UTF-16 字符替换成 `�`。命令输出、历史或标题中的普通文字及字面量 `\u0000` 不变；发给 PC 的控制命令不经过该转换。兼容未更新的连接器，无需迁移或清空数据库。
