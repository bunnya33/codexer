# Android 发布签名与本机打包

2026-11-09 已找回并验证原发布签名。后续开发者和 AI 先按本页读取现有材料，不要重新生成证书、改用 debug 签名或再次让用户寻找密码。签名材料在仓库外长期保留，清理工作区、`.local`、`release` 或短路径构建目录时不得删除它们。

## 原签名材料

| 项目 | 值 |
| --- | --- |
| 本机稳定目录 | `%LOCALAPPDATA%\Codexer\AndroidSigning` |
| 当前绝对目录 | `C:\Users\JOKER\AppData\Local\Codexer\AndroidSigning` |
| 密钥文件 | `control-release.p12`，格式 PKCS#12 |
| 密钥别名 | `codexer-control` |
| 密码文件 | `control-release.password.dpapi`，二进制 DPAPI 密文 |
| 密码加密 | Windows `ProtectedData`，`CurrentUser`，附加熵为 `null`，解密后按 UTF-8 读取 |
| 密码关系 | keystore 和 private key 使用相同密码 |
| 发布证书 SHA-256 | `5e8f351666c250682effb88a1ebec7ca4d13196e9f272e054f5881eaa393a211` |
| Android applicationId | `com.bunnya33.codexer.remote`，保留以支持覆盖升级 |

密码已经保存，不是缺失。不要把明文密码、私钥或密码密文写进 Git、聊天、构建日志或 APK；本页记录准确位置和读取方式即可。同一台电脑、同一 Windows 用户可以自动解密。仓库已忽略 `.p12`、`.pfx`、`.jks`、`.keystore`、`.password.dpapi`。

## 当前构建环境与入口

- 主源码：`F:\vibe_coding\codexer`，日常开发保持在主目录 `main`。
- 已准备的短路径构建副本：`F:\ca20`；这只是构建缓存，不是 Git worktree。
- Android 工程：`F:\ca20\apps\mobile\android`。`android` 是 Expo prebuild 产物，没有提交进仓库。
- JDK：`C:\Program Files\Android\Android Studio\jbr`。不要使用系统 Java 8。
- SDK：`%LOCALAPPDATA%\Android\Sdk`；当前 Build Tools `36.0.0`，SDK/NDK/CMake 版本以生成工程为准。
- Windows 原生编译使用短路径 Ninja：`F:/ca20/.local/ninja-1.13.1/ninja.exe`，保留生成工程的 CMake 参数。
- 版本来自 `apps/mobile/package.json`、`apps/mobile/app.json`，源码当前 `0.1.21` / `versionCode 25`（FrogCoder 名称、青蛙图标、手机屏幕常亮设置、持久下载列表／断点续传、登录键盘避让、关闭文件弹窗后继续下载、完成红点及顶部设备状态图标）；最后完成原签名 APK 验收的是 `versionCode 22`，新版尚待此 Windows 环境构建。Android 登录页新增 `softwareKeyboardLayoutMode: "resize"`，同步时须按下文重新生成对应原生配置。上传安装包时填写 APK 内实际的 versionCode；后续发布递增，不能只改文件名。

先通过下面已提交的同步入口更新短路径副本；它核对依赖和 Expo 原生配置、逐文件校验复制、同步原生版本，并保留副本的 `node_modules`、Android 工程和 Ninja。依赖或原生配置变化时停止；此时需在副本重新安装依赖、执行 `npx expo prebuild --platform android`，重新应用下节的发布签名配置和已有原生构建适配。不要用旧副本打包新版本。

在主源码目录执行已提交的入口：

```powershell
node scripts/sync-android-source.mjs --stage F:\ca20
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-release.ps1 `
  -AndroidDirectory F:\ca20\apps\mobile\android
```

脚本自动读取并解密原密码，在子进程环境中提供签名；先验证证书，再执行真正的 Gradle `:app:assembleRelease`。构建时设置 `NODE_ENV=production`，使用隐藏窗口并保存 stdout/stderr，完成后恢复环境变量。缺少原密钥、解密失败、证书不匹配或原生版本不一致时停止，不降级为 debug 签名。

输出位于 `release/android-<版本>/`，包括 APK、SHA256、签名、清单、16 KiB ZIP 对齐检查和构建日志。脚本不会上传、发布或安装 APK。Hermes bundle/source map 与主源码一致性、模拟器覆盖安装与真实手机验收另行记录，不能用签名校验代替。

可用 `-SigningDirectory`、`-JavaDirectory`、`-BuildToolsDirectory`、`-OutputDirectory` 指定其它本机位置；支持由安全运行环境预先提供 `CODEXER_ANDROID_KEYSTORE` 和 `CODEXER_ANDROID_STORE_PASSWORD`，脚本不会输出密码。

## Expo 重新生成 Android 工程后的 Gradle 配置

`android/app/build.gradle` 的 `android.signingConfigs` 中保留 debug 配置，并加入：

```groovy
controlRelease {
    storeFile file(System.getenv('CODEXER_ANDROID_KEYSTORE'))
    storePassword System.getenv('CODEXER_ANDROID_STORE_PASSWORD')
    keyAlias 'codexer-control'
    keyPassword System.getenv('CODEXER_ANDROID_STORE_PASSWORD')
}
```

在 `buildTypes.release` 中使用 `signingConfig signingConfigs.controlRelease`。不能沿用 Expo 模板的 `signingConfigs.debug`。同步 `defaultConfig.versionName`、`versionCode` 与主源码；当前生成工程的 ABI 为 `armeabi-v7a,arm64-v8a,x86,x86_64`，交付时按实际 APK 的 `native-code` 和原生库核对，不沿用旧构建记录中的 ABI 常量。入口会检查签名配置和版本，但开发者仍需核对源码同步和原生配置。

## 保管与换电脑

保留整个 `AndroidSigning` 目录和可恢复的 Windows 用户凭据；仅复制 DPAPI 密文到另一台电脑或另一 Windows 用户不能直接解密。重装系统前，应在当前用户仍可解密时，将**同一份** `.p12` 与密码导入用户指定的加密备份或密码管理器，不能新建证书代替。迁移机器可由安全环境注入原密码，或在新用户下重新用 DPAPI 加密保存原密码；再次核对上面的证书 SHA-256。禁止在文档中放明文作为迁移方式。
