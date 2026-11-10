# 发布工具的 HTTPS 配置

0.3.54 的专用发布授权要求 HTTPS。已有 HTTP 站点可先在后台手动上传新版服务器包并确认重启；本页说明之后如何接入发布工具，不会自动改动生产网络、证书或防火墙。

## 现有 systemd + 本机 Caddy

准备解析到服务器的域名，例如 `codexer.example.com`，开放 80/443 以便 Caddy 申请证书，按 Caddy 官方安装说明安装 Caddy。无需把 Codexer 改成 Docker。

在 `/etc/caddy/Caddyfile` 设置（替换域名和现有 Relay 端口）：

```caddyfile
codexer.example.com {
    reverse_proxy 127.0.0.1:8899
}
```

Caddy 会代理整个站点和 WebSocket，并覆盖到后端的 `X-Forwarded-Proto`。后端不接受不可信客户端自行伪造的转发头。在 `/etc/codexer/relay.env` 加入：

```text
RELAY_PUBLIC_URL=https://codexer.example.com
```

保留原配置文件的 root:codexer / 0640 权限和其余配置，再执行：

```bash
sudo codexer origins https://codexer.example.com
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo codexer restart
```

`origins` 会保留原运维来源。应限制 Relay 原 HTTP 端口只能由本机或可信运维地址访问；不要在未核对客户端地址前关闭旧入口。把控制端、Agent 和发布工具的根地址改为 HTTPS，验证 `/health`、`/admin/`、设备 WebSocket 和网页授权。证书、DNS、Caddy 实际运行及公网防火墙必须在目标机器验收，本地构建通过不能代表已启用 HTTPS。

反代信任默认仅限回环地址，且请求 Host 必须与 `RELAY_PUBLIC_URL` 匹配，代理必须传入 `X-Forwarded-Proto: https`。代理在另一台机器或 Docker 网络时，额外设置 `RELAY_TRUSTED_PROXIES` 为**实际代理 IP 或受控专用代理网段**，多个值用逗号分隔；不要填 `0.0.0.0/0`、`::/0` 或任意公网来源。限制后端只对这些来源开放，防止旁路访问。

## Docker + Caddy

既有 `infra/compose.yaml` 已设置 HTTPS public URL；在本机私有 `.env` 中设置真实 `REMOTE_DOMAIN`、管理员密码，以及与 Caddy 容器实际固定 IP 或受控 Docker 专用网段匹配的 `RELAY_TRUSTED_PROXIES`。不要把主机直连端口开放到公网。网络地址按部署实际配置，升级后保持固定，不能从客户端转发头推断可信代理。

## 没有域名时：SSH 隧道

可先通过已经验证过服务器主机密钥的 SSH 连接建立回环隧道，例如：

```powershell
ssh -N -L 127.0.0.1:18899:127.0.0.1:8899 <你的运维账号>@203.0.113.10
npm run server:deploy -- login --url http://127.0.0.1:18899
```

工具和浏览器均使用 `http://127.0.0.1:18899`；公网链路由 SSH 加密。服务器要求请求 Host 和实际来源都为回环地址，且不带代理协议头，防止将远端 HTTP 或 DNS 重绑定当成本机例外。不要仅把公网 HTTP 地址改写成 localhost 而没有建立隧道。隧道结束后发布工具暂不可达，下次保持相同 profile 和本机端口再建立隧道即可。
