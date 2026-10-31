#include "native.h"
namespace Native {
Service::Service(QString profile, QObject *parent)
    : QObject(parent), directory(std::move(profile)) {}
Service::~Service() { closeAgent(); }
Object Service::defaults() const {
  return {{"relayUrl", ""},
          {"username", ""},
          {"deviceName", QSysInfo::machineHostName()},
          {"installationId", uuid()},
          {"codexHome", QDir::homePath() + "/.codex"},
          {"codexBinary", ""},
          {"projectParents", Array{}},
          {"runtime", "auto"},
          {"autoConnect", false},
          {"openAtLogin", false},
          {"minimizeToTray", true},
          {"allowHttp", false}};
}
void Service::start() {
  QScopedValueRollback<int> serialized(depth, depth + 1);
  network = new QNetworkAccessManager(this);
  desktop = new Desktop(this);
  maintenance = new QTimer(this);
  maintenance->setInterval(250);
  connect(maintenance, &QTimer::timeout, this, [this] { tick(); });
  attachDesktop();
  try {
    initialize();
  } catch (...) {
    emit message({{"event", "fatal"},
                  {"value", "原生后台初始化失败，请检查配置与系统凭据。"}});
  }
  maintenance->start();
}
void Service::initialize() {
  QDir().mkpath(directory);
  settings = defaults();
  try {
    settings = merged(
        settings, parse(read(directory + "/settings.json", 65536)).toObject());
  } catch (...) {
  }
  view = {{"settings", settings},
          {"loggedIn", false},
          {"secureStorage", false},
          {"busy", true},
          {"phase", "signed-out"},
          {"status", QJsonValue::Null},
          {"logs", Array{}},
          {"error", ""},
          {"expiresAt", QJsonValue::Null},
          {"version", CODEXER_AGENT_VERSION}};
  updateState = {{"release", QJsonValue::Null},
                 {"available", false},
                 {"downloading", false},
                 {"downloaded", false},
                 {"progress", 0},
                 {"version", CODEXER_AGENT_VERSION},
                 {"error", ""}};
  view["secureStorage"] = native("vault.available").toBool();
  try {
    restoreCredentials();
  } catch (...) {
    log("credential-restore-failed");
    view["error"] = "无法恢复系统加密的登录状态，请重新登录。";
  }
  initialized = true;
  view["busy"] = false;
  publish();
  persist(settings);
  log("console-ready");
  if (settings["autoConnect"].toBool() && !credentials.isEmpty())
    try {
      connectAgent();
    } catch (const Error &e) {
      view["startupError"] = e.code;
      view["error"] = "自动连接失败，请检查网络后重新连接。";
      publish();
    } catch (...) {
      view["error"] = "自动连接失败，请检查网络后重新连接。";
      publish();
    }
}
void Service::publish() {
  view["settings"] = settings;
  emit message({{"event", "state"}, {"value", view}});
}
void Service::log(const QString &code) {
  auto logs = view["logs"].toArray();
  while (logs.size() >= 200)
    logs.removeFirst();
  auto safe =
      QRegularExpression("^[a-z][a-z0-9-]{0,100}$").match(code).hasMatch()
          ? code
          : "diagnostic-redacted";
  logs.append(Object{{"at", double(now())}, {"code", safe}});
  view["logs"] = logs;
  publish();
}
QJsonValue Service::native(const QString &method, Object value) {
  int id = ++nativeSerial;
  emit message({{"nativeId", id}, {"method", method}, {"value", value}});
  if (!waitFor([&] { return platformResponses.contains(id); }, 30000))
    throw Error("native-request-timeout");
  auto response = platformResponses.take(id);
  if (response["error"].isString())
    throw Error(response["error"].toString());
  return response["value"];
}
void Service::persist(const Object &value) {
  native("loginItem", {{"enabled", value["openAtLogin"]}});
  save(directory + "/settings.json", json(value));
}
void Service::storeCredentials(const Object &value) {
  auto encrypted =
      native("protect",
             {{"value", QString::fromLatin1(json(value).toBase64())}})
          .toString();
  save(directory + "/session.native.enc",
       QByteArray::fromBase64(encrypted.toLatin1()));
}
void Service::restoreCredentials() {
  QByteArray bytes;
  bool legacy = false;
  if (QFileInfo::exists(directory + "/session.native.enc"))
    bytes = read(directory + "/session.native.enc", 65536);
  else if (QFileInfo::exists(directory + "/session.enc")) {
    bytes = read(directory + "/session.enc", 65536);
    legacy = true;
  } else
    return;
  Object request{{"value", QString::fromLatin1(bytes.toBase64())}};
  if (legacy && platform() == "win32" && bytes.startsWith("v10")) {
    auto state =
        parse(read(directory + "/Local State", 1024 * 1024)).toObject();
    request["key"] = state["os_crypt"].toObject()["encrypted_key"];
  }
  auto plaintext = native(legacy && bytes.startsWith("v10") ? "legacyUnprotect"
                                                            : "unprotect",
                          request)
                       .toString();
  auto restored =
      parse(QByteArray::fromBase64(plaintext.toLatin1())).toObject();
  if (restored["session"].toString().isEmpty() ||
      restored["installationId"] != settings["installationId"] ||
      restored["relayUrl"] != settings["relayUrl"]) {
    QFile::remove(directory + "/session.native.enc");
    QFile::remove(directory + "/session.enc");
    return;
  }
  if (legacy)
    storeCredentials(restored);
  credentials = restored;
  view["loggedIn"] = true;
  view["phase"] = "disconnected";
  view["expiresAt"] = restored["expiresAt"];
}
void Service::clearCredentials(bool revoke) {
  if (download) {
    download->abort();
    finishDownload();
  }
  auto old = credentials;
  if (revoke && !old.isEmpty())
    try {
      http("POST", "/v1/auth/logout");
    } catch (...) {
      log("logout-server-unreachable");
    }
  credentials = {};
  QFile::remove(directory + "/session.native.enc");
  QFile::remove(directory + "/session.enc");
  view["loggedIn"] = false;
  view["expiresAt"] = QJsonValue::Null;
  view["phase"] = "signed-out";
  downloadedPath.clear();
  updateState["release"] = QJsonValue::Null;
  updateState["available"] = false;
  updateState["downloaded"] = false;
  emit message({{"event", "updates"}, {"value", updateState}});
  publish();
}
QByteArray Service::http(const QString &method, const QString &path,
                         const QByteArray &body, qint64 limit, int timeout,
                         bool authenticate) {
  QUrl root(credentials["relayUrl"].toString(settings["relayUrl"].toString()));
  QUrl url = root.resolved(QUrl(path));
  if (url.scheme() != root.scheme() || url.authority() != root.authority())
    throw Error("invalid-url");
  QNetworkRequest request(url);
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                       QNetworkRequest::ManualRedirectPolicy);
  request.setTransferTimeout(timeout);
  request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
  if (authenticate) {
    request.setRawHeader("Authorization",
                         "Bearer " +
                             credentials["session"].toString().toUtf8());
    request.setRawHeader("x-device-id",
                         credentials["deviceId"].toString().toUtf8());
  }
  auto reply = network->sendCustomRequest(request, method.toUtf8(), body);
  QByteArray result;
  bool excessive = false;
  connect(reply, &QIODevice::readyRead, reply, [&] {
    result += reply->readAll();
    if (result.size() > limit) {
      excessive = true;
      reply->abort();
    }
  });
  bool completed = waitFor([&] { return reply->isFinished(); }, timeout + 500);
  if (!completed)
    reply->abort();
  result += reply->readAll();
  int status =
      reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
  auto error = reply->error();
  reply->disconnect();
  reply->deleteLater();
  if (excessive || result.size() > limit)
    throw Error("response-too-large");
  if (!completed || error != QNetworkReply::NoError) {
    if (status)
      throw Error("http-" + QString::number(status));
    throw Error("network-unavailable");
  }
  if (status < 200 || status >= 300)
    throw Error("http-" + QString::number(status));
  return result;
}
void Service::submit(const Object &value) {
  if (value.contains("nativeId")) {
    platformResponses[value["nativeId"].toInt()] = value;
    return;
  }
  uiQueue.append(value);
  if (depth) {
    // Revoke permission immediately while a transport wait is pumping events.
    // Full teardown remains serialized after the in-flight call returns.
    const auto method = value["method"].toString();
    if (QStringList{"disconnect", "logout", "shutdown", "reconnect"}.contains(
            method))
      pause();
    return;
  }
  while (!uiQueue.isEmpty()) {
    auto request = uiQueue.takeFirst();
    const int id = request["id"].toInt();
    ++depth;
    try {
      auto result =
          dispatch(request["method"].toString(), request["value"].toObject());
      emit message({{"id", id}, {"value", result}});
    } catch (const Error &e) {
      view["error"] = e.code;
      emit message({{"id", id}, {"error", e.code}});
    } catch (...) {
      emit message({{"id", id}, {"error", "native-operation-failed"}});
    }
    --depth;
    view["busy"] = false;
    publish();
    if (stopping) {
      emit finished();
      return;
    }
  }
}
Object Service::dispatch(const QString &method, Object value) {
  if (!initialized && method != "shutdown")
    throw Error("service-starting");
  if (method == "state")
    return view;
  if (method == "updates.state")
    return updateState;
  view["busy"] = true;
  view["error"] = "";
  publish();
  auto idle = [&] {
    if (active())
      throw Error("本机仍有任务运行，请等待任务结束后修改配置。");
  };
  auto validateUrl = [&](const Object &s) {
    QUrl url(s["relayUrl"].toString().trimmed());
    bool local =
        QStringList{"localhost", "127.0.0.1", "::1"}.contains(url.host());
    if (!url.isValid() || url.host().isEmpty() ||
        !QStringList{"http", "https"}.contains(url.scheme()) ||
        !url.userInfo().isEmpty() || url.hasQuery() || url.hasFragment() ||
        (!url.path().isEmpty() && url.path() != "/") ||
        (url.scheme() == "http" && !local && !s["allowHttp"].toBool()))
      throw Error("请输入有效的 HTTPS 服务器地址；HTTP 需在设置中明确允许。");
    url.setPath({});
    return url.toString();
  };
  if (method == "save") {
    value = merged(defaults(), value);
    value["installationId"] = settings["installationId"];
    if (value["deviceName"].toString().trimmed().isEmpty() ||
        value["deviceName"].toString().size() > 200 ||
        value["codexHome"].toString().size() > 4096 ||
        value["projectParents"].toArray().size() > 20 ||
        !QStringList{"auto", "desktop", "headless"}.contains(
            value["runtime"].toString()))
      throw Error("设置格式不正确。");
    if (!value["relayUrl"].toString().isEmpty())
      value["relayUrl"] = validateUrl(value);
    bool changed = false;
    for (const auto &key :
         {"relayUrl", "deviceName", "codexHome", "codexBinary", "runtime",
          "allowHttp", "projectParents"})
      changed |= value[key] != settings[key];
    if (changed) {
      idle();
      pause();
      closeAgent();
    }
    Array parents;
    for (const auto &v : value["projectParents"].toArray()) {
      QFileInfo info(v.toString());
      if (!info.isAbsolute() || !info.isDir() ||
          info.canonicalFilePath().isEmpty())
        throw Error("授权目录不存在，请重新选择。");
      auto path = QDir::toNativeSeparators(info.canonicalFilePath());
      if (!parents.contains(path))
        parents.append(path);
    }
    value["projectParents"] = parents;
    if (value["relayUrl"] != settings["relayUrl"] ||
        value["deviceName"] != settings["deviceName"])
      clearCredentials(true);
    persist(value);
    settings = value;
    log("settings-saved");
    return {{"saved", true}};
  }
  if (method == "login") {
    idle();
    auto url = validateUrl(settings);
    auto username = value["username"].toString().trimmed(),
         password = value["password"].toString();
    if (username.isEmpty() || password.isEmpty() || password.size() > 128)
      throw Error("请输入账号和密码。");
    if (!native("vault.available").toBool())
      throw Error("系统安全存储不可用。");
    pause();
    closeAgent();
    clearCredentials(true);
    settings["relayUrl"] = url;
    auto response =
        parse(http("POST", "/v1/agents/login",
                   json(Object{{"username", username},
                               {"password", password},
                               {"installationId", settings["installationId"]},
                               {"name", settings["deviceName"]},
                               {"platform", platform()}}),
                   65536, 15000, false))
            .toObject();
    if (response["session"].toString().isEmpty() ||
        QUuid(response["deviceId"].toString()).isNull() ||
        !response["expiresAt"].isDouble())
      throw Error("服务器登录响应不兼容。");
    credentials =
        merged(response, {{"relayUrl", url},
                          {"username", username},
                          {"installationId", settings["installationId"]}});
    try {
      storeCredentials(credentials);
      settings["username"] = username;
      persist(settings);
    } catch (...) {
      clearCredentials(true);
      throw;
    }
    view["loggedIn"] = true;
    view["expiresAt"] = credentials["expiresAt"];
    view["phase"] = "disconnected";
    log("account-login-succeeded");
    connectAgent();
    return {{"connected", true}};
  }
  if (method == "logout") {
    pause();
    clearCredentials(true);
    log("account-logged-out");
    return {};
  }
  if (method == "disconnect") {
    pause();
    return {};
  }
  if (method == "connect" || method == "reconnect") {
    if (method == "reconnect")
      pause();
    connectAgent();
    return {};
  }
  if (method == "refreshRuntime") {
    refreshRequested = true;
    auto result = refresh(true);
    return {{"runtimeRefresh", result}};
  }
  if (method == "releaseSessions")
    return release(true);
  if (method == "openControl") {
    native("openUrl", {{"url", settings["relayUrl"].toString() + "/control"}});
    return {};
  }
  if (method == "exportLogs") {
    auto path =
        native("saveDialog", {{"name", "codexer-diagnostics.json"}}).toString();
    if (!path.isEmpty())
      save(path, json(Object{{"version", CODEXER_AGENT_VERSION},
                             {"backend", "C++/Qt"},
                             {"platform", platform()},
                             {"phase", view["phase"]},
                             {"status", view["status"]},
                             {"logs", view["logs"]}}));
    return {{"path", path}};
  }
  if (method == "updates.check") {
    checkUpdate();
    return {};
  }
  if (method == "updates.download") {
    downloadUpdate();
    return {};
  }
  if (method == "updates.cancel") {
    if (download)
      download->abort();
    return {};
  }
  if (method == "updates.open") {
    idle();
    auto release = updateState["release"].toObject();
    QFile package(downloadedPath);
    if (downloadedPath.isEmpty() || !package.open(QIODevice::ReadOnly) ||
        package.size() != release["size"].toDouble())
      throw Error("update-verification-failed");
    QCryptographicHash digest(QCryptographicHash::Sha256);
    while (!package.atEnd())
      digest.addData(package.read(65536));
    if (QString::fromLatin1(digest.result().toHex()) !=
        release["sha256"].toString())
      throw Error("update-verification-failed");
    package.close();
    native(qEnvironmentVariableIsSet("PORTABLE_EXECUTABLE_FILE")
               ? "showPackage"
               : "openPackage",
           {{"path", downloadedPath}});
    return {};
  }
  if (method == "shutdown") {
    stopping = true;
    if (download)
      download->abort();
    closeAgent();
    return {};
  }
  throw Error("unknown-operation");
}
void Service::checkUpdate() {
  if (credentials.isEmpty())
    throw Error("请先登录账号。");
  auto target = platform() == "win32"
                    ? qEnvironmentVariableIsSet("PORTABLE_EXECUTABLE_FILE")
                          ? "agent-windows-x64-portable"
                          : "agent-windows-x64-setup"
                : QSysInfo::currentCpuArchitecture() == "arm64"
                    ? "agent-macos-arm64"
                    : "agent-macos-x64";
  auto response =
      parse(http("GET", "/v1/client-releases/" + QString(target))).toObject();
  auto release = response["release"].toObject();
  if (!release.isEmpty() && (QUuid(release["id"].toString()).isNull() ||
                             !QRegularExpression("^[0-9]+\\.[0-9]+\\.[0-9]+$")
                                  .match(release["version"].toString())
                                  .hasMatch() ||
                             !QRegularExpression("^[a-f0-9]{64}$")
                                  .match(release["sha256"].toString())
                                  .hasMatch() ||
                             release["size"].toDouble() <= 0 ||
                             release["size"].toDouble() > 512LL * 1024 * 1024 ||
                             release["target"] != target))
    throw Error("invalid-client-release");
  if (updateState["release"].toObject()["id"] != release["id"]) {
    if (download)
      download->abort();
    downloadedPath.clear();
    updateState["downloaded"] = false;
  }
  updateState["release"] =
      release.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(release);
  updateState["available"] =
      !release.isEmpty() &&
      QVersionNumber::compare(
          QVersionNumber::fromString(release["version"].toString()),
          QVersionNumber::fromString(CODEXER_AGENT_VERSION)) > 0;
  updateState["error"] = "";
  emit message({{"event", "updates"}, {"value", updateState}});
}
void Service::downloadUpdate() {
  if (download)
    return;
  auto release = updateState["release"].toObject();
  if (!updateState["available"].toBool() || release.isEmpty())
    throw Error("no-client-update");
  auto name =
      release["id"].toString() + (platform() == "win32" ? ".exe" : ".dmg");
  QDir().mkpath(directory + "/client-updates");
  downloadedPath.clear();
  updateState["downloaded"] = false;
  updateState["error"] = "";
  downloadFile = new QSaveFile(directory + "/client-updates/" + name);
  if (!downloadFile->open(QIODevice::WriteOnly)) {
    delete downloadFile;
    downloadFile = nullptr;
    throw Error("update-download-failed");
  }
  downloadHash.reset();
  downloadedBytes = 0;
  QUrl base(credentials["relayUrl"].toString());
  auto relative = "/v1/client-releases/" + release["target"].toString() + '/' +
                  release["id"].toString() + "/download";
  QUrl url = base.resolved(QUrl(relative));
  if (url.authority() != base.authority() || url.scheme() != base.scheme())
    throw Error("invalid-update-url");
  QNetworkRequest request(url);
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                       QNetworkRequest::ManualRedirectPolicy);
  request.setTransferTimeout(60000);
  request.setRawHeader("Authorization",
                       "Bearer " + credentials["session"].toString().toUtf8());
  request.setRawHeader("x-device-id",
                       credentials["deviceId"].toString().toUtf8());
  download = network->get(request);
  updateState["downloading"] = true;
  updateState["progress"] = 0;
  connect(download, &QIODevice::readyRead, this, [this] {
    if (!download || !downloadFile)
      return;
    auto bytes = download->readAll();
    downloadedBytes += bytes.size();
    if (downloadedBytes >
            updateState["release"].toObject()["size"].toDouble() ||
        downloadFile->write(bytes) != bytes.size()) {
      download->abort();
      return;
    }
    downloadHash.addData(bytes);
    updateState["progress"] =
        double(downloadedBytes) /
        updateState["release"].toObject()["size"].toDouble();
    emit message({{"event", "updates"}, {"value", updateState}});
  });
  connect(download, &QNetworkReply::finished, this,
          [this] { finishDownload(); });
  emit message({{"event", "updates"}, {"value", updateState}});
}
void Service::finishDownload() {
  if (!download)
    return;
  auto reply = download;
  download = nullptr;
  auto release = updateState["release"].toObject();
  bool ok =
      reply->error() == QNetworkReply::NoError &&
      reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() ==
          200 &&
      downloadedBytes == release["size"].toDouble() &&
      QString::fromLatin1(downloadHash.result().toHex()) ==
          release["sha256"].toString();
  if (downloadFile) {
    if (ok && downloadFile->commit())
      downloadedPath = downloadFile->fileName();
    else {
      downloadFile->cancelWriting();
      ok = false;
    }
    delete downloadFile;
    downloadFile = nullptr;
  }
  reply->deleteLater();
  updateState["downloading"] = false;
  updateState["downloaded"] = ok;
  updateState["error"] = ok ? "" : "update-download-failed";
  emit message({{"event", "updates"}, {"value", updateState}});
}
} // namespace Native
