# 服务器安装

从 0.3.0 起，Relay、网页服务和后台 API 全部使用 Go。控制端及后台页面内嵌在一个执行文件中，运行时不需要 Node、npm、Go 工具链或另一个数据库进程。

## 发布包安装

选择与服务器匹配的 Linux 发布包，例如 x86_64 使用 `codexer-server-0.3.1-linux-amd64.tar.gz`，aarch64 使用 `linux-arm64`。上传包及校验文件：

```bash
sha256sum -c codexer-server-0.3.1-linux-amd64.tar.gz.sha256
tar -xzf codexer-server-0.3.1-linux-amd64.tar.gz
cd codexer
sudo bash install.sh
```

安装器要求 Linux、root 和运行中的 systemd，交互输入 HTTP 根地址后安装服务。无交互可执行：

```bash
sudo env CODEXER_PUBLIC_URL=http://203.0.113.10:8899 bash install.sh
```

示例 IP 需替换为自己的地址。首次生成的管理员密码会在安装时显示；配置位于 `/etc/codexer/relay.env`。后台地址是 `/admin/`，控制端是 `/`。防火墙放行选定端口。普通控制账号在后台创建。

Release 安装不安装 Node。若启用 Git tag 在线构建，需要预先安装 Go、Node、npm、Git，并设置 `CODEXER_GIT_UPDATES=1`；构建运行于专用受限账号。

0.3.1 安装器会自动恢复 `codexer` 的执行权限，复制/解压丢失权限时仍直接使用发布包。目录不完整时提示重新解压，不会误要求安装编译工具。已有 0.3.0 包遇到“从源码构建需要 Go”时，先在包目录执行 `chmod 755 ./codexer`，再运行包内 `install.sh`；同时确认 `server-bundle.json` 存在。

## 首次从 Node 升级

0.2.x 的旧 Node 更新器不能直接安装 0.3.0 的 Go 包，须先用新包执行一次安装器。已有配置、账号和设备保留。安装前停止进行中的更新任务，并按 [运维文档](operations.md) 备份。

默认存储由 PGlite 改为 SQLite。安装器停服、复制原数据、生成完整备份，然后用**旧安装目录里现有的 Node/PGlite 驱动**执行一次性导入。旧目录和 `node_modules` 必须保留到导入成功；这不是新服务器的运行依赖。外部 PostgreSQL 沿用 `DATABASE_URL`，无需复制为 SQLite。

直接运行二进制时，可手工迁移：

```bash
./codexer migrate-pglite --legacy-release /旧程序目录 --data-dir /旧数据库目录
```

发现未转换的旧库时，新服务拒绝创建空库。导入失败不会安装部分 SQLite 文件，原库及备份保留。升级回退到 Node 版本时须恢复对应旧数据库备份。详见 [Go 迁移](go-migration.md)。

## 源码构建

构建机需要 Go >=1.26、Node >=22.13 和 npm：

```bash
npm ci
npm run build:server
CODEXER_TARGETS=linux/amd64,linux/arm64,darwin/amd64,darwin/arm64 npm run package:server
```

服务包只包含执行文件、安装脚本、文档和版本标记。Linux 源码目录也可运行 `sudo bash install.sh`，但会在服务器上构建前端和 Go 程序，低内存机器建议用发布包。

从仓库指定稳定 tag 安装：

```bash
curl -fsSL https://raw.githubusercontent.com/bunnya33/codexer/v0.3.1/bootstrap.sh | sudo env CODEXER_REPO_URL=https://github.com/bunnya33/codexer.git CODEXER_REF=v0.3.1 bash
```

此命令需要对应 tag 已发布，并已具备构建工具。bootstrap 也支持明确传入 `CODEXER_ARCHIVE_URL` 和 `CODEXER_ARCHIVE_SHA256` 安装现成发布包。

## 单文件直接运行

macOS 和 Linux 都可解压对应架构的包，仅复制 `codexer` 文件即可：

```bash
RELAY_HOST=0.0.0.0 RELAY_PORT=8787 RELAY_DATA_DIR=./data ./codexer serve
```

首次管理员凭据默认保存在 `.local/relay-admin-account.secret`，也可预设管理员环境变量。打开 `http://localhost:8787/` 和 `/admin/`。数据和微信密钥写入数据目录；执行文件本身不修改。

## 安装路径与管理

| 项目 | 位置 |
| --- | --- |
| 程序 | `/opt/codexer/releases/<版本-标识-时间>/codexer` |
| 当前版本链接 | `/opt/codexer/current` |
| 配置 | `/etc/codexer/relay.env`，root:codexer 0640 |
| SQLite 与微信密钥 | `/var/lib/codexer/relay`，codexer 0700 |
| 主服务 | `codexer-relay.service` |
| 管理入口 | `/usr/local/bin/codexer` |
| 受信任 Go 更新器 | `/usr/local/lib/codexer-updater/codexer` |

```bash
sudo codexer
sudo codexer status
sudo codexer logs
sudo codexer restart
sudo codexer port 8899
sudo codexer password
sudo codexer users
sudo codexer info
```

安装后的无参管理命令打开菜单；独立执行文件无参启动服务。安装验收检查服务、两个网页入口和管理员登录；失败恢复程序、配置、主服务和更新器。数据库内容不自动回滚。

systemd 安装器直接提供 HTTP 根地址；公网 HTTPS 可使用现有代理或 [Docker + Caddy](operations.md)。本文是安装流程，生产部署仍需在目标机器验收。
