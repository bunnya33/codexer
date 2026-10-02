# 服务器更新

服务器 `0.2.0` 增加管理后台的版本检查、一键安装和可选无人值守更新。统一更新 Relay、Web 和 Admin；不更新 PC 连接器或手机 App。

## 使用

1. 已有 systemd 部署先用新版安装器升级一次，安装更新服务和定时器。仅替换网页不能启用更新器。
2. 点击后台左上角版本徽标：绿色表示已检查且无新版本；橙色动画表示有新版本；灰色表示未知、检查失败或暂无可安装 Release。
3. 点击“立即更新”并确认。约 30 秒内开始下载、校验、安装依赖，最后短暂重启。后台轮询状态；连接恢复后显示最终结果。
4. 如需无人值守更新，在“系统设置”开启“自动安装稳定版本”。默认关闭，每 6 小时检查一次，重启 Relay 时也检查。失败/回退后不自动重复安装，需管理员排查后手动重试。

版本元数据缓存 20 分钟，“重新检查”绕过缓存。GitHub 网络/限流错误单独显示，保留之前的版本信息；检查失败时禁止安装。没有 Release 或缺少服务器资产时也不能安装。提交更新后关闭浏览器不影响更新任务。

## 部署与权限

| 项目 | 位置/行为 |
| --- | --- |
| Relay | 仍以 codexer 用户运行，保持 systemd 文件系统限制 |
| root 更新器 | `/usr/local/lib/codexer-updater/`，root 所有；不从 Relay 可写目录执行代码 |
| 请求/自动设置 | `/var/lib/codexer-updater/inbox/`，codexer 可写，只接收严格版本 tag 和任务 ID |
| 状态/回退日志 | `/var/lib/codexer-updater/status.json`、`rollback.json`，root 所有；后台仅可读状态 |
| 定时器 | `codexer-updater.timer`，约每 30 秒处理一次请求 |
| 更新互斥 | 与安装器共用 `/run/codexer-install.lock`；不依赖删除锁文件解锁 |
| 程序/数据 | `/opt/codexer/releases`、`current`；保留 `/etc/codexer/relay.env` 与数据库目录 |

下载仅接受固定仓库的稳定 Release 和 GitHub 资产主机，限制跳转与大小。SHA-256 校验匹配后才解压；拒绝绝对路径、路径穿越、符号/硬链接和设备条目。依赖安装忽略 lifecycle scripts。切换前记录 root 所有的回退日志，失败恢复之前的程序链接并重新启动；激活时断电/进程中断由下次更新服务运行恢复。

此回退仅恢复程序，不恢复数据库；发布版本的数据迁移必须兼容旧程序。`0.2.0` 保留旧表和数据，迁移账号唯一索引以允许两类账号同名；创建同名账号后，不能把手动回退到 `0.1.0` 当作完整数据库回退，因为旧版登录不区分账号类型。跨这一边界需匹配的停服备份。更新器本身的协议/权限修改需重新运行安装器，不能由 Relay 提交自定义脚本或替换 root helper。

Linux x64/arm64、Node >=22.13、systemd 安装器部署可启用安装功能。Docker 不挂载 Docker socket，也不授予容器主机管理权限；在服务器更新源码后执行原 Compose 构建命令。源码开发和其他部署只检查版本，不能在后台直接安装。

## Release 要求

固定仓库 `https://github.com/bunnya33/codexer` 的最新稳定 Release 必须使用 `vX.Y.Z`，且版本等于根 `package.json`，包含：

```text
codexer-server-X.Y.Z.tar.gz
codexer-server-X.Y.Z.tar.gz.sha256
```

`npm run build:server && npm run package:server` 生成包和校验文件。新增 `.github/workflows/release-server.yml`：维护者推送匹配版本标签后运行测试/构建，并创建 Release 上传两个资产。仅推送源码 main 不会创建 Release；本次未替维护者发布标签或 Release。

例如完成版本审查后，维护者可执行 `git tag v0.2.0`、`git push origin v0.2.0` 触发发布。GitHub Actions 需允许工作流写仓库内容。草稿、预发布和没有匹配资产的版本不会安装。

## 故障排查

```bash
sudo systemctl status codexer-updater.timer codexer-updater.service
sudo journalctl -u codexer-updater.service -n 100 --no-pager
sudo cat /var/lib/codexer-updater/status.json
```

排队不开始：检查定时器是否启用、另一个安装器是否持锁；下载失败：检查 GitHub/ npm 网络与磁盘空间；`checksum-mismatch`：停止安装并核对 Release 文件；`rolled-back`：查看 Relay 启动日志；`rollback-health-failed`：检查原版本服务并人工恢复。程序版本在启动健康检查通过前不会显示成功。

更新服务安装需运行新版安装器，方法见 [服务器一键安装](server-install.md)。本机验证范围见 [验证范围](validation.md)。
