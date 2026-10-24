# 2026-10-24 主分支整合

本轮以远端 `a0e57f1` 为基线。最终源码版本：服务器 `0.3.26`、Codexer Agent `0.2.11`、Codexer Control `0.2.11`、手机控制端 `0.1.2`（Android versionCode 3）。源码版本与已发布安装包分别记录；本轮不创建服务器 Release 或替换运行中的客户端。

## 最终架构

Windows/macOS 连接器统一为 Electron 的 Codexer Agent；控制端统一为 React Native 原生宿主的 Codexer Control。沿用远端的新名称、各自图标、凭据迁移、设备身份、启动项迁移和安装包命名修复。约定见根 AGENTS.md 和 [桌面架构](desktop-native.md)。

## 分支取舍

| 来源 | 整合结果 |
| --- | --- |
| `codex/share-web-previews` | 已在远端主分支，包括分享有效期、音频下载、设备管理、资源仪表盘、会话 ID、Agent 版本和压缩会话恢复 |
| `codex/native-windows-control`、`codex/control-skins`、各滚动修复分支 | 已在远端主分支，保留最新原生适配、三种皮肤、队列编辑及滚动修复 |
| `codex/android-apk`、`codex/android-style-parity` | 合并打包配置、原生强度滑块、安全区域与键盘布局、取消过时请求；保留主分支后续新增功能 |
| `codex/fix-headless-workspace-roots` | 把已验证的 session metadata 根目录回退适配到当前 JSONL/Zstd/竞态读取实现；显式 turn 根目录仍优先 |
| 旧工作区未提交源码 | 补齐后台 Agent 登录时长/永不过期、CLI 服务端有效期校验、旧 Electron 控制端托盘/退出确认和窗口销毁清理；保留新版名称 |
| `local-legacy-before-v0.2.2` | 历史架构存档，不把被重写取代的整套旧代码合回当前主分支 |

旧工作区文件及其未提交差异已先作独立备份，原工作区保持不动。旧 `docs/rebuild` 是固定在 `0.2.2` 的历史复原资料，保留在原工作区和备份中，不当作当前实现说明；自动生成的 Windows autolink 文件不作为功能改动提交。

## 本轮补齐的预览修复

滚动只展示入口，主动打开后运行；每个客户端只运行一个主动预览，内嵌高度最多 480px。重复尺寸通知不再转发，原生内部 iframe 跟随宿主视口，不再重复撑高。浏览器刷新沿用标签页标识并替换旧连接，90 秒租期回收异常退出遗留的地址和传输。公开分享保留既有有效期和访问语义。实际手机浏览器的进程崩溃尚未在原设备复现；这些修改针对已复现的连接累积和高度增长。

验证记录见 [验证说明](validation.md)。
