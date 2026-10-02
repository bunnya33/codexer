# 服务器一键安装

Relay、React Native Web 控制端和 React 管理后台同时安装。生产只运行一个 Node/Fastify 进程，不运行 Expo/Vite 开发服务器。PC Electron 安装包单独交给 PC 用户。

## 现在可用：本地发布包

开发机执行 `npm run build:server` 和 `npm run package:server`，得到 `release/codexer-server-0.2.0.tar.gz` 及 `.sha256`。把两份文件上传到自己的 Linux 服务器，在文件所在目录运行：

```bash
sha256sum -c codexer-server-0.2.0.tar.gz.sha256
tar -xzf codexer-server-0.2.0.tar.gz
cd codexer
sudo bash install.sh
```

最后一条就是交互式一键安装命令：输入服务器访问地址后自动处理运行环境、服务和网页。无需上传到 GitHub，也无需服务器重新构建前端。发布包依赖安装仍需能访问 npm；系统缺少 Node 时还需访问 NodeSource。

无交互安装命令如下。`203.0.113.10` 是保留示例 IP，必须替换为自己的地址：

```bash
sudo env CODEXER_PUBLIC_URL=http://203.0.113.10:8899 bash install.sh
```

首次管理员账号密码在安装结束时显示，配置保存于权限受限的 `/etc/codexer/relay.env`。使用 `http://你的地址:8899/admin/` 登录后台；控制端是 `http://你的地址:8899/`。防火墙和云安全组需放行选定端口。普通账号在管理后台创建。

## 源码目录安装

在服务器上已有本项目源码时，在根目录运行同样的 `sudo bash install.sh`。没有 `server-bundle.json` 的源码安装会执行锁定依赖安装、TypeScript 编译、Expo Web 导出和 React Admin 构建，然后部署。服务器构建通过 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过 Electron 下载。

要求 Linux x86_64/aarch64、root、运行中的 systemd、至少 1 GiB 空间及所列系统工具。已有 Node >=22.13 和 npm 可直接使用；否则 apt/dnf 系统自动安装 Node 24。不支持在没有 systemd 的容器里运行此安装器。低内存服务器建议使用已构建发布包。

## 从当前仓库远程一行安装

源码仓库为 `https://github.com/bunnya33/codexer.git`，默认分支为 `main`。从源码安装：

```bash
curl -fsSL https://raw.githubusercontent.com/bunnya33/codexer/main/bootstrap.sh | sudo env CODEXER_REPO_URL=https://github.com/bunnya33/codexer.git CODEXER_REF=main bash
```

服务器发布包目前保留在本地；将包与校验文件发布到 GitHub Release 后，可使用下面的方式。`v0.2.0` 下载地址是预定的发布位置，尚未发布时不可使用；SHA256 必须填写对应实际文件的校验值。

```bash
curl -fsSL https://raw.githubusercontent.com/bunnya33/codexer/main/bootstrap.sh | sudo env CODEXER_ARCHIVE_URL=https://github.com/bunnya33/codexer/releases/download/v0.2.0/codexer-server-0.2.0.tar.gz CODEXER_ARCHIVE_SHA256=替换为64位校验值 bash
```

需要无人值守时再传 `CODEXER_PUBLIC_URL`。bootstrap 必须明确提供 `CODEXER_ARCHIVE_URL` 或 `CODEXER_REPO_URL`。私有仓库建议使用本地上传发布包，不把访问凭据写入公开命令。

## 安装内容和路径

| 项目 | 位置 |
| --- | --- |
| 程序版本 | `/opt/codexer/releases/<版本-标识-时间>` |
| 当前版本软链接 | `/opt/codexer/current` |
| 配置 | `/etc/codexer/relay.env`，root:codexer 0640 |
| PGlite 数据 | `/var/lib/codexer/relay`，codexer 0700 |
| 服务 | `codexer-relay.service`，专用系统账号运行，开机自启 |
| 管理入口 | `/usr/local/bin/codexer` |
| 控制端/后台资源 | 当前版本的 `apps/web/dist` / `apps/admin/dist` |

安装器先完整构建/准备版本，再切换 current，检查管理员登录和两个 HTML 入口，并注销验收会话。切换失败恢复原程序、配置及服务状态；数据库内容不作自动回滚。旧 PM2 迁移只处理确认属于本项目的实例，目录或端口冲突会中止。

## 日常管理

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

不带参数显示数字菜单。`password` 修改管理员密码；`users` 是交互账号菜单。密码重置会撤销受影响账号的现有会话，控制端和 PC 需要重新登录。修改端口后同步调整防火墙和客户端。

## 更新与回退

已有服务器先使用 `0.2.0` 发布包/源码运行一次 `sudo bash install.sh`，保留配置和数据，并部署 `codexer-updater.service` 与 timer。之后可以从后台版本入口一键更新或开启自动安装，见 [服务器更新](server-update.md)。Docker/源码运行的服务使用外部更新流程。更新前按 [运维文档](operations.md) 停服备份；保留至少一个旧 release。

验收失败时安装器自动恢复程序与配置。手动回退先停服，把 current 指回**实际存在**的旧版本，再启动并检查：

```bash
sudo systemctl stop codexer-relay
sudo ln -sfn /opt/codexer/releases/替换为旧版本目录 /opt/codexer/current
sudo systemctl start codexer-relay
sudo codexer status
```

数据库升级后的旧程序兼容性需要确认；必要时使用匹配的停服备份恢复，不能仅替换程序。

## HTTPS 和 Docker

systemd 一键安装目前直接提供 HTTP 根地址，不自动配置证书。公网推荐 [Docker + Caddy](operations.md)，统一服务仍只运行一份，Caddy 提供 HTTPS/WSS。已有反向代理的 systemd 部署需增加 HTTPS 来源并保留本机端口配置，详见运维文档。

本次未登录或修改真实服务器，没有声称生产安装已完成。部署后的检查见 [验证范围](validation.md)。
