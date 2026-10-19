# Windows 原生版 0.2.0 验收

验收日期：2026-10-19。RelayDesk 控制端与 Codexer PC Agent 管理界面使用 React Native for Windows 0.84.0、React Native 0.84.1、Fabric、Hermes 和 Windows App SDK。构建目标为 Windows x64 Release，自包含 Windows App Runtime，随包附带 Node 24.11.1。

## 构建与自动检查

- Release 原生 C++ 宿主与 Hermes 字节码已成功构建。运行目录包含 Windows App Runtime、原生依赖、WebView2Loader、Node 和后台服务，不依赖开发机 node_modules。
- 原生项目、根项目及移动端类型检查通过。
- Sidecar 3 项测试通过，覆盖并发配置写入、Chromium/DPAPI 凭据迁移、退出登录后不恢复旧凭据、Agent 身份及永久会话设置。
- 会话滚动、共享会话状态、实时同步及 PC Agent 控制器共 51 项相关测试通过。
- 完整运行目录复制到系统临时目录后，分别启动两个真实原生宿主。使用独立 profile 和本机模拟 HTTP/WebSocket 服务，验证加密凭据迁移、历史读取、订阅及连续增量事件；控制端状态达到 connected，seq=2，历史加载完成，未记录渲染异常。

## 界面验收

- PC Agent：连接状态、设置及诊断日志页面正常显示。合成永久会话显示“永不过期”。
- 默认关闭：窗口隐藏，进程保持运行，再次启动相同 profile 恢复原窗口。
- 退出选项：开关可以保存。关闭窗口弹出 Windows 原生确认框，默认选择“否”；取消后界面继续响应；确认后宿主与后台子进程退出。
- 修复 Windows 安全区域容器缺少高度导致的控制端空白界面，以及原生 Modal 根据内容测量导致的弹窗宽度收缩。
- 控制端：在真实原生窗口向上滚动触发自动历史分页，历史数量从 5 增至 8，无需点击加载按钮。
- 模型入口：单个按钮显示模型及强度，展开后强度滑块完整显示，可以进入模型列表；弹窗位置限制在可见区域内。
- 图片：使用 Windows 文件对话框选择合成 PNG，完成原生 WIC 转换及模拟上传；草稿中显示缩略图，点击后打开原生图片预览，提供缩放及重置控件，未发送任何会话消息。

## 验收边界

测试只使用合成账号、测试文件、独立配置与本机模拟服务器，没有登录或修改真实账号，没有连接用户正在运行的 Codex 任务。实际业务服务器上的完整任务执行和安装向导覆盖升级未在本轮执行。

本次仅交付 Windows x64；未生成或验收 macOS、iOS、Android 安装包。HTML/音频预览需要系统 Microsoft Edge WebView2 Runtime。类型检查和模拟服务通过不等同于所有业务场景完成实机回归。
