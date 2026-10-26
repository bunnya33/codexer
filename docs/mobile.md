# React Native 控制客户端

`apps/mobile` 是唯一控制 UI 源码，React Native + Expo + TypeScript 覆盖 iOS、Android 和 Web。名称沿用原工程；`apps/web/dist` 只是 Expo Web 导出结果。管理后台的 React 应用在 `apps/admin`，不混在控制 UI 中。

## 用户入口

Windows 控制端：安装 [RelayDesk](../apps/control-desktop/README.md)，填写服务器根地址后登录控制端账号，在桌面窗口中查看和操作会话。界面沿用服务器提供的 Web 控制端，支持原有消息、图片、文件阅读及通知开关。

Web：打开 Relay 的根地址，只填写账号密码。页面、REST 与 WebSocket 使用当前站点的协议、域名和端口，登录页不显示服务器地址输入；旧版本保存的其他服务器登录配置会被清除。手机：安装对应 APK/IPA，填写 Relay 根地址和账号密码。功能见 [使用指南](usage.md)。App 与 Web 无需接触访问令牌。

服务器 `0.3.5` 与连接器 `0.1.11` 增加项目列表里的「新建项目」，可在电脑端授权的父目录中创建文件夹或添加已有文件夹。授权和会话执行权限的区别见 [PC 设置](pc-setup.md)。Web 随服务器升级生效，原生 App 需重新构建；不会把 `mobile:export` 导出当作已生成 APK/IPA。

新建项目入口现为「项目」标题行右侧的文件夹加号图标。手机侧栏保持原来的滑动方式；设置使用底部滑入面板，宽屏切换为左侧分类与右侧内容，其他会话管理、工作模式和微信设置继续使用居中弹窗。设置中的服务器版本来自当前 Relay 的 `/health`，控制端版本来自已加载的网页或原生应用包；旧网页标签不会把服务器新版本当成自身版本。更新提示、下载和设置交互见[客户端更新](client-updates.md)。

项目行右侧 `…` 菜单可新建会话或删除空项目，归档会话也计入数量。删除时选择是否保留目录，连同目录删除须再次确认，具体路径及限制见[删除空项目](project-deletion.md)。需同步更新 Relay、Agent 和所用控制客户端。

输入框左侧「＋」在按钮旁打开相机、照片和文件菜单。文件支持单独发送、与文字/图片一同发送及排队，每条最多 4 个、单个最多 20 MiB；上传完成后才可发送，失败可重试。切换设备/会话取消正在上传的文件。需要同时更新服务器和 PC 连接器以支持附件协议，旧连接器的文件入口会禁用；原生 App 新增 `expo-document-picker`，需重新构建安装包。

## 开发

开发者需要 Node 24，仓库根目录执行：

```bash
npm ci
npm run local:start
npm run dev:web
npm run mobile:start
```

Web 开发服务默认 5173，读取 `.local/services.json` 中本机 Relay 地址；`EXPO_PUBLIC_RELAY_URL` 可覆盖，`CODEXER_WEB_PORT` 可调整 Web 开发端口。手机访问开发 Relay 必须使用手机可达的局域网地址，不能填手机自身的 127.0.0.1。开发的跨域浏览器来源加入 `RELAY_ALLOWED_ORIGINS`。

共享代码包括 `App.tsx`、目录、会话显示、RelayClient、协议和活动历史合并。平台文件处理差异：Web Markdown/clipboard/paste/drop/localStorage，原生 Markdown/图片/手势/SecureStore。业务控制流程共用，不维护独立旧 Web 控制页。图片查看支持左右滑动、翻页按钮及 Web 键盘左右箭头；缩放后拖动保持查看细节，范围与操作见 [会话界面](conversation.md)。

## 会话文件与通知

会话中的本地文件引用显示为可点击链接，支持 Windows 路径里的中文和空格。点击 MD/TXT/JSON 等文本时从 PC 直接获取，在客户端阅读器显示；PNG/JPEG/WebP/GIF/BMP/ICO/AVIF/SVG 图片直接弹窗预览，支持缩放和按需下载；安装包、压缩包等先询问是否下载。服务器只转发分块数据，不保存文件。PC 离线时无法打开；旧版 PC 连接器需要更新。文本预览上限 2 MiB，此限制不适用于图片；文件传输上限 512 MiB。平台不支持解码或图片损坏时显示错误并保留下载入口。原生图片手势及保存/分享仍需真机验收。

服务器 `0.3.8` 的网页客户端和 RelayDesk 可点击会话中的音频文件链接，直接打开播放器，支持播放、暂停、拖动进度和下载。支持 MP3/WAV/M4A/M4B/AAC/OGG/OGA/Opus/FLAC/AIFF/WebM，具体编码取决于浏览器或系统；无法解码时显示重新加载及下载提示。音频采用分块回源和 Range 跳转，不受 2 MiB 文本限制，沿用 512 MiB 文件传输上限。关闭、切换会话或退出登录时停止播放；播放地址 30 分钟有效，过期后重新打开。PC 连接器无需为此更新；原生 App 使用可信 WebView 播放外壳，需要重新构建，手势及系统音频行为仍需真机验收。

服务器 `0.3.9` / PC 连接器 `0.1.12` 增加会话内音频卡片：只将 Markdown 图片语法中指向本地音频的嵌入标记转为卡片，消息中的独立下载链接保留。点击「加载音频」后才获取文件信息与播放地址；同一客户端最多保留一个播放器，选择另一首会停止上一首，并等待旧地址撤销后加载新地址。播放完成、关闭或切换会话也会释放地址。仅有音频嵌入标记的消息需要更新至 PC 连接器 `0.1.12`；旧版 `0.1.11` 只登记普通文件链接。网页随服务器更新，原生 App 需要重新构建。

会话顶部的「微信通知」默认关闭，按账号同步到其它设备。设置里的「任务完成通知」开启时通知全部已监听会话；关闭时只通知单独开启的会话。改变开关无需 PC 在线，但设备及会话必须仍在账号目录中。

## 构建

```bash
npm run mobile:typecheck
npm run build:web
npm run mobile:export
```

Web 输出 `apps/web/dist` 并随服务器发布。`mobile:export` 导出 iOS/Android JavaScript bundle，用于构建检查，**不是 APK/IPA**。

服务器 `0.3.6` 的网页客户端在当前浏览器保存选中的设备和会话，刷新、关闭后重新打开以及同账号重新登录时恢复。记录按服务器和账号隔离，不会同步到其他浏览器。列表加载完成前不会用默认项覆盖记录；离线设备仍保留，设备移除或会话删除/归档后回到可用项。原生 App 的选择仍仅保存在内存中。

Android 内测 APK：在 `apps/mobile` 执行 `npx eas-cli build --platform android --profile preview`；也可用本机 Android SDK、JDK 21 和 `npx expo prebuild --platform android --no-install` 生成工程，再执行 Gradle `:app:assembleRelease`。本机发布构建必须将生成工程的 release signingConfig 改为维护者的专用密钥，不得沿用模板中的 debug 签名。密钥和密码只保存在源码目录外，后续更新沿用同一密钥。生成工程及本机构建配置不提交仓库。

Android 配置通过 `expo-build-properties` 将 HTTP 兼容设置写入实际 Manifest，并关闭不使用的录音和悬浮窗权限。首次本机构建使用 NDK 27.3.13750724、CMake 3.22.1 和项目内 Ninja 1.13.1；Windows 深层工作树需复制到短路径后重新生成原生构建缓存，避免 CMake 依赖文件超过路径限制后不断重新生成。单纯映射盘符仍可能被自动链接还原成长路径。没有替换共享 SDK 的工具。

2026-10-20 已生成签名 release APK `release/android-0.1.0/Codexer-Control-0.1.0.apk`，最低 Android 7.0，包含 ARM64 与 x86_64。界面和 Hermes 代码随安装包交付，不依赖 Metro 或服务器网页；连接 Relay 后使用现有控制端账号登录。本轮包检查通过，模拟器系统图形服务异常导致安装和运行验收未完成，具体范围见 [验证记录](validation.md)。

2026-10-21 Android `0.1.1`（versionCode 2）统一模型／强度选择器的粗轨道、圆形滑块、刻度、文字行高和主题配色；模型与附件菜单按自身窗口、安全区域和按钮坐标定位。原生菜单使用皮肤实体背景，Web 保留玻璃背景；原生不模拟浏览器的背景模糊。设置等弹窗遮罩随皮肤切换。Android 输入区及对话弹窗增加键盘避让，菜单在键盘布局更新后重新测量。此包同时包含不依赖 `AbortSignal.timeout` 的原生登录兼容修复。安装 `release/android-0.1.1/Codexer-Control-0.1.1.apk` 即可生效，无需更新 Relay 或 PC Agent；沿用原发布密钥，可覆盖旧包。已在独立 Android 15 模拟器验证安装、登录、强度点击／拖动保存、模型切换、三套皮肤、键盘及菜单布局；硬件和系统媒体行为另需真机验收。

iOS 使用 EAS/Apple Developer 或 macOS/Xcode 完成签名和设备分发。云构建与商店发布由维护者自行操作，本地 APK 不代表商店发布或 iOS 验收。

## 网络和平台范围

当前 App 配置允许用户指定 HTTP 地址以兼容内网部署；公网使用 HTTPS。Web 登录会话使用站点 localStorage（自动迁移旧 sessionStorage），原生使用 SecureStore。前台续期、离开前台停止周期续期，回到前台重新检查登录并重连。有效时长由管理员在后台设置，网络错误保留登录并重试。图片上传/查看、历史分页、队列/引导/停止、模型修改、审批、账号改密失效及系统后台/前台切换均需按 [验证范围](validation.md) 做真实 iOS/Android 设备验收。Windows 开发机上的 JS 导出不代替手势、系统后台和安装包测试。

HTTP 读取与实时连接分别运行：会话列表、快照和历史读取成功，不表示 WebSocket 已完成认证。连接建立或认证超过 12 秒仍未完成时，客户端保留登录、显示实时连接超时并在 3 秒后重试；网络错误也不依赖浏览器的 close 回调才重试。切回前台会使旧初始化、票据和 socket 回调失效，避免 VPN 切换或延迟响应覆盖已经恢复的连接。

网页长期显示“正在重连服务器”时，在浏览器开发者工具的 Network → WS 检查 `/v1/ws/client` 是否返回 101，并查看是否收到 `client.authenticated` 后断开；101 仅表示握手成功。对比将服务器地址设为 VPN 直连前后的结果，使用反向代理时确认 WebSocket upgrade 转发正常。只刷新会话历史不会重建实时连接，新会话接入与发送仍等待认证和同步完成。
