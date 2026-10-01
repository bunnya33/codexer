# 文档索引

从 [项目首页](../README.md) 了解项目；按角色选择下面的入口。

## 安装与使用

| 文档 | 内容 |
| --- | --- |
| [服务器一键安装](server-install.md) | 本地发布包、源码、远程引导安装；端口、路径、升级、回滚 |
| [PC 连接器](pc-setup.md) | Windows 安装、账号登录、连接生命周期、设备设置、托盘、诊断 |
| [macOS](mac.md) | 安装、菜单栏、Keychain、程序查找、平台验收 |
| [移动与 Web 客户端](mobile.md) | React Native 共用结构、App 构建、浏览器入口、平台适配 |
| [控制功能](usage.md) | 设备/项目/会话、发送/队列/引导/停止、模型、审批、图片 |
| [管理后台](admin.md) | 创建账号、密码重置、禁用、管理与控制会话隔离 |
| [Relay](relay.md) | Fastify 服务职责、配置、存储、连接和错误处理 |
| [运维与故障排查](operations.md) | HTTPS、备份、账号恢复、服务状态、常见问题 |

## 开发与交付

| 文档 | 内容 |
| --- | --- |
| [架构与功能分工](architecture.md) | 四模块、三交付物、目录、数据流、模块边界 |
| [开发文档](development.md) | 环境、脚本、开发顺序、构建和测试 |
| [接口](api.md) | 登录、账号管理、设备、历史、图片和 WebSocket API |
| [协议](protocol.md) | 状态、epoch/seq、命令幂等与结果语义 |
| [安全与配置](security.md) | 会话、凭据、日志、示例地址、公开文件边界 |
| [发布与打包](release.md) | Windows/macOS、服务器包、App、签名与升级 |
| [干净源码导出](new-repository.md) | 无历史源码导出、检查、仓库初始化与当前地址 |
| [目录清理与保留说明](cleanup.md) | 废弃入口、历史资料、构建范围、仍需保留的文件 |
| [验证范围](validation.md) | 本次检查结果及实机/生产验收范围 |
| [历史可行性研究](feasibility.md) | 官方 IPC/App Server 研究；不代表当前全部平台验收 |

## 模块入口

[控制端](../apps/mobile/README.md) · [PC 连接器](../apps/desktop/README.md) · [Agent 核心](../apps/pc-agent/README.md) · [管理后台](../apps/admin/README.md) · [Relay](../apps/relay/README.md) · [Web 导出](../apps/web/README.md)

端口、账号、服务器安装行为以本次功能文档为准。历史 JSON 验证记录已从源码文档目录清除，诊断报告默认写入 Git 忽略的 `.local`。
