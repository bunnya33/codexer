# 客户端更新与设置界面

Codexer Agent 和 Codexer Control 从当前登录的 Relay 获取各自的客户端版本。管理后台左侧的“客户端更新”按产品、系统和架构上传安装包，并填写包内的实际版本。Android 还必须填写 APK 的实际 `versionCode`，更新包须沿用原应用 ID 与签名。

服务器 `0.3.28` 正式交付独立客户端更新与安装包管理页面。同期 Android `0.1.4`（versionCode 5）同步任务时间的居中与点击切换展示，APK 在本地 `release/android-0.1.4`，可覆盖 `0.1.3`；上传后台请选择 Android Control 并填写实际版本与构建号。Agent 本轮无需升级，继续使用 `0.2.12`。发布与安装验证见[验证记录](validation.md)。

## 发布与检查

Windows Agent 分为安装版和便携版；macOS Agent/Control 分为 Apple Silicon 和 Intel；Windows Control 使用原生安装包；Android 使用 APK。不同目标分别发布，安装包最多 512 MiB。服务器流式保存并计算 SHA-256，校验文件格式后原子替换版本元数据；失败时上一版继续可用。客户端包位于 Relay 数据目录的 `client-releases`，备份时一并保留。

“安装包管理”展示全部当前发布和历史安装包，包括平台、文件名、版本/构建号、大小、上传时间、SHA-256 与说明，并统计数量和总占用；可按平台及当前/历史状态筛选。成功发布新包后保留上一版为历史，历史包不继续提供客户端更新或下载。升级时纳入原有当前发布，先前已自动删除的旧包无法恢复。

删除前显示确认，确认后移除服务器文件并释放空间。删除历史包不影响当前发布；删除当前发布会同时停止该平台的更新和下载，不自动回退到历史版本，已安装客户端仍可使用。正在下载的包暂不能删除；上传和删除互斥，失败可重试。客户端版本目录与旧的手动下载目录独立，旧入口仍只保留最近上传的一包。

客户端在登录、启动和此后每六小时检查，也可以从设置手动检查。桌面客户端的托盘/菜单栏图标显示红点；Android 在会话目录的设置按钮显示红点。打开设置或下载更新不会清除提示，安装到相同或更高版本后才会消失。网络暂时中断时保留已发现的新版本；退出登录或切换服务器后清除旧连接状态。

当前交付是自动检查、更新提示、校验下载和打开系统安装程序。Agent 下载期间可以继续运行任务，打开安装包前需等待本机任务完成。Android Control 分别显示下载、校验和打开安装程序；SHA-256 在原生后台流式计算。首次安装先打开系统来源授权，允许后返回点击“重试安装”，复用缓存并重新校验，不重复下载。打开安装程序后立即结束下载状态，保留已校验的 APK 供系统读取。安装程序由用户确认运行，当前不包含静默替换或自动重启。

此目录独立于服务器的 GitHub Release 更新源，不创建或覆盖服务器的 `vX.Y.Z` Release；上传客户端不会触发 Relay 更新或重启。管理后台和控制端已移除旧“PC Agent · Windows”手动上传/下载区域，Agent 使用本目录中的独立客户端更新流程。旧 API 和已保存的文件保留兼容，不再展示入口。

Windows Agent 便携版下载后打开文件所在目录，需退出旧版并手动替换原 EXE；不会在旧版运行时另启一个便携实例。

## API

- `GET /v1/admin/client-releases`：管理员读取当前目标映射 `releases` 和包含历史的安装包列表 `packages`。
- `PUT /v1/admin/client-releases/{target}?name=...&version=...&buildNumber=...&notes=...`：管理员上传原始二进制包；说明最多 2000 字符。
- `DELETE /v1/admin/client-releases/{target}/{releaseId}`：管理员删除指定安装包；删除当前版同时撤下该目标。目标/ID 不匹配或已删除返回 404，正在下载或上传返回 409。
- `GET /v1/client-releases/{target}`：读取 `{release: null | metadata}`。
- `GET /v1/client-releases/{target}/{releaseId}/download`：按不可变发布 ID 下载；支持 Range。被替换的旧发布返回不可用，客户端重新检查后重试。

客户端接口需要控制会话，或带 `x-device-id` 的 Agent 设备会话；下载链接不包含凭据。桌面下载拒绝重定向，分块检查大小和 SHA-256，打开安装包前再次验证缓存。客户端版本、平台、包名、发布 ID、大小与哈希一起验证，切换账号和取消下载均使旧任务失效。

## 响应式设置

手机 Web 与 Android 使用底部滑入的设置面板，保留圆角、分组卡片、独立滚动、返回和关闭按钮；拖动顶部可向下关闭。宽度达到 900 时使用左侧分类与搜索、右侧内容布局；调整宽度时保留所选分类。桌面原生 Control 在现有窗口内展示设置，避免另开尺寸受限的系统模态窗口。三套皮肤继续立即生效并保留当前会话和草稿。

实现入口：[设置容器](../apps/mobile/src/settings-shell.tsx)、[共享更新检查](../packages/client-shared/src/client-updates.ts)、[桌面下载](../apps/desktop/src/client-updates.ts)、[Relay 目录](../apps/relay/client_releases.go)。桌面架构与版本来源见[桌面技术约定](desktop-native.md)。

## 本次验证（2026-10-24）

源码版本为服务器/Web 0.3.27、Agent/桌面 Control 0.2.12、Android 0.1.3（versionCode 4）。Go 回归和 70 个测试文件中的 486 项测试通过；最终修改另跑了更新检查、桌面下载、桌面连接和设置交互共 103 项相关测试。覆盖身份隔离、错误平台、定时检查、校验失败、取消、旧连接的延迟响应，以及设置中的版本和皮肤。

Web/管理后台、Electron Agent、Android Hermes 代码包均完成构建，Windows Control 完成 React Native C++ 编译、链接、Hermes 编译与运行目录整理。实际浏览器检查了 320、390、844 和 1280 宽度、三套皮肤、分类与返回、搜索、滚动、宽窄切换、关闭、Escape 和顶部拖动。

上述源码验收阶段尚未发布服务器或生成 EXE/APK。随后应用户要求发布了服务器 [v0.3.27](https://github.com/bunnya33/codexer/releases/tag/v0.3.27)，生成 Windows Electron Agent 0.2.12 安装版/便携版和 Android 0.1.3（versionCode 4）签名 APK；校验文件与构建信息随本地安装包保存。Android 与既有 APK 签名一致，独立 Android 15 模拟器从 0.1.1 覆盖安装、启动、底部设置面板、分类返回、三套皮肤切换和版本展示通过，崩溃缓冲区无记录。离线设置验收不代表已验证真实 Relay 的更新提示和系统安装来源授权。

Windows 原生界面自动验收工具因启动错误 `failed to write kernel assets` 无法运行，不能据此宣称原生点击和托盘红点已经实测。桌面托盘/菜单栏和 Android 设置红点仍需目标设备及发布后的客户端目录验收；本次未交付新的 Windows/macOS Control 桌面安装包，也未重启生产服务器。发布及原生编译结果见[验证记录](validation.md)。
