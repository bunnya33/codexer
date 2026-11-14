# iOS 自用真机安装

没有付费 Apple Developer 会员时，可以在 Mac 上使用免费 Apple ID 的 Xcode Personal Team 给自己的 iPhone 安装开发版本。免费描述文件常见期限为 7 天，实际以本次描述文件的 `ExpirationDate` 及设备验证为准；过期后需用同一账号重新签名安装。不能通过此方式生成供任意手机直接安装的通用 IPA，也不能用于 TestFlight 或 App Store 分发。

## Mac 准备

安装完整 Xcode（仅 Command Line Tools 不够），打开并完成首次组件安装及协议确认，安装 iOS 平台支持。在 Xcode Settings → Apple Accounts 中登录 Apple ID。Node 24、npm 和 CocoaPods 也须可用；CocoaPods 建议配合受支持的 Ruby 使用，避免改动 macOS 自带 Ruby。当前 Expo 生成工程最低为 iOS 16.4，手机系统须满足此要求。

若当前开发目录仍指向 Command Line Tools，可在当前终端设置 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`；在该终端导出后，以下命令应能运行：

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
node --version
pod --version
```

在仓库根目录准备共享代码和本地原生工程：

```bash
npm ci
npm run mobile:typecheck
npm run mobile:ios:prepare
cd apps/mobile/ios
pod install
```

`mobile:ios:prepare` 生成工程并检查随 App 交付的预览运行时，不会安装 Pods 或编译原生代码。Expo 可能重建已有生成目录，并同时更新 package.json 中的原生快捷命令，生成后检查差异。`apps/mobile/ios` 是本地生成目录，签名团队、描述文件和证书不提交仓库；完成本地签名设置后不要重复执行 prebuild，需重新生成时先记录这些设置。

用 Xcode 打开 `apps/mobile/ios/Codexer.xcworkspace`（安装 Pods 后生成），不要只打开 `.xcodeproj`。若从 Finder 启动的 Xcode 找不到 Node，在 `apps/mobile/ios/.xcode.env.local` 写入本机 Node 可执行文件的绝对路径，例如 `export NODE_BINARY='/absolute/path/to/node'`，不要提交此机器专属路径。

iOS 显示名为 FrogCoder，桌面图标使用用户提供的青蛙图片 `apps/mobile/assets/frogcoder-icon.png`（1024 × 1024、白色不透明背景）。`app.json` 的 `ios.icon`、`ios.infoPlist.CFBundleDisplayName` 和 `CFBundleName` 保存这些设置；登录页和侧栏同步显示 FrogCoder。工程 target、scheme、URL scheme 和 Bundle Identifier 保留既有值，便于沿用签名和覆盖升级。已有生成工程直接同步 AppIcon 与 Info.plist，不必为更换图标重新执行 prebuild。

2026-11-14 最新本地开发包为 `release/ios-0.1.21-build6/FrogCoder-0.1.21-build6-development.ipa`，包含持久下载列表、断点继续、关闭文件弹窗后继续下载、完成红点、设备状态青蛙和前台常亮。build 6 只递增构建编号，实际完成 Release 编译、签名、源码及验包检查；支持此前描述文件中登记的手机，未进行本轮装机验收。Relay `0.3.64` 与 Qt Agent `0.2.39` 已配合完成同文件 Mac 浏览器测速，手机结果另验。构建及签名期限见 [验证记录](validation.md)。

## 连接手机与签名

1. 用数据线连接并解锁 iPhone，在手机上选择信任这台电脑，等待 Xcode 配对完成。
2. 在 iPhone 设置 → 隐私与安全性中按提示开启开发者模式，按系统要求重启并确认。
3. Xcode 选择 Codexer target，在 Signing & Capabilities 启用 Automatically manage signing，Team 选择自己的 Personal Team。
4. 保留现有 Bundle Identifier `com.bunnya33.codexer.remote`。如果 Apple 提示此标识不能注册到你的团队，再为该本地自用安装设置唯一后缀，并记录下来；更换标识会成为另一个 App，后续升级沿用同一标识和团队。
5. 选择连接的 iPhone 为运行目标。首次开发证书或描述文件申请可能需要在线登录和系统钥匙串授权。

工程使用基础开发签名，无推送、iCloud 或应用组要求。SecureStore 登录存储沿用平台 Keychain；不要为绕过签名问题添加付费会员专属能力。

## 构建并安装独立运行的版本

在仓库根目录执行：

```bash
npm run mobile:ios:device
```

此入口选择真机并以 Release 构建，JavaScript 和资源随 App 打包，运行时不依赖 Metro。也可在 Xcode 的 Edit Scheme → Run → Build Configuration 选择 Release，然后运行。手机如提示不受信任的开发者，按系统指引在设置 → 通用 → VPN 与设备管理中信任自己的开发者身份。

使用手机可访问的 Relay 地址登录；连接同一局域网的 Relay 时允许本地网络访问，不能填写手机自身的 `127.0.0.1`。外网 Relay 使用现有可访问地址。验证登录、会话、图片、文件、键盘和重启后启动，再记录真机验收结果。

`expo export --platform ios` 只验证 JS 与资源导出；原生编译、设备签名、安装和运行分别记录。没有签名及设备安装结果前，不把生成工程或导出目录称为已可安装的 iOS 包。
