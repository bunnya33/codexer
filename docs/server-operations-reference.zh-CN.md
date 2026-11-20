# Linux 服务器安装、管理与更新规范

本规范供其他项目实现 Linux systemd 部署。Codexer 示例以 2026-11-20 核对的 `main` 源码为准，根包版本为 `0.3.76`。接入项目使用自己的项目名、发布仓库、端口、服务账号及数据路径。

## 1. 发包与首次安装

### 发布产物

- 在 CI 编译服务端和网页资源，为 Linux amd64、arm64 分别产出 `<项目>-server-<版本>-linux-<架构>.tar.gz` 和同名 `.sha256`。包内包含可运行程序、`install.sh`、版本文件和包清单。清单至少记录产品类型、版本、操作系统、架构及运行时。稳定标签 `vX.Y.Z`、构建版本、清单和程序输出应一致。
- Codexer 把 Relay、Web 控制端和 Admin 内嵌到同一个 Go 执行文件。Linux 生产机解压即可运行，构建所需的 Go、Node 和 npm 留在 CI 或构建机。其他项目沿用自己的技术栈，随包交付其运行所需的程序与资源。
- Codexer 在推送稳定标签后由 `release-server.yml` 验证版本、跑测试并发布各架构包。Release 页面和对应校验文件可用于核对实际交付结果。发布 Release 和将其安装到某台机器是两个独立操作。

### 用户安装步骤

1. 在 Linux 服务器执行 `uname -m`。`x86_64` 选 `linux-amd64`，`aarch64` 选 `linux-arm64`。下载同一正式 Release 的包与校验文件，放到同一目录。服务器需要可用的 systemd 和 sudo/root 权限。
2. 校验、解压并运行包内安装器。以下以 Codexer 的 amd64 包为例，实际安装时从 Release 取包名。

   ```bash
   sha256sum -c codexer-server-0.3.76-linux-amd64.tar.gz.sha256 &&
     tar -xzf codexer-server-0.3.76-linux-amd64.tar.gz &&
     cd codexer &&
     sudo bash install.sh
   ```

3. 输入浏览器可访问的 HTTP 根地址，例如 `http://203.0.113.10:8899`。Codexer 从地址解析监听端口。无人值守安装在包目录使用 `sudo env CODEXER_PUBLIC_URL=http://203.0.113.10:8899 bash install.sh`。覆盖安装时，交互提示允许回车沿用现有地址。
4. 安装完成后按接入方式放行端口，测试 `/health`、`/` 和 `/admin/`。安装器会输出访问地址和管理入口，首次创建管理员时会输出初始凭据。

可提供 `bootstrap.sh` 便于远程引导。Codexer 的发布包模式接收 `CODEXER_ARCHIVE_URL` 和 `CODEXER_ARCHIVE_SHA256`，下载到临时目录并转交包内安装器。对接项目的正式安装示例应同时提供固定版包地址和摘要。Codexer 另有 `CODEXER_REPO_URL` / `CODEXER_REF` 源码安装入口，需要服务器具备构建环境。

### 安装器职责

1. 检查系统、架构、权限、工具和目标路径，拒绝覆盖非安装器管理的同名服务。安装与更新共用文件锁。检查包结构和程序版本，静态程序丢失执行权限时可恢复权限。包不完整时提示重新解压。
2. 创建无登录 shell 的服务账号，将程序写入独立版本目录。首次生成管理员配置。重复安装读取既有配置并保留已有数据库、账号、密钥和连接身份。遇到已有数据缺失或目标冲突要中止并报明原因。
3. 记录旧版本链接、服务配置和启动状态，安装主服务、管理命令、受信任的更新器和定时器。主服务用专用账号运行，配置与数据独立于发布目录。切换程序后执行 `daemon-reload` 并启动服务，登记开机自启。
4. 验证健康接口、两个网页入口及管理员认证。Codexer 覆盖旧安装时，如果页面健康且配置中的凭据只返回 `401 invalid-credentials`，安装器会提示使用后台现行密码并保留账号。其他验收失败会触发程序、配置、systemd 服务和更新器恢复。数据库迁移的恢复使用与旧版本匹配的备份。

## 2. 服务、目录和权限

| 职责 | Codexer 的实际位置或命令 |
| --- | --- |
| 程序与各版本 | `/opt/codexer/releases/<版本目录>/codexer`，由 root 管理 |
| 当前运行版本 | `/opt/codexer/current` 符号链接 |
| 服务进程 | `/opt/codexer/current/codexer serve`，由 `codexer-relay.service` 托管 |
| 交互入口 | `/usr/local/bin/codexer`，包装脚本注入配置路径并转发参数 |
| 服务配置 | `/etc/codexer/relay.env`，`root:codexer`，权限 `0640` |
| 持久数据 | `/var/lib/codexer/`，其中 `relay/` 保存 SQLite 与微信密钥。数据目录由 `codexer` 持有，权限 `0700` |
| 更新器 | `/usr/local/lib/codexer-updater/codexer`，root 所有，由 `codexer-updater.service` 执行 |
| 更新请求 | `/var/lib/codexer-updater/inbox/`，服务账号可写。任务按 ID 生成，上传不接受自定义路径或命令 |
| 更新状态 | `/var/lib/codexer-updater/` 下的 `status.json`、暂存记录及 `rollback.json`，由 root 写入 |
| 调度与互斥 | `codexer-updater.timer` 约每 30 秒处理一次，和安装器共用 `/run/codexer-install.lock` |

主服务使用 systemd 的异常重启和 journal。后台只向受限目录提交结构化请求，受信任更新器按任务白名单执行。发布目录、回退记录和更新器本身由 root 控制。公网 HTTPS 可由 Caddy 等代理整个站点和 WebSocket，单独配置公开地址、允许来源和可信代理。

## 3. `codexer` 终端管理菜单

安装后输入 `sudo codexer` 打开菜单。直接执行包内裸二进制时，无参会启动服务。对接项目可沿用「系统命令无参进菜单、服务显式运行 `serve)」的入口设计，同一操作同时提供菜单和直接子命令。

| 菜单 | 直接命令 | 行为 |
| --- | --- | --- |
| 1 启动 | `sudo codexer start` | 启动 systemd 服务并检查健康 |
| 2 停止 | `sudo codexer stop` | 停止当前服务 |
| 3 重启 | `sudo codexer restart` | 重启当前版本，启动后检查健康 |
| 4 状态 | `sudo codexer status` | 显示服务状态、子状态、主 PID、重启次数和内存 |
| 5 日志 | `sudo codexer logs` | 查看最近 100 条 journal 并实时跟随，Ctrl+C 结束跟随 |
| 6 端口 | `sudo codexer port 8899` | 校验端口范围，修改配置并重启，失败时尝试恢复旧配置。Codexer 此操作会将来源列表重置为新 HTTP 地址，反代部署要重新配置所需来源 |
| 7 管理员密码 | `sudo codexer password` | 终端隐藏输入新密码，通过管理员 API 更新账号，再写回受限配置。配置密码已过期时，先同步当前管理员凭据 |
| 8 账号 | `sudo codexer users` | 子菜单为查看、创建、设置密码、禁用和返回。直接命令为 `users list`、`users create [用户名]`、`users password [账号ID]`、`users disable [账号ID]`。禁用需输入 `YES` |
| 9 来源 | `sudo codexer origins https://tool.example.com` | 设置浏览器额外来源，保留首项 HTTP 运维地址。支持逗号分隔的多个来源，地址仅含协议、主机和可选端口。会重启服务并检查健康 |
| 0 退出 | — | 退出菜单 |

`sudo codexer info` 查看版本、访问地址和配置/数据路径，`sudo codexer version` 输出当前程序版本，`sudo codexer health` 验证服务与网页入口，`codexer help` 查看用法。无人值守任务使用直接子命令。启用待安装版本通过后台的「立即重启」或绑定更新任务的发布 CLI 操作。

对接项目至少提供启停重启、状态、日志、端口、版本和健康检查。项目有独立账号体系时，补齐改密和账号管理。配置操作应校验输入并在重启失败时恢复旧配置。涉及反向代理时，端口变更应有明确的来源保留规则。

## 4. 更新操作

| 使用场景 | Codexer 的操作路径 |
| --- | --- |
| 服务器能访问 GitHub | 打开 `/admin/` 左上角版本徽标 →「立即更新」→「确认更新」。系统下载平台匹配的 Release 包、核对摘要并准备新版本。完成后点「立即重启」→「确认重启」 |
| 服务器访问 GitHub 困难 | 在电脑下载正式包和同名 `.sha256` →「系统设置 → 服务器更新 → 手动上传服务器更新包」→ 一起选择或拖入两个文件 →「上传并准备更新」→ 等待准备 → 确认重启。上传路径无需服务器下载 GitHub 资产 |
| 只有稳定 tag，需服务器构建 | 安装时设 `CODEXER_GIT_UPDATES=1`，准备 Go、Node、npm、Git 和受限构建账号。在设置中选择「Git tag · 服务器构建」，选高于当前版本的稳定 tag，依次确认拉取、构建和重启。构建失败可从保存的源码快照重试 |
| 更新器能力过旧 | 将新版正式包和校验文件传到服务器，校验后运行新版包内 `sudo bash install.sh`。该流程会重启服务并替换受信任更新器，保留既有配置和持久数据 |
| Docker / 自管部署 | 使用该部署自身的交付方式更新。Codexer Compose 使用 `docker compose --env-file infra/.env -f infra/compose.yaml up -d --build`，沿用持久卷 |

在线检测和自动准备分开。Codexer 的「自动准备稳定版本」默认关闭，开启后在启动时和每 6 小时检查。自动动作到准备阶段为止，重启始终由人或显式调用确认。Git 模式逐步确认。

### 更新器实现要求

1. **准备**。校验正式来源、稳定版本、平台、大小、SHA-256、包清单和程序格式。上传需流式保存，Codexer 上限为 256 MiB。拒绝危险归档条目，在受保护的暂存区解包。程序切换发生前，旧服务继续提供访问。安装、上传、在线更新及激活要正确处理重复提交和并发冲突。
2. **记录任务**。保存任务 ID、目标版本、来源、准备状态和错误码。Codexer 的准备完成状态是 `built`，Git 拉取完成是 `fetched`。页面刷新后按服务器持久化的任务恢复展示，等待确认期间保留准备好的版本。
3. **确认激活**。重启请求绑定原任务 ID 和目标版本，确认暂存产物匹配，先写回退记录，再停止服务、原子切换 `current` 并启动。Codexer 后台用 `GET /v1/admin/system/version` 查询状态，通过 `PUT /v1/admin/system/update-package` 上传，使用 `POST /v1/admin/system/update` 提交带 `tag`、`action: restart`、`jobId` 的请求。
4. **核验与回退**。确认进程运行，`/health` 报告目标版本，Web 和 Admin 返回正常页面后记为 `succeeded`。启动或健康检查失败时，恢复旧链接、启动旧服务并核验。旧服务恢复成功后记为 `rolled-back`，恢复失败呈现错误码。激活过程中断时，下次更新器运行从回退记录恢复。涉及数据库结构变更时，应验证旧程序兼容性或准备对应的数据恢复流程。

### 本机发布 CLI

Codexer 可在后台「发布授权」生成限权授权码，只显示一次，可撤销并配置有效期。服务器发布选择 `server:read` 和 `server:write`。工具通过隐藏终端输入或标准输入导入，并使用 Windows DPAPI 加密保存。当前版本支持 HTTP 和 HTTPS。公网经 HTTPS 反代时，发布授权和上传也使用同一公开根地址。

```powershell
npm run server:deploy -- login --url https://codexer.example.com
npm run server:deploy -- status
npm run server:deploy -- deploy --archive "F:/downloads/codexer-server-0.3.76-linux-amd64.tar.gz"
npm run server:deploy -- deploy --archive "F:/downloads/codexer-server-0.3.76-linux-amd64.tar.gz" --apply
```

默认只预检版本、平台、摘要及更新能力。`--apply` 才上传，等待准备好后为同一任务发起一次重启，并核验任务成功、当前版本、健康状态和发布身份。连接中断或结果不明时先查询状态及原任务回执，再决定如何接续。

## 5. 备份、故障排查和验收

- SQLite 停服备份前，先停更新 timer 并确认当前更新任务结束，再停主服务。备份完整数据目录与配置，包括 WAL/SHM 和业务密钥，按凭据保护。外部 PostgreSQL 用 `pg_dump` / `pg_restore`，同时保存应用配置及业务密钥。恢复时使用对应版本并验证账号和业务数据。
- Codexer 从旧 Node/PGlite 升级到 Go 时需使用新版安装器，并保留旧运行目录及驱动直到一次性导入成功。普通应用更新回退恢复的是程序版本。涉及跨存储迁移的回退需恢复匹配版本的数据备份。
- 查看主服务使用 `sudo codexer status` 和 `sudo codexer logs`。查看更新失败使用 `sudo journalctl -u codexer-updater.service -n 100 --no-pager`，结合后台的任务 ID、阶段和错误码定位。健康检查失败时核对端口占用、配置、权限和反代，遇到任务状态不明先检查实际版本和健康情况。

| 验收场景 | 通过条件 |
| --- | --- |
| 首次安装和重启机器 | 在目标 Linux 上用正式包完成安装。服务自启，健康与网页通过，管理员可登录，系统命令可查看状态和日志 |
| 保留数据升级 | 旧版本中创建测试账号与数据。准备期间旧版本正常，确认重启后版本、账号、数据和链接符合预期 |
| 手动上传 | 禁用测试机到发布源的网络访问时，仍能经后台上传、准备、确认和升级 |
| 错包与并发 | 拒绝校验错、架构错、旧版本、坏包和冲突任务。保留旧版本运行，管理员能看到失败原因 |
| 激活失败 | 模拟新版本启动失败或健康检查错误，核对旧版本恢复、任务状态和真实健康 |
| 重试和恢复 | 准备后刷新页面可继续。中断激活后能恢复。相同任务重复提交不会多次切换 |
| 菜单与配置 | 菜单和子命令行为一致。测试日志、启停、改端口失败后的恢复，有账号体系时验证改密和禁用 |

## 6. 用户可见错误提示

登录页、管理菜单和更新界面应说明失败的操作、已知原因和可执行的下一步。错误码可放在诊断或日志中供排查。凭据校验失败统一提示「用户名或密码错误」，避免透露用户名是否存在。

| 已确认的原因 | 提示示例 |
| --- | --- |
| 用户名、密码或账号类型未通过登录校验 | 用户名或密码错误。请确认使用此入口对应的账号。 |
| 已登录的会话到期或被撤销 | 登录已失效，请重新登录。 |
| 无法连接服务器 | 连接服务器失败。请检查服务器地址、端口和网络。 |
| 建连或请求超时 | 连接服务器超时，请稍后重试。 |
| 当前客户端配置禁止远程 HTTP | 当前设置禁止远程 HTTP 连接。请使用 HTTPS，或在设置中开启允许远程 HTTP。 |
| 当前部署仅支持 HTTPS | 此服务器仅支持 HTTPS，请使用 HTTPS 地址。 |

仅在服务端或客户端能确认协议限制时提示 HTTP 受限。普通连接失败无法确定原因时，提示检查地址、端口和网络。

## 7. 给另一个项目的实施要求

> 请以本规范为参考，为本项目交付 Linux amd64/arm64 的预构建发布包及 SHA-256、交互式和无人值守安装器、systemd 服务、无参管理菜单和脚本可调用的子命令。独立保存程序版本、配置、数据及更新器状态。后台支持正式包在线准备和手动上传，准备完成后由管理员确认重启，校验目标版本及业务入口，失败时恢复旧程序。项目名、路径、健康接口、账号操作和监听端口按本项目实现。登录、连接和运维失败时显示具体原因及下一步。Git 源码构建、发布授权 CLI、HTTPS 反代按实际需求接入。交付时提供具体安装命令、升级和恢复文档，以及目标 Linux 上的验收记录。

## Codexer 源码入口

- 安装及远程引导。[install.sh](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/install.sh) · [bootstrap.sh](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/bootstrap.sh)
- 管理菜单、配置和 systemd 服务定义。[cli.go](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/internal/management/cli.go) · [config.go](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/internal/management/config.go)
- 后台上传、更新状态和受信任更新器。[update_upload.go](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/apps/relay/update_upload.go) · [updates.go](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/apps/relay/updates.go) · [updater.go](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/internal/management/updater.go)
- CI 发包和本机发布。[release-server.yml](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/.github/workflows/release-server.yml) · [package-server.mjs](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/scripts/package-server.mjs) · [本机发布工具](https://github.com/bunnya33/codexer/blob/f1baa4482f7478aed97e7bda019429c5adfb8f61/docs/server-deploy.md)
