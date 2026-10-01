# 目录清理与保留说明

2026-10-01 按当前四模块架构核对 npm 命令、源码导入、安装器、文档链接和发布文件。清理仅修改本地工作区；未上传 GitHub，未改写旧 Git 历史，也未清除真实设备凭据或数据库。

## 已删除的源码遗留

| 内容 | 处理与当前替代 |
| --- | --- |
| `start-pc.cmd`、`start-mac.sh`、`scripts/start-pc.ps1` | 删除依赖系统 Node 的旧用户启动器；普通用户使用 Electron 安装包 |
| `scripts/claim-pairing.ts` | 删除只抛出“配对已移除”错误的占位入口 |
| `scripts/pair-pc.ts` | 删除重复登录 CLI；开发统一使用 `npm run dev:agent -- login --username <account>` |
| `scripts/local-token.ts`、`local:account` npm 命令 | 删除打印本地账号密码的旧工具 |
| 未调用的管理员令牌函数、Web 旧令牌恢复/保存函数 | 删除旧认证工具；浏览器仅保留登录/退出时清除旧存储的逻辑，不恢复旧令牌 |
| `docs/*evidence*.json` 共 7 份 | 删除带实际环境信息的历史验证输出；文档保留去环境信息的结论 |
| `apps/mobile/src/admin.tsx` 与其 7 个样式 | 旧内嵌后台已移除，管理入口统一在独立 `apps/admin` |
| Relay 的旧配对表创建/清理代码 | 新数据库不再创建无用配对表；没有执行删除现有数据库表或数据的操作 |
| 安装器的旧令牌文件参数与环境传递 | 删除未被使用的参数，安装器与配置脚本同步调整；保留旧数据库/配置升级逻辑 |

账号实现 `apps/pc-agent/src/pairing.ts` 改名为 `auth.ts`，`tests/auto-pair.test.ts` 改名为 `agent-login.test.ts`，所有当前源码引用已同步。原账号登录实现和验证内容保留。

## 构建与本地文件

服务器使用独立 `tsconfig.server.json`。每次构建先清空根 `dist`，只编译 Relay、6 个安装/运维脚本及其传递依赖；测试、桌面控制台、Agent 和开发验收程序不再进入服务器包。Docker 与源码导出使用同一配置。

服务器打包脚本另有明确文件白名单：只复制 Relay、protocol/shared 和指定的 6 个脚本，即使开发时额外编译过测试或 Agent，也不会将这些产物混入服务器包。

文档目录不作为诊断输出目录。`check:live` 默认写入 `.local/diagnostics/live-evidence.json`；`.local` 被 Git、源码导出和服务器发布排除。已清除 `.local/desktop-work` 内的 Electron 下载 ZIP（约 158 MB），已安装的 Electron 运行文件保留。

清理前的源码和历史输出副本保存在 `.local/cleanup-review/20261001`，用于本次回退；旧工作区改造前的备份仍在 `.local/desktop-work/baseline`。这些副本含本地信息，仅供本地保存，不用于新仓库或发布。

## 仍需保留的内容

| 目录/文件 | 保留原因 |
| --- | --- |
| `apps/pc-agent`、`packages/codex-adapter` | Electron 内置运行与官方 Codex 兼容层仍依赖 |
| `packages/codex-generated` | 官方协议生成类型及其类型引用链，不是另一套客户端实现 |
| React Native 的 `.web.*` 与原生同名文件 | 平台解析使用不同实现，不能按 Windows 当前构建删除原生适配 |
| `scripts/local-services.ts`、`manage-users.ts`、验收/探测脚本 | 维护和开发仍有 npm 入口；不作为最终用户启动方案 |
| `scripts/create-image-fixture.ps1` | 图片验收脚本仍使用对应本地测试图 |
| 旧数据库兼容字段和迁移测试 | 升级保留旧账号/设备内容，同时拒绝旧令牌认证 |
| `.local` 的设备数据、凭据、日志、隔离测试资料与安全调查副本 | 本地运行、回退与调查资料，不能按无用源码一并删除；不进入发布 |
| `node_modules`、各 `dist`、`release`、`output` | 依赖、可重建产物、当前交付文件或本地视觉资料；全部排除于源码导出 |
| `docs/feasibility.md` | 保留官方运行时研究结论与兼容风险，索引标明为历史材料 |

当前源码中已确认废弃的入口和历史输出已清除。本地缓存、运行数据与回退资料的保留不表示它们是产品源码。新仓库应使用 [源码导出](new-repository.md) 的干净目录，而不是复制整个旧工作区。
