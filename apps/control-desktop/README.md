# Windows 会话控制端

RelayDesk 在独立桌面窗口里打开服务器的控制界面，使用紫色显示器与对话气泡图标。首次启动填写 Relay 根地址，再登录控制端账号，即可选择 PC、浏览项目与会话、发消息、回答提问和查看图片/文件。

服务器地址保存在自己的 CodexerControl 用户目录；沿用 0.1.0 的目录和应用 ID，以保留已有地址与登录状态。登录状态按服务器来源保留，再次启动自动连接上次成功打开的服务器。自定义标题栏可拖动、最小化、最大化/还原和关闭；标题栏菜单或 Ctrl+L 切换服务器，Ctrl+R 刷新页面，Ctrl+Shift+R 重新加载，F11 切换全屏，Ctrl+加号/减号/0 缩放会话页面。

本地标题栏与地址窗口拥有受限 preload，窗口操作只接受本地窗口的精确主 frame。服务器控制页面在独立 WebContentsView 中使用沙箱及来源限制，没有 Node 或原生 IPC；尺寸随窗口变化，始终位于 46px 标题栏下方，退出时销毁视图。文件下载显示保存位置选择框，关闭应用不会停止远端 PC 上的任务。

控制界面随服务器前端更新；图片文件弹窗需要服务器 0.2.6 或以后版本。PC 连接器继续安装在运行 Codex 的目标电脑上。

## 构建

仓库根目录执行：

    npm ci
    npm run typecheck:control-desktop
    npm run package:control-desktop:win

Windows x64 安装版和便携版分别输出到：

- apps/control-desktop/release/RelayDesk Setup 0.1.1.exe
- apps/control-desktop/release/RelayDesk 0.1.1.exe

开发使用 npm run dev:control-desktop。最终用户无需安装 Node。

图标源文件位于 assets/icon.svg，PNG 与多尺寸 ICO 可用 node scripts/generate-control-icons.mjs 重新生成。
