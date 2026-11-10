# 让 Codex 更新服务器

本地升级工具负责管理员登录、校验和上传服务器包、等待准备、重启及结果核验；`codexer-server-deploy` Skill 负责让 Codex 根据自然语言完成发布和调用。工具按需运行，不新增常驻 MCP 服务，也不需要给服务器开放 SSH 或新增管理接口。使用现有的 systemd 更新器和回退流程，服务器须已支持手动上传服务器包。

## 安装 Skill 与登录

在仓库根目录执行：

```powershell
npm run skill:install-deploy
npm run server:deploy -- login --url https://codexer.example.com
```

安装器将仓库内的 Skill 模板复制到当前 Codex 用户的 skills 目录，并记录当前仓库路径。换电脑或移动仓库后重新执行安装器即可；不在已提交的 Skill 中写固定盘符。工具要求本地 Node >=22.13 及仓库开发依赖，服务器仍运行 Go，不安装 Node。

登录命令输出 `login-ready` 和一个仅监听本机回环地址、十分钟有效的页面。打开后输入 **服务器管理员账号**；这里的管理员账号与控制会话的普通账号分开。明确使用 HTTP 的既有部署可加 `--allow-http`，页面也可确认 HTTP 连接。登录成功只保存会话，不安装任何更新。密码不写入磁盘或工具输出，登录页不向浏览器返回管理员会话。

Windows 保存位置为 `%LOCALAPPDATA%/Codexer/server-deploy/default.secret`，用当前 Windows 用户的 DPAPI 加密；切换 Windows 用户或电脑后重新登录。非 Windows 使用当前用户配置目录下权限为 0600 的会话文件，此版没有宣称完成 macOS/Linux 实机验收。`CODEXER_DEPLOY_HOME` 可指定独立的本机配置目录。会话继续遵循服务器的空闲过期、退出和密码重置规则，不延长服务器期限，也不在后台保活；过期后重新运行 login。

多台服务器用 `--profile 名称` 分开保存，所有命令都带相同的 profile；默认是 `default`。profile 仅接受小写字母、数字和短横线。

## 使用

以后可对 Codex 说：

- “用 codexer-server-deploy 把这次修改发布并更新到服务器。”
- “把服务器更新到刚发布的 0.3.x。”
- “只发服务器更新包，暂时不要安装。”

仅要求发布更新包时，Skill 不会安装生产服务器；要求更新到既有服务器则包含准备和重启。登录或查看状态也不会自动安装。服务器安装会短暂重启 Relay，远程控制连接按原机制重连。

手动查看状态和预检：

```powershell
npm run server:deploy -- status
npm run server:deploy -- deploy --archive "F:/downloads/codexer-server-0.3.54-linux-amd64.tar.gz"
```

同目录须有与包同名的 `.sha256`；也可用 `--checksum` 指定。工具流式核对 SHA-256、文件名版本、平台和 256 MiB 上限，确认目标比当前版本新，检查远端上传能力及任务冲突。默认只返回 `dry-run` 计划，不上传、不重启，也不更改更新方式或自动更新设置。

用户已要求安装时，执行：

```powershell
npm run server:deploy -- deploy --archive "F:/downloads/codexer-server-0.3.54-linux-amd64.tar.gz" --apply
```

工具通过本机上传，服务器无需从 GitHub 下载。原服务器继续负责包内 manifest、Go 程序和完整归档结构校验。工具记录任务 ID，等待 `built` 后提交该任务的 `restart`，继续轮询到 `succeeded` 并核对当前版本、`/health` 版本和管理员接口后才返回成功。网络短暂中断只重试状态读取，不自动重发上传或重启。

上传后默认轮询等待 900 秒，`--timeout` 可设为 30–3600 秒；上传及每次远端请求另有超时。进度和最终结果输出 JSON，不输出登录会话。任务回执为同目录的 `default.job.json`，包含服务器、版本、摘要、任务 ID 和阶段，没有密码或会话。相同目标版本已健康运行时返回 `already-current`，不会重复安装。

## 失败与恢复

| 返回错误 | 处理 |
| --- | --- |
| `login-required-run-server-deploy-login` / `login-expired` | 打开本地登录页重新登录后继续 |
| `upload-updater-not-installed` | 按[服务器更新](server-update.md)使用安装器升级 root 更新器；本工具不会替换 root helper |
| `server-package-platform-mismatch` / `checksum-mismatch` | 更换匹配平台的正式包及校验文件 |
| `unrelated-update-in-progress` / `deployment-job-changed` | 查看 status 或管理后台，不抢占其它任务 |
| `update-failed:*` / `update-rolled-back:*` | 查看任务原因及服务器日志；停止自动部署，不循环重试 |
| `deployment-timeout-check-status-before-retry` | 查看 status；相同回执可接续轮询。已请求重启时不会再次自动请求，实际未入队需在后台核对后处理 |

如果上传请求断线，服务器可能已收到包；本机没有任务回执时，不会自动接管服务器上的任务，需先查看 status 和管理后台。准备好的包、root 更新器和程序回退均沿用已有实现。生产数据及迁移的兼容要求见[服务器更新](server-update.md)。

退出本工具登录：

```powershell
npm run server:deploy -- logout
```

该命令撤销此会话并移除本机加密会话文件，不退出其它客户端。Skill 模板、工具及说明可提交仓库，真实账号、会话和部署回执不可提交。发布包来源和正式发布要求见[发布与打包](release.md)。
