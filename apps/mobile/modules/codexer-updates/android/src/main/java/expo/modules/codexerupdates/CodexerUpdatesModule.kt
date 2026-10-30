package expo.modules.codexerupdates

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

class CodexerUpdatesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CodexerUpdates")

    // AsyncFunction runs on Expo's background queue. Stream the APK in native
    // code so large packages never pass through Hermes or block the UI thread.
    AsyncFunction("verifyApk") { uri: String, size: Double, expected: String ->
      val context = requireNotNull(appContext.reactContext)
      val directory = File(context.cacheDir, "codexer-updates").canonicalFile
      val parsed = Uri.parse(uri)
      require(parsed.scheme == "file")
      val file = File(requireNotNull(parsed.path)).canonicalFile
      require(file.parentFile == directory && file.extension == "apk")
      require(size > 0 && size == size.toLong().toDouble())
      require(expected.matches(Regex("[0-9a-f]{64}")))
      if (!file.isFile || file.length() != size.toLong()) return@AsyncFunction false
      val hash = MessageDigest.getInstance("SHA-256")
      file.inputStream().buffered().use { input ->
        val buffer = ByteArray(256 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          hash.update(buffer, 0, count)
        }
      }
      val actual = hash.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
      actual == expected && file.length() == size.toLong()
    }

    // startActivityForResult waits until the installer closes. Resolve as soon
    // as Android accepts the launch instead, and keep the verified APK for retry.
    AsyncFunction("openInstaller") { contentUri: String ->
      val activity = requireNotNull(appContext.currentActivity)
      val uri = Uri.parse(contentUri)
      require(uri.scheme == "content" && uri.authority == "${activity.packageName}.FileSystemFileProvider")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
        "permission-required"
      } else {
        activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        })
        "opened"
      }
    }.runOnQueue(Queues.MAIN)
  }
}
