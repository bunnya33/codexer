# 客户端更新与设置界面

Codexer Agent 和 Codexer Control 从当前登录的 Relay 获取各自的客户端版本。管理后台的“客户端更新与红点提示”按产品、系统和架构上传安装包，并填写包内的实际版本。Android 还必须填写 APK 的实际 `versionCode`，更新包须沿用原应用 ID 与签名。

## 发布与检查

Windows Agent 分为安装版和便携版；macOS Agent/Control 分为 Apple Silicon 和 Intel；Windows Control 使用原生安装包；Android 使用 APK。不同目标分别发布，安装包最多 512 MiB。服务器流式保存并计算 SHA-256，校验文件格式后原子替换版本元数据；失败时上一版继续可用。客户端包位于 Relay 数据目录的 `client-releases`，备份时一并保留。

客户端在登录、启动和此后每六小时检查，也可以从设置手动检查。桌面客户端的托盘/菜单栏图标显示红点；Android 在会话目录的设置按钮显示红点。打开设置或下载更新不会清除提示，安装到相同或更高版本后才会消失。网络暂时中断时保留已发现的新版本；退出登录或切换服务器后清除旧连接状态。

当前交付是自动检查、更新提示、校验下载和打开系统安装程序。Agent 下载期间可以继续运行任务，打开安装包前需等待本机任务完成。Control 下载完成后打开系统安装程序，Android 首次安装可能需要用户在系统界面授权安装来源，然后返回重新点击。安装程序由用户确认运行，当前不包含静默替换或自动重启。

此目录独立于服务器的 GitHub Release 更新源，不创建或覆盖服务器的 `vX.Y.Z` Release；上传客户端不会触发 Relay 更新或重启。旧“PC Agent 安装包”入口保留为手动下载兼容入口，发布到新目录时须选择明确的目标。

Windows Agent 便携版下载后打开文件所在目录，需退出旧版并手动替换原 EXE；不会在旧版运行时另启一个便携实例。

## API

- `GET /v1/admin/client-releases`：管理员查看全部已发布目标。
- `PUT /v1/admin/client-releases/{target}?name=...&version=...&buildNumber=...&notes=...`：管理员上传原始二进制包；说明最多 2000 字符。
- `GET /v1/client-releases/{target}`：读取 `{release: null | metadata}`。
- `GET /v1/client-releases/{target}/{releaseId}/download`：按不可变发布 ID 下载；支持 Range。被替换的旧发布返回不可用，客户端重新检查后重试。

客户端接口需要控制会话，或带 `x-device-id` 的 Agent 设备会话；下载链接不包含凭据。桌面下载拒绝重定向，分块检查大小和 SHA-256，打开安装包前再次验证缓存。客户端版本、平台、包名、发布 ID、大小与哈希一起验证，切换账号和取消下载均使旧任务失效。

## 响应式设置

手机 Web 与 Android 使用底部滑入的设置面板，保留圆角、分组卡片、独立滚动、返回和关闭按钮；拖动顶部可向下关闭。宽度达到 900 时使用左侧分类与搜索、右侧内容布局；调整宽度时保留所选分类。桌面原生 Control 在现有窗口内展示设置，避免另开尺寸受限的系统模态窗口。三套皮肤继续立即生效并保留当前会话和草稿。

实现入口：[设置容器](../apps/mobile/src/settings-shell.tsx)、[共享更新检查](../packages/client-shared/src/client-updates.ts)、[桌面下载](../apps/desktop/src/client-updates.ts)、[Relay 目录](../apps/relay/client_releases.go)。桌面架构与版本来源见[桌面技术约定](desktop-native.md)。

## 本次验证（2026-10-24）

源码版本为服务器/Web 0.3.27、Agent/桌面 Control 0.2.12、Android 0.1.3（versionCode 4）。Go 回归和 70 个测试文件中的 486 项测试通过；最终修改另跑了更新检查、桌面下载、桌面连接和设置交互共 103 项相关测试。覆盖身份隔离、错误平台、定时检查、校验失败、取消、旧连接的延迟响应，以及设置中的版本和皮肤。

Web/管理后台、Electron Agent、Android Hermes 代码包均完成构建，Windows Control 完成 React Native C++ 编译、链接、Hermes 编译与运行目录整理。实际浏览器检查了 320、390、844 和 1280 宽度、三套皮肤、分类与返回、搜索、滚动、宽窄切换、关闭、Escape 和顶部拖动。

本次未发布服务器或生成 EXE/APK 安装包。Windows 原生界面自动验收工具因启动错误 `failed to write kernel assets` 无法运行，不能据此宣称原生点击和托盘红点已经实测；macOS 编译与 Android 系统安装、托盘/设置红点仍需目标设备验收。
