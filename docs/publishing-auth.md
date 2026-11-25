# 发布授权协议

0.3.55 新增独立设备授权，代码位于 `apps/relay/publishing.go`，仅对选定发布路由开放。普通管理员登录、控制端登录和设备凭据保持独立。

## 服务器生成授权码

管理员通过 `POST /v1/admin/publishing/keys` 提交 `name`、`scopes` 和可选的 `expiresInDays`（整数 1–90，默认 90）。服务器生成 `cdxp_k_` 加 32 字节随机值，并仅在这次 `Cache-Control: no-store` 响应中返回 `code`；同时返回 `grantId`、名称、权限、过期时间和管理员名称。服务器仅保存 SHA-256 摘要，授权列表、身份接口、审计均不返回明文，也没有重新查看接口。

后台“发布授权”可生成、复制并撤销授权码。生成窗口关闭即清除页面内明文，不写入浏览器存储；HTTP 页面不支持 Clipboard API 时尝试兼容复制，失败则选中内容供手动复制。每名管理员最多保留 100 个未撤销且未到期的授权，避免无限生成。

本机 `login --url <服务器地址>` 隐藏读取授权码，也可从标准输入接收；不接受命令行明文参数。工具通过 `GET /v1/publish/me` 校验后以 Windows DPAPI 保存 `publishing-key-v1` 配置。授权码可重复使用至固定有效期，撤销立即失效，不进行刷新或三十天空闲过期。最近使用时间最多每分钟更新一次。明文“只展示一次”不表示上传只能执行一次。

## 兼容的网页审批流程

已有 `publishing-v1` 配置继续使用原访问/刷新凭据；新申请此类配置时使用 `login --web`。

1. CLI 随机生成 32 字节 verifier，提交其 SHA-256 / base64url challenge、电脑名称和申请 scopes 到 `POST /v1/publish/authorize`。
2. 服务器生成独立的 256 位 deviceCode 和八位十六进制 userCode，十分钟有效。返回真实本站后台地址、userCode 和五秒轮询间隔。库不接受异站授权 URL、回调 URL 或任意重定向。
3. 管理员在本站网页登录，`GET /v1/admin/publishing/request?code=...` 核对名称/权限，通过 `POST /v1/admin/publishing/approve` 明确允许或拒绝。网页不接收 deviceCode、verifier 或工具令牌。
4. CLI 以 deviceCode + verifier 向 `POST /v1/publish/token` 交换，仅在批准后且授权管理员仍有效时成功。请求原子消费，不允许重复领取。使用 `grantType: device_code`。
5. `grantType: refresh_token` 原子消费旧刷新凭据，发放新的访问/刷新凭据。重用已消费且仍在有效期内的刷新凭据会撤销整个 grant，包括已经签发的访问令牌。结果未知时 CLI 不自动重发。

访问凭据为 `cdxp_a_` 加 32 字节随机值，有效十分钟；刷新凭据为 `cdxp_r_` 加独立 32 字节随机值，有效三十天；grant 九十天固定上限。库和数据库不会存管理员密码。数据库仅存令牌及 deviceCode 的 SHA-256，保留已消费刷新记录至过期以识别重放。本机用 Windows DPAPI 加密，在操作前持有整个 profile 的排他文件锁并先保存轮换结果。

## 路由边界

`principal` 仅在明确标记为 `publish:<scope>` 的路由上接受发布访问凭据。发布凭据不能被当成普通 admin/member 会话；`GET /v1/publish/me` 和 `POST /v1/publish/revoke` 仅接受发布身份。scope 映射和用户授权说明见[工具使用](server-deploy.md)。

发布凭据可读取服务器版本、上传服务器包和重启对应任务，也可读取客户端安装包与手机热更新目录并上传归档。管理账号、会话、设备命令、更新器设置、Git 构建、删除安装包、下架热更新和管理授权继续使用对应的登录会话。上传在完整接收后、原子发布前再次检查凭据，撤销和管理员密码变更与最终发布通过全局排他锁互斥。

`GET /v1/publish/diagnostics/logs` 接受含 `diagnostics:read` 的授权，返回 `entries`、`nextCursor` 和 `capturedAt`，响应带 `Cache-Control: no-store`。支持 `level`、`category`、`code`、`deviceId`、`connectionId`、`limit` 和 `before`，以及用 Unix 毫秒表示的时间边界 `since` 和 `until`。管理员在原有的服务器日志页面查看完整结构化记录。该权限默认关闭，可独立签发和撤销。

新增表为 publish_requests、publish_grants、publish_tokens、publish_audit，使用两类数据库均支持的增量建表，不更改旧列；回滚程序保留这些新表。请求只保留十分钟，按来源最多十个、全局最多一千个待交换记录；现有 HTTP 来源限流继续适用。凭据签发时清理过期 token。授权和变更操作写独立审计，保留最近一万条，后台显示最近二百条；不会记录 Authorization、verifier、deviceCode 或刷新令牌。

## 传输与撤销

授权码、兼容网页审批和全部发布接口均支持 HTTP 与 HTTPS，包括远程 HTTP；CLI 无需额外开关。直接请求按实际连接生成本站地址。TLS 终结代理仅在显式 HTTPS public URL、Host 匹配、可信代理来源和 `X-Forwarded-Proto: https` 同时满足时改变协议，不信任任意公网转发头。客户端拒绝重定向，避免把凭据带到其它地址。HTTP 本身不加密传输；可选的 TLS 和隧道部署说明见[HTTPS 配置](publishing-https.md)。

后台 `GET /v1/admin/publishing` 查看授权和审计，`DELETE /v1/admin/publishing/{grantId}` 撤销。账户禁用和重置密码撤销关联 grant；普通浏览器退出不会撤销独立工具授权。工具 logout 撤销自己的 grant 并删除本机密文，不影响其它应用登录。

测试覆盖一次交换、错误证明、未批准/拒绝/过期、scope 隔离、旋转与重放、撤销/密码重置、过期令牌、并发消费、上传途中撤销、摘要拒绝与伪造代理；PostgreSQL 使用实际测试数据库复跑核心授权生命周期。UI/工具验收和原生客户端安装验收分别记录。
