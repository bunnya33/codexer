#include "native.h"
#include <QtEndian>
#ifdef Q_OS_WIN
#include <windows.h>
#else
#include <sys/stat.h>
#endif

namespace Native {
qint64 now() { return QDateTime::currentMSecsSinceEpoch(); }
QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QByteArray json(const QJsonValue &value) {
  return value.isArray()
             ? QJsonDocument(value.toArray()).toJson(QJsonDocument::Compact)
             : QJsonDocument(value.toObject()).toJson(QJsonDocument::Compact);
}
QJsonValue parse(const QByteArray &value) {
  QJsonParseError e;
  auto doc = QJsonDocument::fromJson(value, &e);
  if (e.error != QJsonParseError::NoError)
    throw Error("invalid-json");
  return doc.isArray() ? QJsonValue(doc.array()) : QJsonValue(doc.object());
}
QByteArray read(const QString &path, qint64 limit) {
  QFile f(path);
  if (!f.open(QIODevice::ReadOnly))
    throw Error("file-unavailable");
  if (f.size() > limit)
    throw Error("file-too-large");
  return f.readAll();
}
void save(const QString &path, const QByteArray &bytes) {
  QDir().mkpath(QFileInfo(path).absolutePath());
  QSaveFile f(path);
  if (!f.open(QIODevice::WriteOnly))
    throw Error("file-write-failed");
  f.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
  if (f.write(bytes) != bytes.size() || !f.commit())
    throw Error("file-write-failed");
}
QString hash(const QByteArray &bytes) {
  return QString::fromLatin1(
      QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
}
QString canonical(const QString &path) {
  auto value =
      QDir::cleanPath(QFileInfo(path).absoluteFilePath()).replace('\\', '/');
#ifdef Q_OS_WIN
  value = value.toLower();
#endif
  return value;
}
bool within(const QString &root, const QString &path) {
  auto base = canonical(root), target = canonical(path);
  return target == base || target.startsWith(base + '/');
}
bool waitFor(const std::function<bool()> &done, int timeout) {
  QElapsedTimer elapsed;
  elapsed.start();
  while (!done() && elapsed.elapsed() < timeout) {
    QEventLoop loop;
    QTimer::singleShot(10, &loop, &QEventLoop::quit);
    loop.exec();
  }
  return done();
}
Object merged(Object left, const Object &right) {
  for (auto it = right.begin(); it != right.end(); ++it)
    left[it.key()] = it.value();
  return left;
}
QString platform() {
#ifdef Q_OS_WIN
  return "win32";
#elif defined(Q_OS_MACOS)
  return "darwin";
#else
  return "linux";
#endif
}
QString executable(const Object &settings) {
  QStringList candidates;
  auto override = settings["codexBinary"].toString();
  if (override.isEmpty())
    override = qEnvironmentVariable("CODEX_REMOTE_CODEX_BIN");
  if (!override.isEmpty())
    candidates << override;
  else {
#ifdef Q_OS_WIN
    QDir root(qEnvironmentVariable("LOCALAPPDATA") + "/OpenAI/Codex/bin");
    auto versions = root.entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot);
    std::sort(versions.begin(), versions.end(),
              [](const QFileInfo &a, const QFileInfo &b) {
                auto complete = [](const QFileInfo &i) {
                  return QFileInfo::exists(i.filePath() +
                                           "/codex-code-mode-host.exe");
                };
                if (complete(a) != complete(b))
                  return complete(a);
                return QFileInfo(a.filePath() + "/codex.exe").lastModified() >
                       QFileInfo(b.filePath() + "/codex.exe").lastModified();
              });
    for (const auto &version : versions)
      candidates << version.filePath() + "/codex.exe";
#elif defined(Q_OS_MACOS)
    candidates << "/Applications/Codex.app/Contents/Resources/codex"
               << QDir::homePath() +
                      "/Applications/Codex.app/Contents/Resources/codex"
               << "/opt/homebrew/bin/codex" << "/usr/local/bin/codex";
#endif
    candidates << QStandardPaths::findExecutable(
        platform() == "win32" ? "codex.exe" : "codex");
  }
  for (const auto &candidate : candidates)
    if (QFileInfo(candidate).isFile())
      return QFileInfo(candidate).absoluteFilePath();
  throw Error("codex-binary-not-found");
}
QString fingerprint(const QString &path) {
  QFileInfo f(path), host(f.absolutePath() + "/codex-code-mode-host.exe");
  return hash(json(Array{canonical(path), double(f.size()),
                         double(f.lastModified().toMSecsSinceEpoch()),
                         double(host.size()),
                         double(host.lastModified().toMSecsSinceEpoch())}));
}
QString fileIdentity(const QString &path) {
#ifdef Q_OS_WIN
  auto native = QDir::toNativeSeparators(QFileInfo(path).absoluteFilePath());
  if (!native.startsWith("\\\\?\\"))
    native = native.startsWith("\\\\") ? "\\\\?\\UNC\\" + native.mid(2)
                                       : "\\\\?\\" + native;
  HANDLE handle = CreateFileW(
      reinterpret_cast<LPCWSTR>(native.utf16()), 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE)
    throw Error("file-unavailable");
  BY_HANDLE_FILE_INFORMATION info{};
  bool ok = GetFileInformationByHandle(handle, &info);
  CloseHandle(handle);
  if (!ok || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
    throw Error("project-directory-unsafe");
  return QString("%1:%2:%3")
      .arg(info.dwVolumeSerialNumber)
      .arg(info.nFileIndexHigh)
      .arg(info.nFileIndexLow);
#else
  struct stat info{};
  if (::lstat(path.toUtf8().constData(), &info) || S_ISLNK(info.st_mode))
    throw Error("project-directory-unsafe");
  return QString("%1:%2").arg(info.st_dev).arg(info.st_ino);
#endif
}

Rpc::Rpc(QObject *parent) : QObject(parent) {
#ifdef Q_OS_WIN
  process.setCreateProcessArgumentsModifier(
      [](QProcess::CreateProcessArguments *args) {
        args->flags |= 0x08000000;
      });
#endif
  connect(&process, &QProcess::readyReadStandardError, this,
          [this] { process.readAllStandardError(); });
  connect(&process, &QProcess::finished, this,
          [this](int, auto) { emit disconnected(); });
  connect(&process, &QProcess::readyReadStandardOutput, this, [this] {
    buffer += process.readAllStandardOutput();
    if (buffer.size() > 64 * 1024 * 1024) {
      process.kill();
      return;
    }
    for (int end; (end = buffer.indexOf('\n')) >= 0;) {
      auto line = buffer.left(end);
      buffer.remove(0, end + 1);
      Object message;
      try {
        message = parse(line).toObject();
      } catch (...) {
        continue;
      }
      if (message.contains("id") && !message.contains("method")) {
        auto id = message["id"].toVariant().toString();
        if (waiting.contains(id))
          responses[id] = message;
      } else if (message.contains("id"))
        emit serverRequest(message);
      else
        emit notification(message["method"].toString(),
                          message["params"].toObject());
    }
  });
}
Rpc::~Rpc() { stop(); }
bool Rpc::connected() const {
  return process.state() == QProcess::Running && !stopping;
}
void Rpc::start(const Object &settings) {
  if (!QFileInfo(settings["codexHome"].toString()).isDir())
    throw Error("codex-home-unavailable");
  binary = executable(settings);
  identity = fingerprint(binary);
  stopping = false;
  auto env = QProcessEnvironment::systemEnvironment();
  env.insert("CODEX_HOME", settings["codexHome"].toString());
  process.setProcessEnvironment(env);
  process.setWorkingDirectory(QFileInfo(binary).absolutePath());
  process.start(binary, {"app-server", "--listen", "stdio://"});
  if (!process.waitForStarted(5000))
    throw Error("app-server-unavailable");
  call("initialize",
       {{"clientInfo", Object{{"name", "codexer-native-agent"},
                              {"title", "Codexer Agent"},
                              {"version", CODEXER_AGENT_VERSION}}},
        {"capabilities", Object{{"experimentalApi", true}}}});
  process.write(json(Object{{"method", "initialized"}}) + '\n');
}
void Rpc::stop() {
  if (process.state() == QProcess::NotRunning)
    return;
  stopping = true;
  process.closeWriteChannel();
  if (!process.waitForFinished(1000)) {
    process.kill();
    process.waitForFinished(3000);
  }
  buffer.clear();
  responses.clear();
  waiting.clear();
}
Object Rpc::call(const QString &method, Object params, int timeout) {
  if (!connected())
    throw Error("app-server-disconnected");
  const auto id = QString::number(++serial);
  waiting.insert(id);
  process.write(
      json(Object{{"id", id}, {"method", method}, {"params", params}}) + '\n');
  const bool received =
      waitFor([&] { return responses.contains(id) || !connected(); }, timeout);
  waiting.remove(id);
  if (!received || !responses.contains(id))
    throw Error(connected() ? method + "-timeout" : "app-server-disconnected",
                method != "thread/read" && !method.endsWith("/list"));
  auto response = responses.take(id);
  if (response.contains("error")) {
    auto message = response["error"].toObject()["message"].toString();
    if (method == "thread/resume" &&
        message.contains("already has an active writer", Qt::CaseInsensitive))
      throw Error("thread-writer-busy");
    throw Error(method + "-rejected:" + message);
  }
  return response["result"].toObject();
}
void Rpc::respond(const QJsonValue &id, const Object &result,
                  const QString &error) {
  Object response{{"id", id}};
  if (error.isEmpty())
    response["result"] = result;
  else
    response["error"] = Object{{"code", -32600}, {"message", error}};
  process.write(json(response) + '\n');
}

static int version(const QString &method) {
  if (method == "thread-follower-start-turn" ||
      method == "thread-follower-update-thread-settings")
    return 2;
  if (method == "thread-follower-interrupt-turn")
    return 4;
  return method == "initialize" ? 0 : 1;
}
Desktop::Desktop(QObject *parent) : QObject(parent) {
  connect(&socket, &QLocalSocket::disconnected, this, [this] {
    connected = false;
    responses.clear();
    for (auto it = watched.begin(); it != watched.end(); ++it) {
      it->compatible = false;
      emit threadChanged(it.key());
    }
  });
  connect(&socket, &QLocalSocket::readyRead, this, [this] {
    buffer += socket.readAll();
    while (buffer.size() >= 4) {
      quint32 length = qFromLittleEndian<quint32>(buffer.constData());
      if (!length || length > 64 * 1024 * 1024) {
        socket.abort();
        return;
      }
      if (buffer.size() < length + 4)
        break;
      Object message;
      try {
        message = parse(buffer.mid(4, length)).toObject();
      } catch (...) {
        socket.abort();
        return;
      }
      buffer.remove(0, length + 4);
      const auto type = message["type"].toString();
      if (type == "response") {
        auto id = message["requestId"].toString();
        if (waiting.contains(id))
          responses[id] = message;
        continue;
      }
      if (type == "client-discovery-request") {
        send({{"type", "client-discovery-response"},
              {"requestId", message["requestId"]},
              {"response", Object{{"canHandle", false}}}});
        continue;
      }
      if (type != "broadcast" ||
          message["method"] != "thread-stream-state-changed")
        continue;
      auto params = message["params"].toObject();
      auto id = params["conversationId"].toString();
      if (!watched.contains(id))
        continue;
      auto &watch = watched[id];
      if (message["sourceClientId"] != watch.owner ||
          params["hostId"] != "local")
        continue;
      auto change = params["change"].toObject();
      try {
        if (message["version"] != 11)
          throw Error("unsupported-desktop-ipc-version");
        if (change["type"] == "snapshot") {
          auto raw = change["conversationState"].toObject();
          if (raw["id"] != id || !change["revision"].isDouble() ||
              change["revision"].toInteger() < 0)
            throw Error("invalid-desktop-state");
          watch.raw = raw;
          watch.revision = change["revision"].toInteger();
          watch.compatible = true;
        } else if (change["type"] == "patches") {
          if (!watch.compatible ||
              change["baseRevision"].toInteger(-2) != watch.revision ||
              change["revision"].toInteger(-2) <= watch.revision)
            throw Error("invalid-desktop-revision");
          watch.raw = applyPatch(watch.raw, change["patches"].toArray());
          if (watch.raw["id"] != id)
            throw Error("invalid-desktop-state");
          watch.revision = change["revision"].toInteger();
        } else
          continue;
      } catch (...) {
        watch.compatible = false;
        following(id, false);
        following(id, true);
      }
      emit threadChanged(id);
    }
  });
}
void Desktop::open(const Object &settings) {
  if (connected)
    return;
  socket.abort();
  buffer.clear();
  watched.clear();
  auto endpoint = qEnvironmentVariable("CODEX_REMOTE_DESKTOP_ENDPOINT");
  if (endpoint.isEmpty())
    endpoint = platform() == "win32"
                   ? "codex-ipc"
                   : settings["codexHome"].toString() + "/ipc/ipc.sock";
  socket.connectToServer(endpoint);
  if (!socket.waitForConnected(1000))
    throw Error("desktop-ipc-unavailable");
  auto result = call("initialize", {{"clientType", "codex-remote-agent"}});
  client = result["result"].toObject()["clientId"].toString();
  if (client.isEmpty())
    throw Error("incompatible-desktop-initialize");
  connected = true;
}
void Desktop::stop() {
  for (const auto &id : watched.keys())
    following(id, false);
  watched.clear();
  socket.abort();
  connected = false;
}
void Desktop::send(const Object &value) {
  if (socket.state() != QLocalSocket::ConnectedState)
    throw Error("desktop-disconnected");
  auto bytes = json(value);
  if (socket.bytesToWrite() > 16 * 1024 * 1024)
    throw Error("desktop-backpressure");
  QByteArray frame(4, '\0');
  qToLittleEndian<quint32>(bytes.size(), frame.data());
  socket.write(frame + bytes);
}
Object Desktop::call(const QString &method, Object params, const QString &owner,
                     int timeout) {
  auto id = uuid();
  Object request{{"type", "request"},          {"requestId", id},
                 {"sourceClientId", client},   {"method", method},
                 {"version", version(method)}, {"params", params},
                 {"timeoutMs", timeout}};
  if (!owner.isEmpty())
    request["targetClientId"] = owner;
  waiting.insert(id);
  send(request);
  bool received = waitFor(
      [&] {
        return responses.contains(id) ||
               socket.state() != QLocalSocket::ConnectedState;
      },
      timeout + 100);
  waiting.remove(id);
  if (!received || !responses.contains(id))
    throw Error("desktop-request-timeout",
                method.startsWith("thread-follower-") &&
                    !method.contains("history"));
  auto result = responses.take(id);
  if (result["resultType"] != "success")
    throw Error(result["error"] == "no-client-found"
                    ? "desktop-owner-unavailable"
                    : "desktop-rejected");
  return result;
}
void Desktop::following(const QString &id, bool enabled) {
  if (socket.state() != QLocalSocket::ConnectedState || !watched.contains(id))
    return;
  send({{"type", "broadcast"},
        {"method", "thread-stream-following-changed"},
        {"sourceClientId", client},
        {"targetClientIds", Array{watched[id].owner}},
        {"version", 1},
        {"params", Object{{"conversationId", id},
                          {"hostId", "local"},
                          {"following", enabled}}}});
}
bool Desktop::follow(const QString &id, bool rediscover) {
  if (!connected)
    return false;
  if (rediscover)
    unfollow(id);
  if (watched.contains(id))
    return true;
  try {
    auto owner = call("thread-owner-discovery",
                      {{"hostId", "local"}, {"conversationId", id}}, {},
                      1800)["handledByClientId"]
                     .toString();
    if (owner.isEmpty())
      return false;
    watched.insert(id, Watch{owner});
    following(id, true);
    return true;
  } catch (...) {
    return false;
  }
}
void Desktop::unfollow(const QString &id) {
  following(id, false);
  watched.remove(id);
}
} // namespace Native
