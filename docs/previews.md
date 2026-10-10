# 对话内网页和交互原型预览

消息中的 `visualize` 引用、本机 HTML 文件链接，以及 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP/HTTPS 地址，会在会话里显示成预览卡片。代码块和行内代码中的示例保持文本。

卡片可以直接点击、输入和拖动，支持刷新、展开全屏、Tweak 参数调节、元素标注和反馈给 Codex。需要同时更新服务端、控制端和 PC 连接器；安装的旧版本不会自动获得源码里的功能。

## HTML 原型

PC Agent 从当前会话引用的路径读取 HTML，沿用文件传输通道。`visualize` 标记中的路径也会登记，因此不需要另外附加下载链接。内容默认不超过 2 MB，不进入会话快照或 Relay 数据库。

Web 和 RelayDesk 在消息内使用没有 `allow-same-origin` 的沙盒 iframe；iOS/Android 使用 WebView 的可信外壳，内容仍在内部沙盒 iframe 中执行。预览拿不到主界面的登录凭据、存储或本机文件 API。

HTML 片段获得基础可视化样式和 `window.openai.widgetState`、`setWidgetState`、`sendFollowUpMessage` 兼容接口。完整 HTML 文档也可以预览。依赖相对本机文件的资源应打包进 HTML，或者通过本地开发服务器预览。外部脚本、样式和字体仅允许常用可视化 CDN；完整官方客户端的所有专用接口和 MCP App 功能不属于这个兼容层。

## Tweak 和元素标注

原型可以使用 `new Tweak({ container, onChange })` 注册滑块、开关、选项和颜色参数，支持 `addSlider`、`addToggle`、`addSelect`、`addColorPicker` 和 `dispose`。卡片工具栏的参数按钮打开控件；修改即时反映在预览里。“恢复初始参数”撤销当前调整。

没有注册参数的页面，可以点击标注按钮，再点选一个页面元素。预览会提供该元素的字号、内边距和圆角调节，并记录选择器、标签和文字，方便反馈定位。

参数调节只改变预览。点击“将调整反馈给 Codex”，核对或补充说明，再点击发送，才会请求 Codex 修改源文件。原型调用 `sendFollowUpMessage` 也只打开反馈草稿。反馈进入当前会话的消息队列，正在执行的任务完成后再处理。

交互选择及 Tweak 值保存在当前客户端，按登录会话、设备、会话和来源隔离。刷新、切换全屏后会恢复已保存的状态；元素标注需要重新选择。只有 `modelContent` 会随显式反馈发送，`privateContent` 用于恢复界面。此版本不跨客户端同步交互状态。

## 本地开发网页

Relay 通过 PC Agent 已建立的出站 WebSocket 回源，电脑无需增加公网入站端口。仅允许当前会话消息或命令输出中出现过的精确 loopback 服务；不接受局域网地址、DNS 别名、任意设备端口或跨服务跳转。

预览入口使用 30 分钟的随机能力地址，绑定登录会话、设备、线程和一个本地服务。每次请求重新验证归属及会话；退出登录、撤销账号、设备断开或 Relay 关闭会终止相关传输。地址到期后可刷新卡片。

转发支持 HTTP 方法、API 原始请求内容、二进制资源、Cookie、事件流和 WebSocket。登录凭据不会转发给本地服务；本地 Cookie 仅存在预览会话内，不能写入 Relay 的登录域。HTTP 请求体上限 1 MB，响应上限 32 MB，单条 WebSocket 消息上限 64 KB。

HTML 资源地址、CSS URL、Vite 模块导入和浏览器 fetch/XHR/WebSocket 会映射到独立的预览路径。路径代理不是一个完整透明的浏览器域名：依赖 `window.location` 原始路径的 SPA 路由、框架硬编码的资源地址、Service Worker、浏览器持久存储和复杂认证流程可能需要适配预览基础路径。原生 WebView 的实际手势、键盘和导航行为仍需 iOS/Android 实机验收。

代理页面提供 `window.__CODEXER_PREVIEW_BASE__`。需要基础路径的前端可以在 React Router 的 `basename` 或 Vue Router 的 history base 中使用它，普通本机访问时回退到 `/`。

## 开发验证

`tests/previews.test.ts` 覆盖标记识别、文件引用登记、loopback 约束、路径改写、反馈字段和沙盒外壳。`tests/preview-runtime.test.ts` 执行真实生成的预览运行时，验证 Dashboard 交互、状态恢复、Tweak、元素选择及反馈草稿。`tests/previews-relay.test.ts` 使用真实 PC Agent、Relay 和本地 HTTP/WebSocket 服务验证资源、API、Cookie、连接隔离及会话撤销。

桥接脚本的编辑源在 `packages/client-shared/src/preview-bridge.ts`。修改后运行 `node scripts/build-preview-runtime.mjs` 更新字符串资源；`npm run check:preview-runtime` 检查同步状态。原生 Hermes 使用这份字符串资源，不依赖 `Function.prototype.toString()`。
