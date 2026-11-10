# 发布授权协议

0.3.55 新增独立设备授权，代码位于 `apps/relay/publishing.go`，仅对选定发布路由开放。普通管理员登录、控制端登录和设备凭据保持独立。

## 流程与凭据

1. CLI 随机生成 32 字节 verifier，提交其 SHA-256 / base64url challenge、电脑名称和申请 scopes 到 `POST /v1/publish/authorize`。
2. 服务器生成独立的 256 位 deviceCode 和八位十六进制 userCode，十分钟有效。返回真实本站后台地址、userCode 和五秒轮询间隔。库不接受异站授权 URL、回调 URL 或任意重定向。
3. 管理员在本站网页登录，`GET /v1/admin/publishing/request?code=...` 核对名称/权限，通过 `POST /v1/admin/publishing/approve` 明确允许或拒绝。网页不接收 deviceCode、verifier 或工具令牌。
4. CLI 以 deviceCode + verifier 向 `POST /v1/publish/token` 交换，仅在批准后且授权管理员仍有效时成功。请求原子消费，不允许重复领取。使用 `grantType: device_code`。
5. `grantType: refresh_token` 原子消费旧刷新凭据，发放新的访问/刷新凭据。重用已消费且仍在有效期内的刷新凭据会撤销整个 grant，包括已经签发的访问令牌。结果未知时 CLI 不自动重发。

访问凭据为 `cdxp_a_` 加 32 字节随机值，有效十分钟；刷新凭据为 `cdxp_r_` 加独立 32 字节随机值，有效三十天；grant 九十天固定上限。库和数据库不会存管理员密码。数据库仅存令牌及 deviceCode 的 SHA-256，保留已消费刷新记录至过期以识别重放。本机用 Windows DPAPI 加密，在操作前持有整个 profile 的排他文件锁并先保存轮换结果。

## 路由边界

`principal` 仅在明确标记为 `publish:<scope>` 的路由上接受发布访问凭据。发布凭据不能被当成普通 admin/member 会话；`GET /v1/publish/me` 和 `POST /v1/publish/revoke` 仅接受发布身份。scope 映射和用户授权说明见[工具使用](server-deploy.md)。

只对服务器版本读取、服务器包上传、上传任务重启、客户端目录读取和安装包上传开放。管理账号、全部会话、设备命令、修改更新器设置、Git 构建、删除包和管理授权仍需要普通管理员或控制账号。上传在完整接收后、原子发布前再次检查凭据，撤销和管理员密码变更与最终发布通过全局排他锁互斥。

新增表为 publish_requests、publish_grants、publish_tokens、publish_audit，使用两类数据库均支持的增量建表，不更改旧列；回滚程序保留这些新表。请求只保留十分钟，按来源最多十个、全局最多一千个待交换记录；现有 HTTP 来源限流继续适用。凭据签发时清理过期 token。授权和变更操作写独立审计，保留最近一万条，后台显示最近二百条；不会记录 Authorization、verifier、deviceCode 或刷新令牌。

## 传输与撤销

授权和全部发布凭据请求需要 HTTPS。回环例外要求实际 TCP 来源和 Host 都为回环且无转发协议头，可用于本机开发和 SSH 隧道。TLS 终结代理必须同时满足显式 HTTPS public URL、Host 匹配、可信代理来源和 `X-Forwarded-Proto: https`，不信任任意公网转发头。部署说明见[HTTPS 配置](publishing-https.md)。

后台 `GET /v1/admin/publishing` 查看授权和审计，`DELETE /v1/admin/publishing/{grantId}` 撤销。账户禁用和重置密码撤销关联 grant；普通浏览器退出不会撤销独立工具授权。工具 logout 撤销自己的 grant 并删除本机密文，不影响其它应用登录。

测试覆盖一次交换、错误证明、未批准/拒绝/过期、scope 隔离、旋转与重放、撤销/密码重置、过期令牌、并发消费、上传途中撤销、摘要拒绝与伪造代理；PostgreSQL 使用实际测试数据库复跑核心授权生命周期。UI/工具验收和原生客户端安装验收分别记录。
