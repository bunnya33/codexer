# 让 Codex 发布和更新 Codexer

`codexer-server-deploy` Skill 调用仓库中的按需 CLI，不新增常驻 MCP 服务。服务器继续使用 Go 和既有 systemd 更新器。服务器从 **0.3.55** 起支持专用发布授权；第一次先在后台手动上传新版服务器包、准备并确认重启，之后再授权工具。

## 首次网页授权

```powershell
npm run skill:install-deploy
npm run server:deploy -- login --url https://codexer.example.com
```

工具输出真实服务器的 `/admin/?publish=ABCD-1234` 地址、电脑名称和验证码，等待十分钟。打开该地址，在**服务器管理后台**登录，核对电脑、验证码和申请权限，点击“允许发布”。已登录管理员无需再次输入密码。工具自动接收授权并退出；它不接收密码，不读取浏览器 Cookie 或 localStorage，也不保存管理员会话。

默认申请以下四项权限。可用 `--scopes server:read,server:write` 只授权服务器更新；客户端发布使用 `clients:read,clients:write`。`--name` 自定义电脑名称，默认系统主机名。

| 权限 | 范围 |
| --- | --- |
| `server:read` | 读取版本、平台和更新任务 |
| `server:write` | 上传服务器包；重启由上传生成的确切任务，不执行 Git 构建或更改更新设置 |
| `clients:read` | 读取客户端和兼容 Agent 更新目录 |
| `clients:write` | 上传 Android、Windows/macOS Control、Windows/macOS Agent 安装包；不删除、修改已有包 |

发布凭据不能管理账号、读取控制会话、调用远程 PC 命令或管理其它发布授权。权限授权也不等于每次操作的用户指令：只要求“发个服务器更新”时仅发布 Release；明确要求“更新到服务器”时才准备、重启并核验。上传客户端安装包不会自动替换所有设备上的应用，保留原来的客户端更新确认。

访问令牌有效 10 分钟；刷新凭据每次续期轮换，连续 30 天未续期失效；授权最长 90 天，之后重新网页授权。重复使用旧刷新凭据会撤销整个授权。后台“发布授权”可查看电脑、权限、有效期、撤销授权及最近操作。管理员禁用或重置密码同样立即撤销关联授权。

当前本机 CLI 的加密存储支持 **Windows DPAPI / CurrentUser**，位置为 `%LOCALAPPDATA%/Codexer/server-deploy/default.secret`；不回退为明文文件。换 Windows 用户或电脑需要重新网页授权。可发布 macOS 安装包不代表本机工具已完成 macOS/Linux 凭据存储支持。`CODEXER_DEPLOY_HOME` 可指定本机配置目录；多服务器使用不同的 `--profile 名称`，后续命令保持相同 profile。

旧工具保存的完整管理员会话不作为新发布授权使用。运行新 login 成功后覆盖本机旧凭据；旧服务器会话不再续期，按原登录策略过期。旧本地密码登录页已移除。Node >=22.13 和仓库开发依赖仅用于运行本地工具，服务器不安装 Node。

## HTTPS 与首次升级

公网授权和发布必须使用 **HTTPS**；没有 `--allow-http` 降级选项。原服务器的 HTTP 管理后台仍可用来手动完成第一次升级，但不据此传输新的发布凭据。HTTPS 反向代理配置及 SSH 隧道替代方法见[发布工具的 HTTPS 配置](publishing-https.md)。加密本机文件不能保护明文网络，不能把随机 Token 的长度当作 HTTP 安全保证。

## 服务器更新

```powershell
npm run server:deploy -- status
npm run server:deploy -- deploy --archive "F:/downloads/codexer-server-0.3.55-linux-amd64.tar.gz"
npm run server:deploy -- deploy --archive "F:/downloads/codexer-server-0.3.55-linux-amd64.tar.gz" --apply
```

`deploy` 默认只校验并返回 `dry-run`。同目录需要同名 `.sha256`，或用 `--checksum` 指定。工具流式核对 SHA-256、文件名版本、平台和 256 MiB 上限，检查上传能力、版本及其它更新冲突。仅 `--apply` 上传，等待 `built` 后为同一任务提交一次 `restart`，最终核对任务 `succeeded`、当前版本、`/health` 和专用发布身份接口。

工具不更改更新方式、自动更新设置或 root helper。服务器及受信任更新器继续分别验证包内 manifest、完整性、归档路径和程序格式，保留回退。服务器无需从 GitHub 下载，正式包先由本机下载后上传。

本机 `default.job.json` 保存服务器、版本、SHA-256、任务 ID 和阶段，不含凭据。只接续与回执完全匹配的任务；上传响应丢失、未知重启结果或任务被替换时不盲目重发。已安装且健康时返回 `already-current`。轮询默认 900 秒，可用 `--timeout 30..3600` 调整。

## 发布客户端安装包

```powershell
npm run server:deploy -- clients
npm run server:deploy -- publish-client --target control-android --archive "F:/packages/Codexer-Control-0.1.17.apk"
npm run server:deploy -- publish-client --target agent-windows-x64-setup --archive "F:/packages/Codexer-Agent-0.2.33.exe" --version 0.2.33 --apply
```

同样默认预检，`--apply` 才发布。支持 `--checksum`、`--notes-file`、`--version`、`--build-number`。版本能从唯一明确的文件名自动识别；Android 从 APK 实际清单读取 versionName/versionCode，手工参数与清单冲突时拒绝。Android 还要求非 debuggable、原 applicationId、原正式发布证书，通过本机 Android SDK 的 aapt2 和 apksigner 检验；SDK/JDK 路径及原签名保管见[Android 发布签名](android-signing.md)。工具不读取私钥或签名密码。

| target | 安装包 |
| --- | --- |
| `control-android` | 正式签名 `.apk` |
| `control-windows-x64` | Windows Control `.exe` |
| `control-macos-arm64` / `control-macos-x64` | 对应架构 Control `.dmg` |
| `agent-windows-x64-setup` | Windows Agent 安装版 `.exe`，同时发布原 Agent 兼容通道 |
| `agent-windows-x64-portable` | Windows Agent 便携版 `.exe` |
| `agent-macos-arm64` / `agent-macos-x64` | 对应架构 Agent `.dmg` |

所有上传按实际文件计算并提交 SHA-256，服务器不匹配则不发布；工具再次核对响应和目录。不会把较旧版本覆盖到最新目录；同版本同摘要返回 `already-published`。Windows Agent 的两个通道按顺序发布，若兼容通道失败会明确报错；核对后再次执行会补齐剩余通道而不重复发布现代目录。其它格式与原生签名、架构、实机验收仍依照[客户端更新](client-updates.md)及对应产品的打包流程；文件扩展名和服务器格式校验不能替代原生验收。

## 故障与退出

| 错误 | 处理 |
| --- | --- |
| `server-upgrade-required-for-publishing` | 先手动安装 0.3.55 或更新版本 |
| `http-server-requires-allow-http` / `publishing-requires-https` | 改用 HTTPS 或本机 SSH 隧道；新授权没有 HTTP 兼容开关 |
| `legacy-admin-login-requires-new-web-authorization` / `login-expired` | 运行 login 重新在服务器网页授权 |
| `refresh-reused-reauthorize` | 原刷新凭据已使用，授权被撤销；重新网页授权，不重复刷新 |
| `profile-in-use-check-running-command-or-stale-lock` | 同一 profile 还有命令运行；确认原进程已退出后再删除 `.secret.lock`，不自动抢锁 |
| `unrelated-update-in-progress` / `deployment-job-changed` | 先查看 status 和后台，不抢占任务 |
| `update-failed:*` / `update-rolled-back:*` | 查看服务器更新日志；停止重复部署 |
| `deployment-timeout-check-status-before-retry` | 核对 status 和后台，同一回执可接续轮询；已请求的重启不自动再发 |
| `server-unreachable` | 读取请求可重试；上传、刷新、重启结果未知时先核对状态，不自动重发 |

```powershell
npm run server:deploy -- logout
```

退出撤销本工具授权并移除本机密文，不退出其它客户端。网络不可达导致撤销未确认时保留本机凭据；也可在后台撤销。不要提交本机凭据、回执或锁文件。正式包来源要求见[发布与打包](release.md)，协议实现见[发布授权协议](publishing-auth.md)。
