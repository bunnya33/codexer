[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$AndroidDirectory,
  [string]$SigningDirectory = (Join-Path $env:LOCALAPPDATA 'Codexer/AndroidSigning'),
  [string]$OutputDirectory,
  [string]$JavaDirectory,
  [string]$BuildToolsDirectory
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$package = Get-Content (Join-Path $repoRoot 'apps/mobile/package.json') -Raw | ConvertFrom-Json
$config = Get-Content (Join-Path $repoRoot 'apps/mobile/app.json') -Raw | ConvertFrom-Json
$version = $package.version
$versionCode = $config.expo.android.versionCode
if ($version -ne $config.expo.version) { throw 'Android source versions do not match.' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repoRoot "release/android-$version" }
if (!$JavaDirectory -and (Test-Path 'C:/Program Files/Android/Android Studio/jbr/bin/java.exe')) { $JavaDirectory = 'C:/Program Files/Android/Android Studio/jbr' }
if (!$JavaDirectory) { $JavaDirectory = $env:JAVA_HOME }
if (!$JavaDirectory) { throw 'Set -JavaDirectory to JDK 17 or later (Android Studio jbr is recommended).' }
$javaRelease = Get-Content (Join-Path $JavaDirectory 'release') -Raw
$javaVersion = [regex]::Match($javaRelease, 'JAVA_VERSION="(\d+)').Groups[1].Value
if (!$javaVersion -or [int]$javaVersion -lt 17) { throw 'Android Release requires JDK 17 or later. Do not use system Java 8.' }
if (!$BuildToolsDirectory) {
  $sdk = $env:ANDROID_HOME
  if (!$sdk) { $sdk = $env:ANDROID_SDK_ROOT }
  if (!$sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
  $BuildToolsDirectory = Join-Path $sdk 'build-tools/36.0.0'
}
$AndroidDirectory = (Resolve-Path -LiteralPath $AndroidDirectory).Path
$gradle = Get-Content (Join-Path $AndroidDirectory 'app/build.gradle') -Raw
if ($gradle -notmatch 'signingConfig\s+signingConfigs\.controlRelease' -or
    $gradle -notmatch 'CODEXER_ANDROID_KEYSTORE' -or $gradle -notmatch 'CODEXER_ANDROID_STORE_PASSWORD') {
  throw 'Release signing is not configured. Follow docs/android-signing.md; never use debug signing for release.'
}
if ($gradle -notmatch "versionCode\s+$versionCode\b" -or $gradle -notmatch ('versionName\s+["'']' + [regex]::Escape($version) + '["'']')) {
  throw 'Native project version differs from source. Sync the current source and native version before building.'
}
$expectedCertificate = '5e8f351666c250682effb88a1ebec7ca4d13196e9f272e054f5881eaa393a211'
$savedEnvironment = @{}
foreach ($name in @('CODEXER_ANDROID_KEYSTORE','CODEXER_ANDROID_STORE_PASSWORD','JAVA_HOME','PATH','NODE_ENV')) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$clearPassword = $null
try {
  if (!$env:CODEXER_ANDROID_KEYSTORE) { $env:CODEXER_ANDROID_KEYSTORE = Join-Path $SigningDirectory 'control-release.p12' }
  if (!(Test-Path -LiteralPath $env:CODEXER_ANDROID_KEYSTORE -PathType Leaf)) { throw 'Original release keystore is missing. Do not generate a replacement.' }
  if (!$env:CODEXER_ANDROID_STORE_PASSWORD) {
    Add-Type -AssemblyName System.Security
    $encryptedPassword = [IO.File]::ReadAllBytes((Join-Path $SigningDirectory 'control-release.password.dpapi'))
    $clearPassword = [Security.Cryptography.ProtectedData]::Unprotect($encryptedPassword, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $env:CODEXER_ANDROID_STORE_PASSWORD = [Text.Encoding]::UTF8.GetString($clearPassword)
  }
  $env:JAVA_HOME = $JavaDirectory
  $env:PATH = (Join-Path $JavaDirectory 'bin') + ';' + $env:PATH
  $env:NODE_ENV = 'production'
  $certificateOutput = & (Join-Path $JavaDirectory 'bin/keytool.exe') -list -rfc -keystore $env:CODEXER_ANDROID_KEYSTORE -storetype PKCS12 -storepass:env CODEXER_ANDROID_STORE_PASSWORD -alias codexer-control
  if ($LASTEXITCODE -ne 0) { throw 'Cannot unlock the original release signing alias.' }
  $certificateBlock = [regex]::Match(($certificateOutput -join "`n"), '-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----')
  if (!$certificateBlock.Success) { throw 'Cannot read release certificate.' }
  $digest = [Security.Cryptography.SHA256]::Create()
  try { $certificateHash = ([BitConverter]::ToString($digest.ComputeHash([Convert]::FromBase64String($certificateBlock.Groups[1].Value))) -replace '-','').ToLowerInvariant() } finally { $digest.Dispose() }
  if ($certificateHash -ne $expectedCertificate) { throw 'Certificate does not match existing Codexer Android releases.' }
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  $OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
  $buildLog = Join-Path $OutputDirectory 'build.log'
  $errorLog = Join-Path $OutputDirectory 'build-stderr.log'
  $build = Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/c','gradlew.bat :app:assembleRelease --no-daemon --max-workers=2' -WorkingDirectory $AndroidDirectory -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $buildLog -RedirectStandardError $errorLog
  if ($build.ExitCode -ne 0) { throw "Gradle failed ($($build.ExitCode)). See $buildLog and $errorLog" }
  $builtApk = Join-Path $AndroidDirectory 'app/build/outputs/apk/release/app-release.apk'
  $signature = & (Join-Path $BuildToolsDirectory 'apksigner.bat') verify --verbose --print-certs $builtApk
  if ($LASTEXITCODE -ne 0 -or ($signature -join "`n") -notmatch $expectedCertificate) { throw 'APK signature verification failed.' }
  $badging = & (Join-Path $BuildToolsDirectory 'aapt.exe') dump badging $builtApk
  if ($LASTEXITCODE -ne 0 -or ($badging -join "`n") -notmatch ("name='com.bunnya33.codexer.remote' versionCode='$versionCode' versionName='" + [regex]::Escape($version) + "'") -or ($badging -join "`n") -match 'application-debuggable') { throw 'APK application ID, version or release manifest is incorrect.' }
  $alignment = & (Join-Path $BuildToolsDirectory 'zipalign.exe') -c -P 16 -v 4 $builtApk
  if ($LASTEXITCODE -ne 0) { throw 'APK 16 KiB ZIP alignment verification failed.' }
  $apkName = "Codexer-Control-$version.apk"
  $apk = Join-Path $OutputDirectory $apkName
  Copy-Item -LiteralPath $builtApk -Destination $apk
  $apkHash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
  $signature | Set-Content (Join-Path $OutputDirectory 'signature.txt') -Encoding UTF8
  $badging | Set-Content (Join-Path $OutputDirectory 'badging.txt') -Encoding UTF8
  $alignment | Set-Content (Join-Path $OutputDirectory 'zipalign.txt') -Encoding UTF8
  "$apkHash  $apkName" | Set-Content (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Encoding ASCII
  @{version=$version;versionCode=$versionCode;certificateSha256=$certificateHash;apk=$apk;sha256=$apkHash;gradleSucceeded=$true;createdAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'signing-verification.json') -Encoding UTF8
  Write-Output "Built signed Codexer Control $version (versionCode $versionCode): $apk"
} finally {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
  if ($null -ne $clearPassword) { [Array]::Clear($clearPassword, 0, $clearPassword.Length) }
}
