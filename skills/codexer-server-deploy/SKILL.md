---
name: codexer-server-deploy
description: 发布 Codexer 服务器和各端安装包，使用本机加密的专用网页授权上传、安装服务器更新并核验结果。仅要求发布服务器更新包时不安装生产服务器。
---

使用仓库中的 `npm run server:deploy -- ...`。当前目录不是 Codexer 仓库时，读取本技能安装器生成的 `workspace.json`，在其中的 `repository` 目录执行。先读仓库 `AGENTS.md`、`docs/server-deploy.md`；正式发布参考 `docs/release.md` 和发布工作流。

## 按请求确定目标

- “发个服务器更新”“发布更新包”：发布正式 Release，不据此安装生产服务器。
- “更新到服务器”“帮我安装服务器更新”：授权上传、准备、重启和核验；已有明确授权则直接继续，无须重复询问。
- 客户端安装包仅在用户要求的产品/平台范围内构建或上传，上传不等于安装到所有设备。
- 登录、预检和创建本工具不意味着现在就部署。

## 专用网页授权

先运行 `npm run server:deploy -- status`。旧管理员会话不能作为新版发布凭据；服务器须先手动升级到支持发布授权的版本（0.3.55 起）。

需要授权时运行 `npm run server:deploy -- login --url <服务器根地址>`。将输出的真实服务器 `/admin/?publish=...` 地址打开给用户，核对电脑名称、验证码和权限，由用户在网页登录并批准。工具自行接收并加密保存授权。只在网页输入密码，不读取浏览器登录存储，不输出或解密展示凭据，不再启动本地密码表单。

远程必须 HTTPS；无域名时参考仓库 `docs/publishing-https.md` 的 SSH 回环隧道方案，不改用公网明文 HTTP。默认四项权限可发布服务器和全部客户端，也可按本次长期需求缩小 `--scopes`。后台“发布授权”可随时撤销。当前 CLI 的加密存储在 Windows，发布 macOS 安装包不代表工具已支持 macOS 本机存储。

授权过期、撤销、刷新凭据重用、未知刷新响应时停止重复刷新，重新网页授权或检查后台。遇到 profile 锁先核对原进程是否仍在运行，不自动抢锁。

## 发布服务器

保持主目录 main 约定并保留无关改动。完成检查、版本递增、提交和正式发布；等待工作流成功，核对固定仓库 `bunnya33/codexer` 的 tag、源码提交、正式包和同名 SHA-256。不要将本地构建描述成已发布。

按 status 的平台下载正式服务器包和校验文件到本机，由本机上传，避免生产服务器依赖 GitHub 下载。

```text
npm run server:deploy -- deploy --archive <正式包绝对路径>
```

核对地址、from/to 版本、平台和摘要。用户已要求安装该服务器时加 `--apply`，跟进到工具退出。只有任务成功、当前版本、health 和发布身份均核验后才报告安装完成。工具只重启同一上传任务一次；本地回执完全匹配时可接续，出现 failed、rolled-back、任务更换或不明结果时先查 status，不盲目重复上传/重启。

## 发布客户端

读 `docs/client-updates.md`；Android 同时读 `docs/android-signing.md`，沿用现存正式签名，不生成替代密钥。先完成对应产品的原生编译和必要验收。

```text
npm run server:deploy -- publish-client --target <目标> --archive <安装包绝对路径>
```

根据 docs/server-deploy.md 选择八种 target 之一。Android 从实际 APK 验证版本、versionCode、包名和正式证书。其他端核对本次原生构建记录、架构、签名和版本。先预检，用户已要求上传后加 `--apply`；核对响应 SHA-256 和客户端目录。Windows Agent 安装版同时同步旧兼容通道，部分成功时检查后补齐剩余通道，不重复打包或覆盖较新版本。

最终分别报告正式发布、服务器安装、客户端上传与本机安装的实际结果，给出可用产物链接。账号、凭据、锁和任务回执留在本机，不提交 Git。
