# 安全与配置

## 账号和任务权限

Relay 账号控制远程访问，官方 Codex 账号/模型密钥控制本机执行。PC 和控制端同账号登录才可访问设备；管理员管理账号，不自动获得他人的电脑权限。

密码由 Relay 使用加盐 scrypt 哈希；七天会话以哈希存储。改密或禁用撤销该账号全部会话，退出只撤销当前会话。Agent 会话绑定单台设备，WebSocket ticket 短期且一次性。使用 HTTPS/WSS 保护账号、会话和任务内容。

任务沿用官方 Codex 的本机权限与审批。程序不修改官方应用文件，不公开官方 IPC/App Server 端口，不复制用户 API key 到 Relay。具体适配仍是实验性兼容层。

## PC 安全存储与进程边界

Electron 主进程使用 safeStorage：Windows 系统 DPAPI，macOS Keychain。`session.enc` 是加密会话，密码只在登录操作中暂存；存储不可用时拒绝登录持久化。读取失败需重新登录，不回退明文。

React 窗口启用 sandbox、contextIsolation、禁用 nodeIntegration；preload 仅开放固定的账号/连接/设置/诊断 IPC。主进程检查 sender/frame，设置用 schema 校验，拒绝任意导航/弹窗/权限申请。渲染器 CSP 禁止网络连接；网络与会话留在主进程/Agent。

设置只保存服务器、账号名称、设备名、目录和偏好。普通导出诊断不会包含这些字段、会话或密码。日志只接收符合格式的诊断代码，原始 adapter stdout/stderr 不转发到 UI。退出登录也保留本机任务所需的暂停 Agent，直到任务结束或用户退出程序。

原生控制端使用 SecureStore；Web 和后台采用互相独立的 sessionStorage。浏览器存储不是操作系统凭据库，因此部署还应防止网页脚本注入并使用 HTTPS。服务器的初始化管理员配置是敏感文件，即便密码使用 Base64 编码，也不是加密。

## 源码、文档和发布包

不在源码、示例、文档、测试中写真实部署 IP、域名、密码或 session；示例使用 `example.com`/`.example`、127.0.0.1 或 RFC 5737 保留 IP。仅在本机忽略的配置输入真实地址。

`.local`、`.env`、构建产物和安装包被 Git 忽略。服务器打包和新仓库导出使用明确清单，排除 `.git`、本地配置、旧私有历史和历史 JSON 验证数据。`npm run check:docs` 检查文档链接及示例 IPv4；仍需发布前人工审核文件清单，特别是新增脚本/样例。

源码发布从干净导出创建新的 Git 根提交；旧工作区历史不会随导出进入新初始化的仓库。本地备份仅用于回退，旧公开信息的撤销或历史处理由仓库所有者处理。
