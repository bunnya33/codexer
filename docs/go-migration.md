# Go 服务器迁移（0.3.0）

目标是降低常驻内存，并交付一个能独立运行的执行文件。Relay、后台 API、网页托管、账号管理 CLI 和升级器全部由 Go 实现。网页继续使用 React/React Native 的现有界面，PC Agent/Electron 与手机端保持各自 JavaScript 技术栈。

## 交付与存储

`codexer` 内嵌 Web/Admin 和预览浏览器资源。Release 运行不需要 Node/npm、Go 工具链或独立数据库进程。Linux/macOS 各提供 amd64/arm64 包，Linux 用纯 Go SQLite，可交叉编译而无需 C 工具链。

默认存储从 PGlite 改为 SQLite WAL，保留可选外部 PostgreSQL。账号和密码哈希、设备 ID、会话哈希、快照/事件、图片、微信加密绑定/密钥、通知设置、目标和收发队列继续保留。pending 指令在重启后标为 unknown，避免把未知结果当成成功。

首次读取旧 PGlite 数据需要旧安装的 Node/PGlite 驱动，这是受控的一次性导入。新发布包不包含该依赖；导入读取旧库的完整备份，以事务写入临时 SQLite，成功后原子安装新文件。检测到旧库而未转换时拒绝初始化空库。外部 PostgreSQL 的旧字段、登录索引和完整快照使用原生 SQL 升级，快照拆分具有事务回滚。

## 功能回归对应关系

旧 Node 实现与其专用内部测试已移除。测试移到 Go 实现旁边，客户端与 PC Agent 的端到端测试仍在 `tests/`，通过测试驱动连接真实 Go HTTP/WebSocket 服务；测试驱动不会进入发布包。

| 旧测试组 / 功能 | 当前验证 |
| --- | --- |
| scheduler / concurrency | `TestParallelLanesAndRevocationBarrier`、`TestFIFOCommandsBeforeMaintenance`、连接关闭测试及现有 Agent 联调 |
| broadcast | `TestBroadcastIsolationBackpressureAndSingleEncoding`、订阅上限/断开清理、客户端同步测试 |
| maintenance | 每批/轮次预算、取消、pending 通知和指令幂等保留；到期删除再次检查条件 |
| metrics | 管理员鉴权、实际 RSS/CPU、查询/事件/事务/清理计数、无账号或 SQL 内容泄露 |
| sync-storage | 单会话写入、序号冲突回滚、epoch 替换、会话上限与删除、重放；PostgreSQL 旧快照原子迁移 |
| session-policy | 原生与真实 HTTP/WS 测试，用户活动续期、心跳不续期、Agent 独立有效期、过期登录不复活 |
| install-config / server-config / service | Go 配置、来源/端口校验、管理员密码、无 Node systemd 入口；安装脚本语法检查 |
| server-updates / git-updates | Release/Git 列表与缓存、步骤/重试/管理员权限、受限请求、下载主机、PAX/穿越拒绝、激活回退及固定非 root 构建 |
| Weixin | 扫码/验证码、账号隔离、共享 bot 拒绝、AES-GCM 兼容、无损消息 ID、重复/过期/冒充回复、稳定重试 ID、送达后回复目标、通知开关、待发送保留与事务回滚 |
| old account / PGlite migration | 原生全表导入/失败回滚测试，并实际运行旧 PGlite 到 Go 的完整合成库导入；旧 Node scrypt 与指令哈希固定样例 |
| history / images / files / previews | 原有客户端和真实 Agent 联调；网页改写/browser runtime、受限 cookie、资源、SSE、WebSocket、取消、配额和错误 |

Go 保留旧指标响应的 eventLoop 字段以兼容客户端，但明确返回 `monitoring:false`；Go 不存在 Node 的事件循环指标。新增 goroutine 数，RSS 与累计 CPU 来自实际进程。

## 内存实测

2026-10-11，在同一台 Apple Silicon Mac 上，用隔离的空数据库分别启动 v0.2.10 Node 服务和 Go 0.3.0。两者开启默认微信服务、使用同样的 Web/Admin 页面，先访问两个页面和健康接口，预热 5 秒，再每秒采样一次 RSS 共 30 次。

| 服务 | RSS 中位数 | 范围 |
| --- | --- | --- |
| Node 0.2.10 + PGlite | 697.17 MiB | 637.75–785.80 MiB |
| Go 0.3.0 + SQLite | 51.83 MiB | 51.66–52.00 MiB |

这次空闲基线约降低 92.6%。差异同时包含服务器语言与内置数据库实现的变化；它不是生产负载或多设备压力测试，不代表所有部署都达到相同比例。图片/快照/预览负载仍会增加内存，连接缓冲与传输均有预算限制。

## 验证范围

本机完成 Go 原生测试、并发检查、现有前端/Agent 回归（41 个测试文件、266 项）、真实 PostgreSQL 隔离库测试，以及真实旧 PGlite 完整合成库导入。正式构建在独立目录仅复制执行文件、PATH 不提供 Node 或工具链的条件下，通过健康检查、两个网页入口及其 JS/CSS 资源、管理员登录、控制账号创建、Agent 登录、重启持久化和原生管理命令检查。

Linux 安装器的真实 systemd 部署、Linux Docker 运行、Intel Mac 实机及真实生产账号/微信/服务器仍需目标环境验收。此次代码迁移不等于已经部署到生产服务器。安装与旧库备份流程见 [服务器安装](server-install.md) 和 [运维](operations.md)。
