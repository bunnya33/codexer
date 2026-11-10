# 服务器更新

需要让 Codex 通过服务器网页授权后直接上传并安装更新，可使用[本地升级工具与 Skill](server-deploy.md)，复用本文的上传、准备、重启和回退接口。

管理后台支持 **Release 包更新** 和 **Git tag · 服务器构建**，统一更新 Relay、Web 和 Admin。先准备新版本，再由管理员在后台确认重启，或明确要求本地升级工具执行重启，才切换程序。下载、拉取或构建期间旧服务继续运行；不更新 PC 连接器或手机 App。

## 手动上传服务器包（0.3.39）

服务器访问 GitHub 不稳定时，可在能下载文件的电脑上取得 Release 中与服务器平台匹配的 `codexer-server-X.Y.Z-linux-amd64.tar.gz`（或 `linux-arm64`）及同名 `.tar.gz.sha256` 文件。在“系统设置 → 服务器更新 → 手动上传服务器更新包”选择或一次拖入这两个文件，版本与平台自动识别，无需手填。

点击“上传并准备更新”后，后台显示上传进度，允许取消并重试。服务器流式保存、核对 SHA-256、包内版本／平台／Go 运行时和完整压缩包结构，只允许高于当前版本且适合本机的包，最大 256 MiB。失败或中断不会发布残缺包。上传者须为有效管理员，完成时再次检查登录；与其它上传、在线更新、更新方式切换互斥。

约 30 秒内 root 更新器复制到受保护的暂存目录，再核对大小、SHA-256、版本及平台，然后解包准备。上传任务使用独立的 `upload` 请求与暂存记录，准备、状态轮询和确认重启不需要 GitHub；不改变原有 Release/Git 设置。准备完成后仍须点击“立即重启 → 确认重启”，沿用启动检查和程序回退；等待重启时切换更新方式不会把上传包变成 Git 构建任务。普通在线版本检查仍可手动发起。

**首次启用需要升级 root 更新器**：仅通过旧更新器替换 Relay 程序，不会升级 root helper。将 `0.3.39` 或更新的正式服务器包及校验文件传到服务器，核对并解压后，在包内运行一次 `sudo bash install.sh`，保留既有配置、账号与数据。此安装过程会重启服务，无需从 GitHub 下载 Go 程序或安装 Node；之后即可使用后台上传。旧更新器显示明确提示并禁用上传，Docker／源码部署继续在外部更新。

接口：`PUT /v1/admin/system/update-package?name=包名&sha256=64位小写摘要`，管理员认证，原始二进制正文。响应为 `source: upload`、`method: upload` 的排队任务；重启沿用 `POST /v1/admin/system/update`，提供 `tag`、`action: restart` 和原 `jobId`。版本信息新增 `uploadSupported`、`uploading` 和 `platform`，旧更新器不会被误报为支持上传。

## 使用

1. 已有 systemd 部署先用新版源码或发布包运行一次 `sudo bash install.sh`，安装原生更新器和更新服务。若需要 Git 构建，预先准备构建工具并设置 `CODEXER_GIT_UPDATES=1`，安装器会创建专用构建账号。安装器本身会重启服务，建议在维护时间运行；此后后台更新使用分步流程。仅替换网页不能更新 root helper，旧 helper 会禁用后台安装按钮，避免旧程序自动重启。
2. 点击后台左上角版本徽标：绿色表示已检查且无新版本；橙色动画表示有新版本；灰色表示未知、检查失败或暂无可安装 Release。
3. 默认 Release 方式点击“立即更新 → 确认更新”。约 30 秒内开始下载、SHA-256 校验、解压及检查执行文件，不切换程序、不重启服务。
4. 准备好后显示“立即重启”，可关闭页面或稍后回来，状态会保留。点击“立即重启 → 确认重启”才激活版本。后台轮询状态，连接恢复后显示最终结果。
5. “自动准备稳定版本”默认关闭，每 6 小时及 Relay 启动时检查。开启后只自动执行第 3 步，仍需手动确认重启；兼容原 `autoInstall` 设置，但不再自动重启。失败/回退后不自动重复尝试，等待重启的版本也不会被定时检查覆盖。

版本元数据缓存 20 分钟，“重新检查”绕过缓存。GitHub 网络/限流错误保留旧版本信息并显示 warning，不能据此准备新版本；已准备好的构建/重启可继续。Release 缺少服务器资产时不能下载。关闭浏览器不取消后台任务，也不会自动进入下一步骤。

## Git tag · 服务器构建

1. 在“系统设置 → 服务器更新”选择 **Git tag · 服务器构建**，切回 **Release 包更新** 也在同一处操作。
2. 打开左上角版本弹窗，选择“目标 tag”。列表来自固定仓库最近 100 个 tag，只保留 `vX.Y.Z`，只能更新到高于当前程序的版本；不接受 main、任意分支、仓库地址或命令。
3. 点击“更新 → 确认更新”：浅拉取指定 tag，解析并检出实际 commit，检查根 `package.json` 版本与 tag 相同。记录 commit，保留独立的原始源码快照，后续构建不受远端 tag 移动影响。
4. 拉取后按钮变成“构建”。点击“构建 → 确认构建”：安装锁定的开发依赖，编译 Go Relay、导出 Expo Web、构建 React Admin 并生成单文件服务器包。
5. 构建后按钮变成“立即重启”。点击并确认后才切换程序、重启及检查健康状态。

构建失败可重试，从保留的原始源码重新准备干净工作目录。刷新页面保留步骤，处理中禁用重复操作及更新方式切换；等待构建/重启时可以切换方式或选择其他 tag，旧产物不会因此激活。同种方式下一次准备版本时清理被替代的暂存产物。Git 模式禁止自动准备、构建和重启。

Git 不依赖 Release 资产，适合已发布稳定 tag 但没有服务器包的版本。构建机需安装 Go >=1.26、Node >=22.13、npm 和 Git，并能访问 GitHub、Go 模块镜像和 npm，建议至少 2 GiB 内存和 4 GiB 可用空间；构建进程组运行时限 30 分钟。小内存服务器优先用 Release 包。固定仓库和版本校验不因后台切换而改变。

升级本次安装器的一行命令：

```bash
curl -fsSL https://raw.githubusercontent.com/bunnya33/codexer/main/bootstrap.sh | sudo env CODEXER_REPO_URL=https://github.com/bunnya33/codexer.git CODEXER_REF=main bash
```

沿用原服务器地址、账号和数据。首次安装和本地包方法见 [服务器一键安装](server-install.md)。

## 部署与权限

| 项目 | 位置/行为 |
| --- | --- |
| Relay | 仍以 codexer 用户运行，保持 systemd 文件系统限制 |
| root 更新器 | `/usr/local/lib/codexer-updater/`，root 所有；不从 Relay 可写目录执行代码 |
| 构建账号 | `codexer-builder`，无登录 shell；使用 systemd 临时构建服务，禁止提权并隐藏配置、数据库和更新状态 |
| 请求/自动设置 | `/var/lib/codexer-updater/inbox/`，codexer 可写；上传包只按任务 UUID 命名，不接受自定义文件路径或命令 |
| 状态/暂存记录 | `status.json`、`git-stage.json`、`release-stage.json`、`upload-stage.json`、`rollback.json`，root 所有；后台仅可读状态 |
| 定时器 | `codexer-updater.timer`，约每 30 秒处理一次请求 |
| 更新互斥 | 与安装器共用 `/run/codexer-install.lock`；不依赖删除锁文件解锁 |
| 程序/数据 | `/opt/codexer/releases`、`current`；保留 `/etc/codexer/relay.env` 与数据库目录 |

下载仅接受固定仓库的稳定 Release 和 GitHub 资产主机，限制跳转与大小。SHA-256 校验匹配后才解压；拒绝绝对路径、路径穿越、符号/硬链接和设备条目。服务器包使用统一 PAX 格式，兼容 GNU tar、bsdtar 和长 UTF-8 文件名。Git 使用固定远端与完整 tag ref，禁用 hooks；源码构建脚本以受限账号运行，只能写指定工作目录，超时终止整组进程。Expo 设置与 npm 缓存留在构建目录，不读取用户主目录。前端构建依赖安装忽略 lifecycle scripts；发布包不安装 Node 运行依赖。确认重启后才记录回退日志并激活，失败恢复之前的程序链接；激活中断由下次更新服务运行恢复。

首次从 Node/PGlite 升级到 Go 需运行新安装器，旧 Node helper 不认识 Go 包格式。Go 使用 SQLite 的发布版本之间可按更新器流程准备和重启。回退到 Node 版本需恢复对应停服旧库备份。

此回退仅恢复程序，不恢复数据库；发布版本的数据迁移必须兼容旧程序。`0.2.0` 保留旧表和数据，迁移账号唯一索引以允许两类账号同名；创建同名账号后，不能把手动回退到 `0.1.0` 当作完整数据库回退，因为旧版登录不区分账号类型。跨这一边界需匹配的停服备份。更新器本身的协议/权限修改需重新运行安装器，不能由 Relay 提交自定义脚本或替换 root helper。

Linux amd64/arm64、systemd 安装器部署可启用发布包更新，无需 Node；Git 构建需要单独准备构建工具。Docker 不挂载 Docker socket，也不授予容器主机管理权限；在服务器更新源码后执行原 Compose 构建命令。源码开发和其他部署只检查版本，不能在后台直接安装。

## Release 要求

固定仓库 `https://github.com/bunnya33/codexer` 的最新稳定 Release 必须使用 `vX.Y.Z`，且版本等于根 `package.json`，包含：

```text
codexer-server-X.Y.Z-linux-amd64.tar.gz
codexer-server-X.Y.Z-linux-amd64.tar.gz.sha256
```

`npm run build:server && npm run package:server` 生成包和校验文件。`.github/workflows/release-server.yml` 在推送匹配版本标签后运行测试/构建，并创建 Release 上传各架构的包和校验文件。仅推送源码 main 不会创建 Release。

例如完成版本审查后，维护者可执行 `git tag v0.3.0`、`git push origin v0.3.0` 触发发布。GitHub Actions 需允许工作流写仓库内容。草稿、预发布和没有匹配资产的版本不会安装。

## 故障排查

```bash
sudo systemctl status codexer-updater.timer codexer-updater.service
sudo journalctl -u codexer-updater.service -n 100 --no-pager
sudo cat /var/lib/codexer-updater/status.json
# 任务ID替换为 status.json 的 job.id
sudo journalctl -u codexer-build-任务ID.service -n 150 --no-pager
```

排队不开始：检查定时器与安装锁；`git-fetch-failed`：检查 GitHub 网络和 tag；`tag-version-mismatch`：根 package 版本与 tag 不符；`build-command-failed`：检查构建服务日志、npm 网络、内存和磁盘，排查后重试构建；`checksum-mismatch`：核对 Release 资产；`rolled-back`：查看 Relay 启动日志；`rollback-health-failed`：检查原服务并人工恢复。程序版本在启动健康检查通过前不会显示成功。

更新服务安装需运行新版安装器，方法见 [服务器一键安装](server-install.md)。本机验证范围见 [验证范围](validation.md)。
