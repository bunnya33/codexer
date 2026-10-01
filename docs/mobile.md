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

共享代码包括 `App.tsx`、目录、会话显示、RelayClient、协议和活动历史合并。平台文件处理差异：Web Markdown/clipboard/paste/drop/sessionStorage，原生 Markdown/图片/手势/SecureStore。业务控制流程共用，不维护独立旧 Web 控制页。

## 构建

```bash
npm run mobile:typecheck
npm run build:web
npm run mobile:export
```

Web 输出 `apps/web/dist` 并随服务器发布。`mobile:export` 导出 iOS/Android JavaScript bundle，用于构建检查，**不是 APK/IPA**。

Android 内测 APK：在 `apps/mobile` 执行 `npx eas-cli build --platform android --profile preview`。iOS 使用 EAS/Apple Developer 或 macOS/Xcode 完成签名和设备分发。云构建与商店发布由维护者自行操作；本次没有发布 App 或生成商店包。

## 网络和平台范围

当前 App 配置允许用户指定 HTTP 地址以兼容内网部署；公网使用 HTTPS。Web 登录会话使用标签页 sessionStorage，原生使用 SecureStore。图片上传/查看、历史分页、队列/引导/停止、模型修改、审批、账号改密失效均需按 [验证范围](validation.md) 做真实 iOS/Android 设备验收。Windows 开发机上的 JS 导出不代替手势、系统后台和安装包测试。
