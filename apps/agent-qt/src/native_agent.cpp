#include "native.h"
namespace Native {
QSqlQuery sql(QSqlDatabase &db, const QString &query,
              const QVariantList &values) {
  QSqlQuery q(db);
  if (!q.prepare(query))
    throw Error("journal-query-failed");
  for (const auto &v : values)
    q.addBindValue(v);
  if (!q.exec())
    throw Error("journal-write-failed");
  return q;
}
void Service::openJournal() {
  if (journal.isOpen())
    return;
  dataDirectory = directory + "/agent/" + credentials["deviceId"].toString();
  QDir().mkpath(dataDirectory);
  journal = QSqlDatabase::addDatabase("QSQLITE", "commands-" + uuid());
  journal.setDatabaseName(dataDirectory + "/commands.sqlite");
  if (!journal.open())
    throw Error("journal-open-failed");
  sql(journal, "PRAGMA journal_mode=WAL");
  sql(journal, "PRAGMA synchronous=FULL");
  sql(journal, "CREATE TABLE IF NOT EXISTS commands (key TEXT PRIMARY KEY, "
               "hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT)");
  sql(journal, "CREATE TABLE IF NOT EXISTS native_commands (key TEXT PRIMARY "
               "KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT)");
  sql(journal, "CREATE TABLE IF NOT EXISTS queued_messages (id TEXT PRIMARY "
               "KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL, images TEXT "
               "NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL)");
  auto columns = sql(journal, "PRAGMA table_info(queued_messages)");
  bool attachments = false;
  while (columns.next())
    attachments |= columns.value(1).toString() == "attachments";
  if (!attachments)
    sql(journal, "ALTER TABLE queued_messages ADD COLUMN attachments TEXT NOT "
                 "NULL DEFAULT '[]'");
  sql(journal,
      "UPDATE native_commands SET state='unknown' WHERE state='pending'");
  sql(journal, "UPDATE commands SET state='unknown' WHERE state='pending'");
  sql(journal,
      "UPDATE queued_messages SET status='failed' WHERE status='sending'");
  usage = QSqlDatabase::addDatabase("QSQLITE", "usage-" + uuid());
  usage.setDatabaseName(dataDirectory + "/usage.sqlite");
  if (!usage.open())
    throw Error("usage-journal-open-failed");
  sql(usage, "PRAGMA journal_mode=WAL");
  sql(usage,
      "CREATE TABLE IF NOT EXISTS turn_usage (thread_id TEXT NOT NULL, turn_id "
      "TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(thread_id,turn_id))");
  sql(usage, "UPDATE turn_usage SET value=json_set(value,'$.state','partial') "
             "WHERE json_extract(value,'$.state')='running'");
}
void Service::connectAgent() {
  if (credentials.isEmpty())
    throw Error("请先登录账号。");
  try {
    auto session =
        parse(
            http("GET",
                 "/v1/agent/" + credentials["deviceId"].toString() + "/session",
                 {}, 65536, 10000))
            .toObject();
    if (session["active"] != true)
      throw Error("session-invalid");
    applyThreadLimit(session["threadLimit"]);
    if (session["expiresAt"].isDouble()) {
      credentials["expiresAt"] = session["expiresAt"];
      storeCredentials(credentials);
      view["expiresAt"] = session["expiresAt"];
    }
  } catch (const Error &e) {
    if (e.code == "http-401") {
      pause();
      clearCredentials(false);
    }
    throw;
  }
  openJournal();
  if (snapshot.isEmpty()) {
    Object caps{{"observe", true},
                {"startTurn", true},
                {"interrupt", true},
                {"approvals", true},
                {"userInput", true},
                {"modelUpdate", true},
                {"effortUpdate", true},
                {"collaborationModeUpdate", true},
                {"permissionsUpdate", true},
                {"mcpApprovals", true},
                {"images", true},
                {"subAgents", true},
                {"runtimeRefresh", true}};
    snapshot = {{"protocolVersion", 1},
                {"deviceId", credentials["deviceId"]},
                {"epoch", uuid()},
                {"lastSeq", 0},
                {"generatedAt", double(now())},
                {"hostname", QSysInfo::machineHostName()},
                {"platform", platform()},
                {"agentVersion", CODEXER_AGENT_VERSION},
                {"runtime", Object{{"kind", "official-app-server"},
                                   {"connected", false},
                                   {"experimental", true},
                                   {"capabilities", caps}}},
                {"threads", Object{}}};
  }
  paused = false;
  allowed = true;
  reconnectAttempt = 0;
  lastRetry = 0;
  view["phase"] = "connecting";
  publish();
  if (settings["runtime"] != "headless")
    try {
      desktop->open(settings);
    } catch (...) {
    }
  ensureRpc();
  connectRelay();
  refreshCatalog();
  lastCatalog = now();
  log("agent-started");
  status();
  try {
    checkUpdate();
  } catch (...) {
  }
}
void Service::pause() {
  paused = true;
  ++remoteGeneration;
  commandQueue.clear();
  for (const auto &operation : previewOperations)
    if (operation)
      operation->deleteLater();
  previewOperations.clear();
  if (relay) {
    auto old = relay;
    relay = nullptr;
    old->close(QWebSocketProtocol::CloseCodeNormal, "user-disconnected");
    old->deleteLater();
  }
  view["phase"] = credentials.isEmpty() ? "signed-out" : "disconnected";
  publish();
  status();
}
void Service::closeAgent() {
  if (maintenance)
    maintenance->stop();
  pause();
  if (rpc) {
    auto old = rpc;
    rpc = nullptr;
    delete old;
  }
  if (desktop)
    desktop->stop();
  if (usage.isOpen()) {
    try {
      sql(usage,
          "UPDATE turn_usage SET value=json_set(value,'$.state','partial') "
          "WHERE json_extract(value,'$.state')='running'");
    } catch (...) {
    }
    auto name = usage.connectionName();
    usage.close();
    usage = {};
    QSqlDatabase::removeDatabase(name);
  }
  if (journal.isOpen()) {
    auto name = journal.connectionName();
    journal.close();
    journal = {};
    QSqlDatabase::removeDatabase(name);
  }
  snapshot = {};
  threadLimit = DefaultSyncedThreads;
  catalog = {};
  rawThreads.clear();
  effectiveSettings.clear();
  pendingRequests.clear();
  owned.clear();
  newThreads.clear();
  acquired.clear();
  busyTurns.clear();
  dirtyThreads.clear();
  desktopThreads.clear();
  awaitingQueue.clear();
  commandQueue.clear();
  usageObservations.clear();
  agentDetails.clear();
  agentDetailsAt.clear();
  imageSources.clear();
  completedTurns.clear();
  answeredRequests.clear();
  fileSources.clear();
  deletionPlans.clear();
  if (maintenance && !stopping)
    maintenance->start();
}
bool Service::active() const {
  if (!busyTurns.isEmpty() || refreshing)
    return true;
  auto threads = snapshot["threads"].toObject();
  for (const auto &v : threads) {
    auto t = v.toObject();
    if (t["status"] == "active" || !t["requests"].toArray().isEmpty())
      return true;
    for (const auto &a : t["subAgents"].toArray())
      if (QStringList{"running", "pendingInit"}.contains(
              a.toObject()["status"].toString()))
        return true;
  }
  return false;
}
void Service::status() {
  if (view.isEmpty())
    return;
  lastStatus = now();
  auto threads = snapshot["threads"].toObject();
  int count = 0;
  for (const auto &v : threads)
    if (v.toObject()["status"] == "active")
      ++count;
  count = qMax(count, busyTurns.size());
  bool connected =
      relay && relay->state() == QAbstractSocket::ConnectedState && !paused;
  auto runtime = snapshot["runtime"].toObject();
  Object status{{"relayConnected", connected},
                {"paused", paused},
                {"sessionValid", allowed},
                {"desktopConnected", desktop && desktop->connected},
                {"runtime", runtime["kind"].toString("official-app-server")},
                {"runtimeConnected", runtime["connected"].toBool()},
                {"activeTasks", count},
                {"threads", threads.size()},
                {"threadLimit", threadLimit},
                {"updatedAt", double(now())}};
  view["status"] = status;
  view["phase"] = credentials.isEmpty() ? "signed-out"
                  : paused              ? "disconnected"
                  : connected           ? "connected"
                                        : "reconnecting";
  publish();
  if (!dataDirectory.isEmpty())
    try {
      Array list;
      for (const auto &v : threads) {
        auto t = v.toObject();
        list.append(Object{{"id", t["id"]},
                           {"status", t["status"]},
                           {"activeTurnId", t["activeTurnId"]},
                           {"requests", t["requests"].toArray().size()}});
      }
      save(dataDirectory + "/status.json",
           json(merged(status, {{"deviceId", snapshot["deviceId"]},
                                {"epoch", snapshot["epoch"]},
                                {"lastSeq", snapshot["lastSeq"]},
                                {"threads", list}})));
    } catch (...) {
    }
}
void Service::connectRelay() {
  if (paused || !allowed || relay || credentials.isEmpty())
    return;
  QUrl url(credentials["relayUrl"].toString());
  url.setPath("/v1/ws/device");
  url.setScheme(url.scheme() == "https" ? "wss" : "ws");
  auto socket =
      new QWebSocket(QString{}, QWebSocketProtocol::VersionLatest, this);
  relay = socket;
  socket->setMaxAllowedIncomingMessageSize(8 * 1024 * 1024);
  socket->setMaxAllowedIncomingFrameSize(8 * 1024 * 1024);
  QNetworkRequest request(url);
  request.setRawHeader("Authorization",
                       "Bearer " + credentials["session"].toString().toUtf8());
  request.setRawHeader("x-device-id",
                       credentials["deviceId"].toString().toUtf8());
  connect(socket, &QWebSocket::connected, this, [this, socket] {
    if (relay != socket)
      return;
    lastPong = now();
    send({{"type", "device.snapshot"}, {"snapshot", snapshot}});
    status();
  });
  connect(socket, &QWebSocket::pong, this,
          [this](quint64, const QByteArray &) { lastPong = now(); });
  connect(socket, &QWebSocket::textMessageReceived, this,
          [this, socket](const QString &text) {
            if (relay != socket || paused)
              return;
            try {
              relayMessage(parse(text.toUtf8()).toObject());
            } catch (...) {
              socket->close(QWebSocketProtocol::CloseCodePolicyViolated,
                            "invalid-message");
            }
          });
  connect(socket, &QWebSocket::disconnected, this, [this, socket] {
    if (relay != socket)
      return;
    auto code = int(socket->closeCode());
    ++remoteGeneration;
    commandQueue.clear();
    relay = nullptr;
    socket->deleteLater();
    if (code == 4001 || code == 4003) {
      allowed = false;
      paused = true;
      log("account-session-ended-login-again");
    } else if (QList<int>{1002, 1003, 1007, 1008, 1009}.contains(code)) {
      paused = true;
      view["error"] = "服务器拒绝设备消息，请更新服务器或连接器后重新连接。";
      log("relay-rejected-policy");
    }
    lastRetry = now() + qMin(30000, 1000 * (1 << qMin(reconnectAttempt++, 5)));
    status();
  });
  connect(socket, &QWebSocket::errorOccurred, this,
          [this, socket](QAbstractSocket::SocketError) {
            if (relay != socket)
              return;
            log("relay-unavailable");
            if (socket->state() == QAbstractSocket::UnconnectedState) {
              ++remoteGeneration;
              commandQueue.clear();
              relay = nullptr;
              socket->deleteLater();
              lastRetry =
                  now() +
                  qMin(30000, 1000 * (1 << qMin(reconnectAttempt++, 5)));
            }
          });
  socket->open(request);
}
void Service::send(const Object &message) {
  if (paused || !relay || relay->state() != QAbstractSocket::ConnectedState)
    return;
  auto bytes = json(message);
  if (bytes.size() > 8 * 1024 * 1024 ||
      relay->bytesToWrite() > 16 * 1024 * 1024) {
    relay->close(QWebSocketProtocol::CloseCode(1013), "backpressure");
    return;
  }
  relay->sendTextMessage(QString::fromUtf8(bytes));
}
void Service::commit(const Object &change) {
  if (snapshot.isEmpty())
    return;
  // Every producer, including thread creation, must obey the wire-state bound.
  // Reserve before incrementing the sequence so a refused update is atomic.
  if (change["type"] == "thread.updated")
    ensureThreadSlot(change["thread"].toObject()["id"].toString());
  double seq = snapshot["lastSeq"].toDouble() + 1;
  snapshot["lastSeq"] = seq;
  snapshot["generatedAt"] = double(now());
  auto type = change["type"].toString();
  if (type == "thread.updated") {
    auto threads = snapshot["threads"].toObject();
    auto t = change["thread"].toObject();
    threads[t["id"].toString()] = t;
    snapshot["threads"] = threads;
  }
  if (type == "thread.removed") {
    auto threads = snapshot["threads"].toObject();
    threads.remove(change["threadId"].toString());
    snapshot["threads"] = threads;
  }
  if (type == "runtime.status") {
    auto r = snapshot["runtime"].toObject();
    r["connected"] = change["connected"];
    if (change.contains("kind"))
      r["kind"] = change["kind"];
    snapshot["runtime"] = r;
  }
  send({{"type", "device.event"},
        {"event", Object{{"protocolVersion", 1},
                         {"deviceId", snapshot["deviceId"]},
                         {"epoch", snapshot["epoch"]},
                         {"seq", seq},
                         {"timestamp", snapshot["generatedAt"]},
                         {"change", change}}}});
}
void Service::relayMessage(const Object &message) {
  auto type = message["type"].toString();
  if (type == "device.welcome") {
    applyThreadLimit(message.contains("threadLimit") ? message["threadLimit"] : QJsonValue(DefaultSyncedThreads));
    auto features = message["features"].toArray();
    Array supported;
    if (features.contains("files"))
      supported.append("files");
    if (features.contains("previews"))
      supported.append("previews");
    send({{"type", "device.capabilities"}, {"features", supported}});
    auto runtime = snapshot["runtime"].toObject(),
         caps = runtime["capabilities"].toObject();
    if (features.contains("attachments"))
      caps["attachments"] = true;
    else
      caps.remove("attachments");
    runtime["capabilities"] = caps;
    snapshot["runtime"] = runtime;
    send({{"type", "device.snapshot"}, {"snapshot", snapshot}});
    if (features.contains("catalog") && !catalog.isEmpty())
      send({{"type", "device.catalog"}, {"catalog", catalog}});
    log("relay-connected");
    return;
  }
  if (type == "device.settings") {
    applyThreadLimit(message["threadLimit"]);
    return;
  }
  if (type == "device.resync") {
    send({{"type", "device.snapshot"}, {"snapshot", snapshot}});
    return;
  }
  if (type.startsWith("preview.")) {
    preview(message);
    return;
  }
  if (type == "command") {
    auto command = message["command"].toObject();
    if (!validCommand(command) || command["deviceId"] != snapshot["deviceId"]) {
      relay->close(QWebSocketProtocol::CloseCodePolicyViolated,
                   "invalid-command");
      return;
    }
    commandQueue.append(message);
    return;
  }
  if (QStringList{"history.request", "image.request", "file.request"}.contains(
          type)) {
    if (message["requestId"].toString().isEmpty() ||
        message["threadId"].toString().isEmpty())
      throw Error("invalid-request");
    commandQueue.append(message);
    return;
  }
}
void Service::processCommand(const Object &command) {
  Object result;
  auto key =
      QString::fromUtf8(json(Array{command["deviceId"], command["commandId"]}));
  auto digest = hash(json(command));
  auto lookup =
      sql(journal, "SELECT hash,state,result FROM native_commands WHERE key=?",
          {key});
  if (lookup.next()) {
    if (lookup.value(0).toString() != digest)
      result = {{"status", "failed"}, {"code", "command-id-reused"}};
    else if (!lookup.value(2).isNull())
      result = parse(lookup.value(2).toByteArray()).toObject();
    else
      result = {{"status", "unknown"}, {"code", "agent-outcome-unconfirmed"}};
  }
  if (result.isEmpty()) {
    auto previous =
        sql(journal, "SELECT result FROM commands WHERE key=?", {key});
    if (previous.next())
      result = {{"status", "unknown"}, {"code", "agent-outcome-unconfirmed"}};
  }
  if (result.isEmpty()) {
    if (!journal.transaction())
      throw Error("journal-write-failed");
    try {
      sql(journal,
          "INSERT INTO native_commands(key,hash,state) VALUES(?,?,'pending')",
          {key, digest});
      // Reserve IDs in the old journal too, so rolling back cannot replay a
      // native command.
      sql(journal, "INSERT INTO commands(key,hash,state) VALUES(?,?,'pending')",
          {key, "native:" + digest});
      if (!journal.commit())
        throw Error("journal-write-failed");
    } catch (...) {
      journal.rollback();
      throw;
    }
    try {
      if (command["expectedEpoch"] != snapshot["epoch"])
        throw Error("stale-device-epoch");
      if (now() >= command["expiresAt"].toDouble())
        throw Error("command-expired");
      auto value = execute(command);
      result = {{"status", "succeeded"},
                {"code", value.contains("acknowledgedByDesktop")
                             ? "desktop-acknowledged"
                             : "app-server-acknowledged"},
                {"result", value}};
    } catch (const Error &e) {
      result = {{"status", e.uncertain ? "unknown" : "failed"},
                {"code", e.code.left(100)}};
    } catch (...) {
      result = {{"status", "unknown"}, {"code", "agent-execution-unconfirmed"}};
    }
    result["commandId"] = command["commandId"];
    result["deviceId"] = command["deviceId"];
    sql(journal, "UPDATE native_commands SET state=?,result=? WHERE key=?",
        {result["status"].toString(), json(result), key});
    sql(journal, "UPDATE commands SET state=?,result=? WHERE key=?",
        {result["status"].toString(), json(result), key});
  }
  result["commandId"] = command["commandId"];
  result["deviceId"] = command["deviceId"];
  send({{"type", "command.result"}, {"result", result}});
}
void Service::tick() {
  if (depth || stopping || !initialized)
    return;
  ++depth;
  try {
    if (!commandQueue.isEmpty() && !paused && allowed) {
      auto message = commandQueue.takeFirst();
      auto type = message["type"].toString();
      auto id = message["threadId"].toString();
      bool member = false;
      for (const auto &t : catalog["threads"].toArray())
        if (t.toObject()["id"] == id)
          member = true;
      if (type == "command")
        processCommand(message["command"].toObject());
      else if (type == "history.request") {
        Object response{{"type", "device.history"},
                        {"requestId", message["requestId"]},
                        {"threadId", id},
                        {"page", QJsonValue::Null},
                        {"code", QJsonValue::Null}};
        try {
          if (!member)
            throw Error("thread-not-in-catalog");
          response["page"] = history(id, message["cursor"]);
        } catch (const Error &e) {
          response["code"] = e.code == "thread-not-in-catalog"
                                 ? e.code
                                 : "history-unavailable";
        }
        send(response);
      } else if (type == "image.request") {
        Object response{{"type", "device.image"},
                        {"requestId", message["requestId"]},
                        {"threadId", id},
                        {"imageId", message["imageId"]},
                        {"image", QJsonValue::Null}};
        if (member)
          try {
            response["image"] = readImage(id, message["imageId"].toString());
          } catch (...) {
          }
        send(response);
      } else if (type == "file.request") {
        Object response{
            {"type", "device.file"},    {"requestId", message["requestId"]},
            {"threadId", id},           {"path", message["path"]},
            {"file", QJsonValue::Null}, {"code", QJsonValue::Null}};
        try {
          if (!member)
            throw Error("file-not-in-thread");
          response["file"] = readFile(message);
        } catch (const Error &e) {
          response["code"] = QStringList{"file-not-in-thread", "file-too-large",
                                         "file-changed", "invalid-file-offset"}
                                     .contains(e.code)
                                 ? e.code
                                 : "file-unavailable";
        }
        send(response);
      }
    }
    if (!snapshot.isEmpty()) {
      trimThreadPreviews(threadLimit);
      if (!paused && allowed && !relay && now() >= lastRetry)
        connectRelay();
      if (relay && relay->state() == QAbstractSocket::ConnectedState &&
          now() - lastPing > 15000) {
        lastPing = now();
        if (now() - lastPong > 45000)
          relay->abort();
        else
          relay->ping();
      }
      if (now() - lastScan >= 15000) {
        lastScan = now();
        if (settings["runtime"] != "headless" && !desktop->connected)
          try {
            desktop->open(settings);
          } catch (...) {
          }
        if (rpc && !active())
          try {
            refresh(false);
          } catch (...) {
          }
        for (const auto &t : snapshot["threads"].toObject())
          dirtyThreads.insert(t.toObject()["id"].toString());
      }
      if (now() - lastCatalog >= 60000) {
        lastCatalog = now();
        try {
          refreshCatalog();
        } catch (...) {
          log("catalog-refresh-failed");
        }
      }
      if (!dirtyThreads.isEmpty()) {
        auto id = *dirtyThreads.begin();
        dirtyThreads.remove(id);
        try {
          watch(id);
        } catch (...) {
        }
      }
      if (now() - lastRelease >= 5000) {
        lastRelease = now();
        try {
          if (refreshRequested)
            refresh(true);
          else
            release(false);
        } catch (...) {
        }
      }
      if (!paused && allowed)
        drainQueues();
      if (now() - lastStatus >= 2000)
        status();
    }
  } catch (const Error &e) {
    log(e.code);
  } catch (...) {
    log("native-background-operation-failed");
  }
  --depth;
  if (!uiQueue.isEmpty())
    submit(uiQueue.takeFirst());
}
void Service::observeUsage(const QString &threadId, const QString &turnId,
                           const Object &value, bool notification) {
  if (!usage.isOpen() || turnId.isEmpty())
    return;
  auto total = value["total"].toObject(), last = value["last"].toObject();
  if (total.isEmpty())
    return;
  auto prior = usageObservations[threadId],
       baseline = prior["baseline"].toObject();
  bool coverage = prior["coverage"].toBool();
  if (prior["turnId"] != turnId) {
    usageObservations[threadId] = {
        {"turnId", turnId}, {"baseline", total}, {"coverage", false}};
    return;
  }
  Object delta;
  for (const auto &key :
       {"totalTokens", "inputTokens", "cachedInputTokens", "outputTokens",
        "cacheWriteInputTokens", "reasoningOutputTokens"}) {
    double n = total[key].toDouble(), b = baseline[key].toDouble();
    if (n < 0 || n < b) {
      usageObservations[threadId] = {
          {"turnId", turnId}, {"baseline", total}, {"coverage", false}};
      return;
    }
    delta[key] = baseline.isEmpty() ? last[key].toDouble() : n - b;
  }
  if (baseline.isEmpty() && (!notification || last.isEmpty() || !coverage)) {
    prior["baseline"] = total;
    prior["coverage"] = false;
    usageObservations[threadId] = prior;
    return;
  }
  auto row =
      sql(usage, "SELECT value FROM turn_usage WHERE thread_id=? AND turn_id=?",
          {threadId, turnId});
  Object saved;
  if (row.next())
    saved = parse(row.value(0).toByteArray()).toObject();
  for (auto it = delta.begin(); it != delta.end(); ++it)
    saved[it.key()] = saved[it.key()].toDouble() + it.value().toDouble();
  if (saved["cachedInputTokens"].toDouble() > saved["inputTokens"].toDouble() ||
      saved["reasoningOutputTokens"].toDouble() >
          saved["outputTokens"].toDouble())
    return;
  saved["state"] = coverage ? "running" : "partial";
  auto model = normalizeSettings(rawThreads[threadId])["model"];
  if (model.isString())
    saved["model"] = model;
  sql(usage,
      "INSERT INTO turn_usage(thread_id,turn_id,value) VALUES(?,?,?) ON "
      "CONFLICT(thread_id,turn_id) DO UPDATE SET value=excluded.value",
      {threadId, turnId, json(saved)});
  prior["baseline"] = total;
  usageObservations[threadId] = prior;
}
void Service::enrichUsage(const QString &threadId, Object &turn) {
  if (!usage.isOpen())
    return;
  auto row =
      sql(usage, "SELECT value FROM turn_usage WHERE thread_id=? AND turn_id=?",
          {threadId, turn["id"].toString()});
  if (row.next())
    turn["tokenUsage"] = parse(row.value(0).toByteArray());
}
} // namespace Native
