# FrogCoder 手机热更新

FrogCoder 通过当前登录的 Relay 获取签名更新。iOS 和 Android 均可用 HTTP 或 HTTPS。App 从内置证书校验更新清单，并按清单中的 SHA-256 校验文件。更新匹配 Relay 地址、Relay 版本、手机平台和原生运行时。检查和下载由用户从「设置 → 更新与下载」发起。点「立即重启」会重新加载 App。点「下次启动」会继续当前操作，完全退出后重新打开 App 会加载已下载的内容。退出登录或重新登录会清除待启用的来源选择，App 启动使用本地缓存或安装包内的内容。

首次启用需要安装新版 IPA 或 APK。JavaScript、样式和随代码打包的资源可热更新。原生模块、应用图标、权限和系统配置变动需要发新版安装包。Android APK 继续使用原发布证书。iOS SideStore 续签按原周期进行。

## 首次启用

在构建机上生成并保管一套更新签名密钥。这个证书用于签发内容更新，IPA 和 APK 继续沿用各自的安装签名。公开证书需放在各构建机的同一相对路径，使原生包和后续发布使用同一个运行时指纹。

```sh
mkdir -p apps/mobile/.expo
mkdir -p "$HOME/.frogcoder-ota"
chmod 700 "$HOME/.frogcoder-ota"
(umask 077 && openssl req -new -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -subj '/CN=FrogCoder OTA' -addext 'keyUsage=critical,digitalSignature' \
  -addext 'extendedKeyUsage=codeSigning' \
  -keyout "$HOME/.frogcoder-ota/private-key.pem" \
  -out "$HOME/.frogcoder-ota/certificate.pem")
cp "$HOME/.frogcoder-ota/certificate.pem" apps/mobile/.expo/ota-certificate.pem
export FROGCODER_UPDATE_CERT='.expo/ota-certificate.pem'
```

密钥只在发布机签名时使用。证书文件可以交给原生构建机，后续构建使用同一份证书。更换证书需要重新打包客户端。未提供证书时，构建的 App 会使用包内内容。安装包支持登录不同 Relay。更换 Relay 地址时，给新地址生成对应的签名清单。

在仓库根目录执行 `npm ci` 后，安装脚本会给 Expo Updates 应用 Relay 适配。Expo prebuild 会把更新配置写入新生成的原生工程。保留已有签名工程时，在 `apps/mobile` 执行对应的平台命令，再按原来的方式编译。首次启用时 iOS 还需要更新 Pods，Android 需要同步依赖及原生工程。

```sh
npx expo-updates configuration:syncnative --platform ios --workflow generic
npx expo-updates configuration:syncnative --platform android --workflow generic
```

原生构建和内容发布使用相同的 Expo 配置、证书相对路径和锁定依赖。生成目录里的原生代码变动应回到 Expo config plugin 或本地原生模块源码，供运行时指纹纳入计算。iOS 和 Android 分别计算指纹。

## 发布内容

部署带 `/v1/mobile-ota` 接口的 Relay。Android 和 iOS 的 Hermes 内容更新可以从同一台安装了仓库依赖的构建机发布。仓库根目录执行以下命令，也可用 `--platform ios` 或 `--platform android` 只发布一个平台。

```sh
export FROGCODER_UPDATE_PRIVATE_KEY="$HOME/.frogcoder-ota/private-key.pem"
node scripts/publish-mobile-ota.mjs --relay-url http://relay.example:8787 \
  --output-dir .local/ota-release/mobile-ota
```

脚本从仓库根目录的 `package.json` 读取对应的 Relay 版本，导出 Hermes bundle 并签发清单。发布地址应与手机登录时填写的 Relay 地址一致。将产物部署到 Relay 数据目录的 `mobile-ota/`。先复制 `assets/` 中的资源，再原子替换 `<Relay 版本>/ios/` 或 `<Relay 版本>/android/` 中对应指纹的 JSON 清单。资源按内容哈希命名，保留客户端仍在下载的历史资源。部署清单和资源即可生效，Relay 每次检查都会读取当前版本的清单。

客户端按系统和指纹匹配，安装包仅接收与其原生接口兼容的更新。首次发布应在对应安装包构建完成之后进行，使清单时间晚于内置版本。要回退已有更新，可用同一原生基线重新发布确认过的旧内容，由用户在 App 内下载并切换。

构建和发布均使用仓库安装的工具，手机端直接连接配置的 Relay，无需 Expo 云服务或账号。
