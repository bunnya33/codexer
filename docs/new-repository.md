# 干净源码导出与仓库初始化

不要把当前目录连同 `.git` 复制后当新仓库上传：旧历史可能携带不应公开的配置。使用本地安全导出：

```bash
npm run check:docs
npm run export:source
```

脚本在 `release/codexer-source-0.1.0` 创建干净目录，并生成源码 tar.gz/校验文件。明确导出应用/包/测试/脚本/文档及配置模板；排除 `.git`、`.local`、node_modules、各 dist/release、真实 `.env`、旧 JSON 验证数据。脚本不初始化 Git、不建立远端、不上传。

打开导出目录检查文件，尤其新增配置或样例；构建和测试的新结果见 [验证范围](validation.md)。当前源码仓库是 `https://github.com/bunnya33/codexer.git`，默认分支 `main`。bootstrap 通过 `CODEXER_REPO_URL`/`CODEXER_REF` 或 `CODEXER_ARCHIVE_URL` 读取地址；源码安装命令见 [服务器安装](server-install.md)。

即使复用已清空的仓库地址，也应把干净导出复制到独立目录后执行 `git init -b main`，再创建唯一的初始提交并添加远端。不要在旧工作区直接推送分支或 tags；推送前用 `git ls-remote` 确认目标为空，使用普通的 `git push -u origin main`，不用强制推送。

真实服务器地址留在部署配置，密钥留在平台秘密配置。安装包放 Release 或自己的文件服务器；服务器发布包及 `.sha256` 另行发布，不随源码提交。

新仓库只会有导出的当前源码；该过程不会清理、改写或上传旧仓库历史。旧配对入口、Node 源码启动器和历史 JSON 调查材料已从源码目录清除，保留边界见 [目录清理](cleanup.md)。
