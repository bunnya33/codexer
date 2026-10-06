# React Native 控制客户端

`apps/mobile` 是唯一控制 UI 源码，React Native + Expo + TypeScript 覆盖 iOS、Android 和 Web。名称沿用原工程；`apps/web/dist` 只是 Expo Web 导出结果。管理后台的 React 应用在 `apps/admin`，不混在控制 UI 中。

## 用户入口

Web：打开 Relay 的根地址，只填写账号密码。页面、REST 与 WebSocket 使用当前站点的协议、域名和端口，登录页不显示服务器地址输入；旧版本保存的其他服务器登录配置会被清除。手机：安装对应 APK/IPA，填写 Relay 根地址和账号密码。功能见 [使用指南](usage.md)。App 与 Web 无需接触访问令牌。

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

会话顶部的「微信通知」默认关闭，按账号同步到其它设备。设置里的「任务完成通知」开启时通知全部已监听会话；关闭时只通知单独开启的会话。改变开关无需 PC 在线，但设备及会话必须仍在账号目录中。

## 构建

```bash
npm run mobile:typecheck
npm run build:web
npm run mobile:export
```

Web 输出 `apps/web/dist` 并随服务器发布。`mobile:export` 导出 iOS/Android JavaScript bundle，用于构建检查，**不是 APK/IPA**。

Android 内测 APK：在 `apps/mobile` 执行 `npx eas-cli build --platform android --profile preview`。iOS 使用 EAS/Apple Developer 或 macOS/Xcode 完成签名和设备分发。云构建与商店发布由维护者自行操作；本次没有发布 App 或生成商店包。

## 网络和平台范围

当前 App 配置允许用户指定 HTTP 地址以兼容内网部署；公网使用 HTTPS。Web 登录会话使用站点 localStorage（自动迁移旧 sessionStorage），原生使用 SecureStore。前台续期、离开前台停止周期续期，回到前台重新检查登录并重连。有效时长由管理员在后台设置，网络错误保留登录并重试。图片上传/查看、历史分页、队列/引导/停止、模型修改、审批、账号改密失效及系统后台/前台切换均需按 [验证范围](validation.md) 做真实 iOS/Android 设备验收。Windows 开发机上的 JS 导出不代替手势、系统后台和安装包测试。

HTTP 读取与实时连接分别运行：会话列表、快照和历史读取成功，不表示 WebSocket 已完成认证。连接建立或认证超过 12 秒仍未完成时，客户端保留登录、显示实时连接超时并在 3 秒后重试；网络错误也不依赖浏览器的 close 回调才重试。切回前台会使旧初始化、票据和 socket 回调失效，避免 VPN 切换或延迟响应覆盖已经恢复的连接。

网页长期显示“正在重连服务器”时，在浏览器开发者工具的 Network → WS 检查 `/v1/ws/client` 是否返回 101，并查看是否收到 `client.authenticated` 后断开；101 仅表示握手成功。对比将服务器地址设为 VPN 直连前后的结果，使用反向代理时确认 WebSocket upgrade 转发正常。只刷新会话历史不会重建实时连接，新会话接入与发送仍等待认证和同步完成。
