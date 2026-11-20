#include "native.h"
#include <limits>
#include <zstd.h>
namespace Native {
void Service::forgetTurnUpdate(const QString &turnId) {
  const auto entry = plans.take(turnId);
  if (!entry.isEmpty())
    planBytes -= json(entry).size();
  planThreads.remove(turnId);
  planOrder.removeAll(turnId);
}
void Service::clearTurnUpdates() {
  plans.clear();
  planThreads.clear();
  planOrder.clear();
  planBytes = 0;
}
void Service::cacheTurnUpdate(const QString &threadId, const QString &turnId,
                              const QString &field, const QJsonValue &value) {
  if (turnId.isEmpty() || turnId.size() > 160 || threadId.size() > 160 ||
      (!rawThreads.contains(threadId) && !owned.contains(threadId) &&
       !newThreads.contains(threadId)))
    return;
  // Retain only what the live view can display, including for completed turns.
  // History is read separately from Codex; it is not an unbounded runtime cache.
  const auto bounded = normalizeTurn({{"id", turnId}, {field, value}}, false,
                                     threadId);
  auto entry = plans.value(turnId);
  forgetTurnUpdate(turnId);
  entry[field] = bounded[field];
  plans.insert(turnId, entry);
  planThreads.insert(turnId, threadId);
  planOrder.append(turnId);
  planBytes += json(entry).size();
  QStringList threadTurns;
  for (const auto &key : planOrder)
    if (planThreads.value(key) == threadId)
      threadTurns.append(key);
  while (threadTurns.size() > MaxCachedUpdatesPerThread)
    forgetTurnUpdate(threadTurns.takeFirst());
  while (planOrder.size() > MaxCachedTurnUpdates ||
         planBytes > MaxCachedTurnUpdateBytes)
    forgetTurnUpdate(planOrder.first());
}
void Service::forgetThreadCache(const QString &id) {
  rawThreads.remove(id);
  effectiveSettings.remove(id);
  tokenUsage.remove(id);
  dirtyThreads.removeAll(id);
  liveUpdates.remove(id);
  headlessTurns.remove(id);
  backgroundThreads.remove(id);
  idleReads.remove(id);
  gapUsage(id);
  desktop->unfollow(id);
  desktopThreads.remove(id);
  fileSources.remove(id);
  previewOrigins.remove(id);
  for (const auto &key : imageSources.keys())
    if (imageSources.value(key).first == id)
      imageSources.remove(key);
  for (const auto &turn : planThreads.keys())
    if (planThreads.value(turn) == id)
      forgetTurnUpdate(turn);
  const auto prefix = id + ':';
  for (const auto &key : agentDetails.keys())
    if (key.startsWith(prefix)) {
      agentDetails.remove(key);
      agentDetailsAt.remove(key);
    }
}
void Service::attachRpc(Rpc *value) {
  connect(value, &Rpc::serverRequest, this, [this, value](Object request) {
    auto method = request["method"].toString();
    auto p = request["params"].toObject();
    if (!QStringList{"item/commandExecution/requestApproval",
                     "item/fileChange/requestApproval",
                     "item/tool/requestUserInput"}
             .contains(method) &&
        (method != "mcpServer/elicitation/request" || approval(p).isEmpty())) {
      value->respond(request["id"], {},
                     "interactive-request-not-supported-by-headless-agent");
      return;
    }
    pendingRequests[request["id"].toVariant().toString()] = request;
    idleReads.remove(p["threadId"].toString());
    queueThreadUpdate(p["threadId"].toString());
  });
  connect(value, &Rpc::notification, this, [this](QString method, Object p) {
    auto id = p["threadId"].toString(), turnId = p["turnId"].toString();
    if (method == "thread/project/updated")
      lastCatalog = 0;
    if (id.isEmpty())
      return;
    idleReads.remove(id);
    if (method == "turn/started") {
      auto tid = p["turn"].toObject()["id"].toString();
      busyTurns.insert(tid);
      startUsage(id, tid, normalizeSettings(rawThreads.value(id))["model"].toString());
    }
    if (method == "turn/completed")
      finishHeadlessTurn(id, p["turn"].toObject()["id"].toString());
    if (method == "error" && p["willRetry"] == false && owned.contains(id))
      finishHeadlessTurn(id, turnId);
    if (method == "serverRequest/resolved")
      pendingRequests.remove(p["requestId"].toVariant().toString());
    if (method == "thread/settings/updated")
      effectiveSettings[id] =
          merged(effectiveSettings[id], p["threadSettings"].toObject());
    if (method == "turn/plan/updated")
      cacheTurnUpdate(id, turnId, "plan", p["plan"]);
    if (method == "turn/diff/updated")
      cacheTurnUpdate(id, turnId, "diff", p["diff"]);
    if (method == "thread/tokenUsage/updated") {
      tokenUsage[id] = p["tokenUsage"].toObject();
      try {
        observeUsage(id, turnId, p["tokenUsage"].toObject(), true);
      } catch (...) {
      }
    }
    // A token already merged into the live preview needs no historical read.
    if (!acceptHeadlessUpdate(id, method, p) || method != "item/agentMessage/delta")
      queueThreadUpdate(id);
  });
  connect(value, &Rpc::disconnected, this, [this, value] {
    if (rpc != value || refreshing)
      return;
    for (const auto &id : usageObservations.keys())
      if (!desktopThreads.contains(id))
        gapUsage(id);
    for (const auto &id : headlessTurns.keys())
      queueThreadUpdate(id);
    headlessTurns.clear();
    owned.clear();
    acquired.clear();
    busyTurns.clear();
    completedTurns.clear();
    pendingRequests.clear();
    clearTurnUpdates();
    tokenUsage.clear();
    idleReads.clear();
    commit({{"type", "runtime.status"},
            {"connected", desktop && desktop->connected},
            {"kind", desktop && desktop->connected ? "official-desktop-ipc"
                                                   : "official-app-server"}});
  });
}
void Service::ensureRpc() {
  if (rpc && rpc->connected())
    return;
  if (rpc) {
    delete rpc;
    rpc = nullptr;
  }
  auto replacement = new Rpc(this);
  try {
    replacement->start(settings);
  } catch (...) {
    delete replacement;
    throw;
  }
  rpc = replacement;
  headlessTurns.clear();
  idleReads.clear();
  answeredRequests.clear();
  attachRpc(rpc);
  commit({{"type", "runtime.status"},
          {"connected", true},
          {"kind",
           desktop && desktop->connected && settings["runtime"] != "headless"
               ? "official-desktop-ipc"
               : "official-app-server"}});
}
Array Service::pages(const QString &method, Object params) {
  ensureRpc();
  Array values;
  QJsonValue cursor(QJsonValue::Null);
  QSet<QString> cursors;
  for (int n = 0; n < 200; ++n) {
    params["cursor"] = cursor;
    params["limit"] = 100;
    auto page = rpc->call(method, params);
    if (!page["data"].isArray() || page["data"].toArray().size() > 100 ||
        (!page["nextCursor"].isNull() && !page["nextCursor"].isString()))
      throw Error("catalog-response-invalid");
    for (const auto &v : page["data"].toArray())
      values.append(v);
    if (values.size() > 10000)
      throw Error("catalog-too-large");
    cursor = page["nextCursor"];
    if (cursor.isNull() || cursor.toString().isEmpty())
      return values;
    if (cursors.contains(cursor.toString()))
      throw Error("catalog-page-limit");
    cursors.insert(cursor.toString());
  }
  throw Error("catalog-page-limit");
}
void Service::refreshCatalog() {
  auto projects = pages("project/list"),
       threads = pages("thread/list", {{"modelProviders", Array{}},
                                       {"sortKey", "updated_at"},
                                       {"sortDirection", "desc"},
                                       {"archived", false}});
  auto archived = pages("thread/list", {{"modelProviders", Array{}},
                                        {"sortKey", "updated_at"},
                                        {"sortDirection", "desc"},
                                        {"archived", true}});
  for (const auto &v : archived) {
    auto t = v.toObject();
    t["archived"] = true;
    threads.append(t);
  }
  Array models;
  try {
    for (const auto &v : pages("model/list", {{"includeHidden", false}})) {
      const auto m = v.toObject();
      Array efforts;
      for (const auto &e : m["supportedReasoningEfforts"].toArray())
        efforts.append(e.isString() ? e : e.toObject()["reasoningEffort"]);
      if (m["model"].toString().isEmpty())
        continue;
      models.append(Object{
          {"model", m["model"]},
          {"displayName", m["displayName"].toString(m["model"].toString())},
          {"supportedReasoningEfforts", efforts},
          {"defaultReasoningEffort",
           m["defaultReasoningEffort"].toString("medium")}});
    }
  } catch (...) {
  }
  auto next = normalizeCatalog(credentials["deviceId"].toString(), projects,
                               threads, models, settings["codexHome"].toString());
  auto listed = next["threads"].toArray();
  QSet<QString> ids;
  for (const auto &v : listed)
    ids.insert(v.toObject()["id"].toString());
  for (const auto &v : catalog["threads"].toArray())
    if (newThreads.contains(v.toObject()["id"].toString()) &&
        !ids.contains(v.toObject()["id"].toString()))
      listed.prepend(v);
  next["threads"] = listed;
  Array parents;
  for (const auto &v : settings["projectParents"].toArray()) {
    QFileInfo f(v.toString());
    if (f.isDir() && !f.isSymLink() &&
        canonical(f.filePath()) == canonical(f.canonicalFilePath()))
      parents.append(
          Object{{"id", hash(f.filePath().toUtf8())}, {"path", f.filePath()}});
  }
  next["projectCreation"] = Object{{"parents", parents}};
  next["projectDeletion"] = true;
  next["projectTransfer"] = true;
  if (json(next).size() > 6 * 1024 * 1024 || projects.size() > 1000 ||
      listed.size() > 10000)
    throw Error("catalog-too-large");
  catalog = next;
  try {
    refreshProjectUsage(false);
  } catch (...) {
    log("project-usage-unavailable");
  }
  send({{"type", "device.catalog"}, {"catalog", catalog}});
  int count = 0;
  for (const auto &v : listed) {
    auto t = v.toObject();
    if (t["archived"].toBool())
      continue;
    auto id = t["id"].toString();
    if (count++ < threadLimit)
      backgroundThreads.insert(id);
  }
}
static QByteArray rollout(const QString &path,
                          const std::function<void(const QByteArray &)> &line) {
  QFile input(path);
  if (!input.open(QIODevice::ReadOnly))
    throw Error("headless-settings-file-missing");
  QFileInfo before(input);
  QByteArray pending;
  ZSTD_DStream *decoder = nullptr;
  size_t remaining = 0;
  if (path.endsWith(".zst")) {
    decoder = ZSTD_createDStream();
    if (!decoder)
      throw Error("headless-settings-corrupt");
    ZSTD_initDStream(decoder);
  }
  auto consume = [&](const QByteArray &bytes) {
    pending += bytes;
    if (pending.size() > 16 * 1024 * 1024)
      throw Error("headless-settings-corrupt");
    for (int n; (n = pending.indexOf('\n')) >= 0;) {
      auto value = pending.left(n);
      pending.remove(0, n + 1);
      if (!value.trimmed().isEmpty())
        line(value);
    }
  };
  try {
    while (!input.atEnd()) {
      auto bytes = input.read(65536);
      if (!decoder)
        consume(bytes);
      else {
        ZSTD_inBuffer source{bytes.constData(), size_t(bytes.size()), 0};
        while (source.pos < source.size) {
          QByteArray out(65536, '\0');
          ZSTD_outBuffer dest{out.data(), size_t(out.size()), 0};
          remaining = ZSTD_decompressStream(decoder, &dest, &source);
          if (ZSTD_isError(remaining))
            throw Error("headless-settings-corrupt");
          out.resize(dest.pos);
          consume(out);
        }
      }
    }
    if (decoder && remaining)
      throw Error("headless-settings-corrupt");
    if (!pending.trimmed().isEmpty())
      line(pending);
    QFileInfo after(input);
    if (before.size() != after.size() ||
        before.lastModified() != after.lastModified())
      throw Error("headless-settings-busy");
  } catch (...) {
    if (decoder)
      ZSTD_freeDStream(decoder);
    throw;
  }
  if (decoder)
    ZSTD_freeDStream(decoder);
  return {};
}
Object Service::savedContext(const Object &thread) {
  auto source = thread["path"].toString(), id = thread["id"].toString();
  if (source.isEmpty() || id.isEmpty() || !QFileInfo(source).isAbsolute() ||
      !(source.endsWith(".jsonl") || source.endsWith(".jsonl.zst")))
    throw Error("headless-session-path-invalid");
  auto materialized = source;
  if (materialized.endsWith(".zst"))
    materialized.chop(4);
  auto path =
      QFileInfo::exists(materialized) ? materialized : materialized + ".zst";
  QFileInfo info(path);
  auto root = QFileInfo(settings["codexHome"].toString() + "/sessions")
                  .canonicalFilePath();
  if (root.isEmpty() || info.canonicalFilePath().isEmpty() ||
      !within(root, info.canonicalFilePath()) ||
      canonical(root) == canonical(info.canonicalFilePath()))
    throw Error("headless-session-path-invalid");
  Object context, metadata;
  bool verified = false;
  rollout(path, [&](const QByteArray &line) {
    Object event;
    try {
      event = parse(line).toObject();
    } catch (...) {
      throw Error("headless-settings-corrupt");
    }
    auto p = event["payload"].toObject();
    if (!verified && (event["type"] != "session_meta" || p["id"] != id))
      throw Error("headless-session-path-invalid");
    verified = true;
    if (event["type"] == "session_meta") {
      if (p["id"] != id)
        throw Error("headless-session-path-invalid");
      metadata = p;
    }
    if (event["type"] == "turn_context")
      context = p;
  });
  if (context.isEmpty())
    throw Error("headless-settings-unavailable");
  if (!context.contains("workspace_roots"))
    context["workspace_roots"] = metadata["runtime_workspace_roots"];
  auto sandbox = context["sandbox_policy"].toObject();
  if (!QStringList{"read-only", "workspace-write", "danger-full-access"}
           .contains(sandbox["type"].toString()))
    throw Error("headless-sandbox-unsupported");
  if (!context["cwd"].isString() || !context["model"].isString() ||
      !thread["modelProvider"].isString() ||
      !context["workspace_roots"].isArray() ||
      !context.contains("approval_policy") ||
      !context.contains("approvals_reviewer"))
    throw Error("headless-settings-incomplete");
  for (const auto &r : context["workspace_roots"].toArray())
    if (!r.isString() || !QFileInfo(r.toString()).isAbsolute())
      throw Error("headless-settings-incomplete");
  Object result{{"approvalPolicy", context["approval_policy"]},
                {"approvalsReviewer", context["approvals_reviewer"]},
                {"sandbox", sandbox["type"]},
                {"sandboxPolicy", sandbox},
                {"cwd", context["cwd"]},
                {"runtimeWorkspaceRoots", context["workspace_roots"]},
                {"model", thread["model"].isString() ? thread["model"]
                                                     : context["model"]},
                {"modelProvider", thread["modelProvider"]}};
  if (thread["reasoningEffort"].isString() || context["effort"].isString())
    result["effort"] = thread["reasoningEffort"].isString()
                           ? thread["reasoningEffort"]
                           : context["effort"];
  if (context["summary"].isString())
    result["summary"] = context["summary"];
  if (context["service_tier"].isString())
    result["serviceTier"] = context["service_tier"];
  if (context["collaboration_mode"].isObject()) {
    auto mode = context["collaboration_mode"].toObject(),
         s = mode["settings"].toObject();
    s["model"] = result["model"];
    if (result.contains("effort"))
      s["reasoning_effort"] = result["effort"];
    mode["settings"] = s;
    result["collaborationMode"] = mode;
  }
  return result;
}
static Object nativeSaved(Object saved) {
  auto sandbox = saved["sandboxPolicy"].toObject();
  QString type = saved["sandbox"].toString();
  Object policy{{"type", type == "danger-full-access" ? "dangerFullAccess"
                         : type == "read-only"        ? "readOnly"
                                                      : "workspaceWrite"}};
  if (type != "danger-full-access")
    policy["networkAccess"] = sandbox["network_access"].toBool();
  if (type == "workspace-write") {
    policy["writableRoots"] = sandbox["writable_roots"].toArray();
    policy["excludeSlashTmp"] = sandbox["exclude_slash_tmp"].toBool();
    policy["excludeTmpdirEnvVar"] = sandbox["exclude_tmpdir_env_var"].toBool();
  }
  saved["sandboxPolicy"] = policy;
  return saved;
}
Object Service::resume(const QString &id) {
  if (newThreads.contains(id))
    return effectiveSettings[id];
  auto source = rpc->call("thread/read",
                          {{"threadId", id}, {"includeTurns", false}})["thread"]
                    .toObject();
  auto saved = savedContext(source), latest = effectiveSettings[id];
  for (const auto &key : {"model", "effort", "collaborationMode"})
    if (latest.contains(key))
      saved[key] = latest[key];
  if (latest.contains("sandboxPolicy")) {
    auto p = latest["sandboxPolicy"].toObject();
    auto type = p["type"].toString();
    if (QStringList{"dangerFullAccess", "readOnly", "workspaceWrite"}.contains(
            type)) {
      saved["sandbox"] = type == "dangerFullAccess" ? "danger-full-access"
                         : type == "readOnly"       ? "read-only"
                                                    : "workspace-write";
      saved["approvalPolicy"] = latest["approvalPolicy"];
      saved["approvalsReviewer"] = latest["approvalsReviewer"];
      saved["sandboxPolicy"] =
          Object{{"type", saved["sandbox"]},
                 {"writable_roots", p["writableRoots"].toArray()},
                 {"network_access", p["networkAccess"].toBool()},
                 {"exclude_slash_tmp", p["excludeSlashTmp"].toBool()},
                 {"exclude_tmpdir_env_var", p["excludeTmpdirEnvVar"].toBool()}};
      if (latest["runtimeWorkspaceRoots"].isArray())
        saved["runtimeWorkspaceRoots"] = latest["runtimeWorkspaceRoots"];
    }
  }
  Object request{{"threadId", id},
                 {"excludeTurns", true},
                 {"approvalPolicy", saved["approvalPolicy"]},
                 {"approvalsReviewer", saved["approvalsReviewer"]},
                 {"sandbox", saved["sandbox"]},
                 {"cwd", saved["cwd"]},
                 {"runtimeWorkspaceRoots", saved["runtimeWorkspaceRoots"]},
                 {"model", saved["model"]},
                 {"modelProvider", saved["modelProvider"]}};
  if (saved.contains("serviceTier"))
    request["serviceTier"] = saved["serviceTier"];
  auto response = rpc->call("thread/resume", request);
  owned.insert(id);
  acquired[id] = now();
  auto expected = nativeSaved(saved);
  auto policy = response["sandbox"].toObject();
  if (policy["type"] != expected["sandboxPolicy"].toObject()["type"] ||
      response["approvalPolicy"] != saved["approvalPolicy"] ||
      response["approvalsReviewer"] != saved["approvalsReviewer"] ||
      response["model"] != saved["model"] ||
      response["modelProvider"] != saved["modelProvider"] ||
      canonical(response["cwd"].toString()) !=
          canonical(saved["cwd"].toString()))
    throw Error("headless-settings-mismatch");
  auto roots = saved["runtimeWorkspaceRoots"].toArray(),
       actual = response["runtimeWorkspaceRoots"].toArray();
  if (roots.size() != actual.size())
    throw Error("headless-settings-mismatch");
  for (const auto &root : roots) {
    bool found = false;
    for (const auto &a : actual)
      found |= canonical(a.toString()) == canonical(root.toString());
    if (!found)
      throw Error("headless-settings-mismatch");
  }
  if (saved["sandbox"] == "workspace-write") {
    for (const auto &root :
         saved["sandboxPolicy"].toObject()["writable_roots"].toArray()) {
      bool found = false;
      for (const auto &actual : policy["writableRoots"].toArray())
        found |= actual.isString() &&
                 canonical(actual.toString()) == canonical(root.toString());
      if (!found)
        throw Error("headless-settings-mismatch");
    }
  }
  effectiveSettings[id] = merged(expected, latest);
  return saved;
}
void Service::ensureThreadSlot(const QString &id) {
  if (!id.isEmpty() && snapshot["threads"].toObject().contains(id))
    return;
  if (!trimThreadPreviews(threadLimit - 1))
    throw Error("thread-limit");
}
void Service::applyThreadLimit(const QJsonValue &value) {
  if (value.isUndefined())
    return;
  const auto next = value.toInt(-1);
  if (!value.isDouble() || value.toDouble() != next || next < 1 || next > MaxSyncedThreads)
    throw Error("invalid-agent-settings");
  threadLimit = next;
  if (snapshot.isEmpty())
    return;
  trimThreadPreviews(threadLimit);
  status();
}
bool Service::trimThreadPreviews(int target) {
  if (snapshot["threads"].toObject().size() <= target)
    return true;
  auto protectedIds = owned | newThreads | awaitingQueue;
  for (const auto &request : pendingRequests)
    protectedIds.insert(request["params"].toObject()["threadId"].toString());
  if (journal.isOpen()) {
    auto rows = sql(journal, "SELECT DISTINCT thread_id FROM queued_messages");
    while (rows.next())
      protectedIds.insert(rows.value(0).toString());
  }
  while (snapshot["threads"].toObject().size() > target) {
    auto threads = snapshot["threads"].toObject();
    QString removable;
    qint64 oldest = std::numeric_limits<qint64>::max();
    for (auto it = threads.begin(); it != threads.end(); ++it) {
      auto t = it.value().toObject();
      if (!QStringList{"idle", "unavailable"}.contains(t["status"].toString()) ||
          t["activeTurnId"].isString() || !t["requests"].toArray().isEmpty() ||
          !t["queuedMessages"].toArray().isEmpty() || protectedIds.contains(it.key()))
        continue;
      bool protectedThread = false;
      for (const auto &a : t["subAgents"].toArray())
        protectedThread |= QStringList{"running", "pendingInit"}.contains(
            a.toObject()["status"].toString());
      if (protectedThread)
        continue;
      const auto updated = t["updatedAt"].toInteger();
      if (removable.isEmpty() || updated < oldest) {
        removable = it.key();
        oldest = updated;
      }
    }
    if (removable.isEmpty())
      return false;
    commit({{"type", "thread.removed"}, {"threadId", removable}});
    forgetThreadCache(removable);
  }
  return true;
}
// A timestamp alone can miss multiple updates in the same second. Include the
// rollout's identity/size/mtime, and still re-read bodies at least once a minute.
// Missing or unsafe files disable this shortcut instead of trusting stale data.
static QString idleReadStamp(const Object &source) {
  const auto type = source["status"].toObject()["type"].toString();
  if (type != "idle" && type != "notLoaded")
    return {};
  const QFileInfo file(source["path"].toString());
  if (!file.isFile() || file.isSymLink() || !file.lastModified().isValid())
    return {};
  try {
    return hash(json(Array{source, fileIdentity(file.absoluteFilePath()),
                           double(file.size()),
                           double(file.lastModified().toMSecsSinceEpoch())}));
  } catch (...) {
    return {};
  }
}

static int indexOfId(const Array &values, const QString &id) {
  for (int i = 0; i < values.size(); ++i)
    if (values[i].toObject()["id"] == id)
      return i;
  return -1;
}

static constexpr int LiveTextLimit = 4096;

static bool terminalTurn(const QJsonValue &status) {
  return status == "completed" || status == "interrupted" || status == "failed";
}

static void saveLiveItem(Array &items, const Object &source, bool completed) {
  Object item;
  for (const auto key : {"id", "type", "clientId", "content", "phase", "text",
                         "startedAtMs", "completedAtMs", "questions"})
    if (source.contains(key))
      item[key] = source[key];
  const auto id = item["id"].toString();
  if (id.isEmpty() || id.size() > 160 ||
      (item["type"] != "userMessage" && item["type"] != "agentMessage"))
    return;
  if (item["type"] == "agentMessage")
    item["text"] = item["text"].toString().left(LiveTextLimit);
  if (json(item).size() > 128 * 1024)
    return;
  const auto index = indexOfId(items, id);
  const auto existing = index < 0 ? Object{} : items[index].toObject();
  if (!completed && existing["_completed"].toBool())
    return;
  if (!completed && item["type"] == "agentMessage" &&
      existing["text"].toString().startsWith(item["text"].toString()))
    item["text"] = existing["text"].toString();
  item["_completed"] = completed;
  if (index >= 0) {
    items[index] = merged(existing, item);
  } else {
    // Preserve the initial prompt and the most recent messages in a long turn.
    if (items.size() == MaxLiveTurnItems)
      items.removeAt(1);
    items.append(item);
  }
}

void Service::finishHeadlessTurn(const QString &id, const QString &turnId) {
  if (turnId.isEmpty())
    return;
  const auto active = snapshot["threads"].toObject()[id].toObject()["activeTurnId"].toString();
  const auto live = headlessTurns.value(id);
  const auto latest = live.isEmpty() ? Object{} : live.last().toObject();
  if ((active.isEmpty() || active == turnId) &&
      (latest["status"] != "inProgress" || latest["id"] == turnId))
    awaitingQueue.remove(id);
  busyTurns.remove(turnId);
  if (pendingStarts > 0)
    completedTurns.insert(turnId);
  for (const auto &key : pendingRequests.keys()) {
    const auto params = pendingRequests[key]["params"].toObject();
    if (params["threadId"] == id && params["turnId"] == turnId && params["isBlocking"] != false)
      pendingRequests.remove(key);
  }
  try {
    finishUsage(id, turnId);
  } catch (...) {
    log("token-usage-observation-failed");
  }
}

bool Service::acceptHeadlessUpdate(const QString &id, const QString &method,
                                   const Object &params) {
  if (!owned.contains(id) || desktopThreads.contains(id))
    return false;
  const bool starts = method == "turn/started", ends = method == "turn/completed";
  const bool delta = method == "item/agentMessage/delta";
  const bool completesItem = method == "item/completed";
  const bool reportsError = method == "error" && params["willRetry"].isBool() && params["error"].isObject();
  if (!starts && !ends && !delta && !completesItem && !reportsError && method != "item/started")
    return false;
  const auto prior = snapshot["threads"].toObject()[id].toObject();
  const auto update = params["turn"].toObject();
  const auto turnId = (starts || ends ? update["id"] : params["turnId"]).toString();
  if (turnId.isEmpty() || turnId.size() > 160 ||
      (ends && !terminalTurn(update["status"])))
    return false;
  auto errors = ends ? turnErrors(update) : Array{};
  if (reportsError)
    appendTurnError(errors, params["error"].toObject(), params["willRetry"].toBool());
  if (!errors.isEmpty()) {
    errors = recordTurnErrors(id, turnId, errors);
    queueLiveUpdate(id);
  }
  if (prior.isEmpty())
    return false;
  auto turns = headlessTurns.value(id);
  const int index = indexOfId(turns, turnId);
  const auto priorTurns = prior["turns"].toArray();
  const int priorIndex = indexOfId(priorTurns, turnId);
  // A late start or delta cannot reopen an already completed turn.
  if (!ends &&
      ((index >= 0 && terminalTurn(turns[index].toObject()["status"])) ||
       (priorIndex >= 0 && terminalTurn(priorTurns[priorIndex].toObject()["status"]))))
    return true;
  if (index < 0 && !starts && !ends && prior["activeTurnId"] != turnId)
    return false;
  auto turn = index >= 0 ? turns[index].toObject()
                         : Object{{"id", turnId}, {"status", "inProgress"}};
  auto items = turn["items"].toArray();
  if (!errors.isEmpty())
    turn["_turnErrors"] = mergeTurnErrors(turn["_turnErrors"].toArray(), errors);
  if (reportsError) {
    if (hasFinalTurnError(errors))
      turn["status"] = "failed";
  } else if (delta) {
    const auto itemId = params["itemId"].toString();
    const int itemIndex = indexOfId(items, itemId);
    const auto item = itemIndex < 0
        ? Object{{"id", itemId}, {"type", "agentMessage"}}
        : items[itemIndex].toObject();
    if (item["_completed"].toBool())
      return true;
    const auto body = item["text"].toString();
    const auto part =
        params["delta"].toString().left(qMax(0, LiveTextLimit - int(body.size())));
    if (part.isEmpty())
      return true;
    if (itemIndex >= 0) {
      items[itemIndex] = merged(item, {{"text", body + part}});
    } else {
      saveLiveItem(items, merged(item, {{"text", body + part}}), false);
    }
  } else if (starts || ends) {
    turn["status"] = ends ? update["status"] : QJsonValue("inProgress");
    turn["_changedAt"] = double(now());
    for (const auto key : {"startedAt", "completedAt", "durationMs"})
      if (update[key].isDouble())
        turn[key] = update[key];
    // Completion can carry only a summary of the turn's items.
    for (const auto &item : update["items"].toArray())
      saveLiveItem(items, item.toObject(), ends);
  } else {
    const auto item = params["item"].toObject();
    if (item["type"] != "userMessage" && item["type"] != "agentMessage")
      return false;
    auto timed = item;
    const auto key = completesItem ? "completedAtMs" : "startedAtMs";
    if (params[key].isDouble())
      timed[key] = params[key];
    saveLiveItem(items, timed, completesItem);
  }
  // Reserve space for stream deltas and bound large prompts and attachments.
  if (!delta)
    while (items.size() > 1 && json(items).size() > 192 * 1024)
      items.removeAt(items.size() > 2 ? 1 : 0);
  turn["items"] = items;
  if (index >= 0) {
    turns[index] = turn;
  } else {
    turns.append(turn);
    if (turns.size() > 2)
      turns.removeFirst();
  }
  headlessTurns[id] = turns;
  queueLiveUpdate(id);
  return true;
}

void Service::reconcileHeadlessTurns(const QString &id, const Array &turns) {
  auto live = headlessTurns.value(id);
  for (int i = live.size() - 1; i >= 0; --i) {
    const auto observed = live[i].toObject();
    const auto index = indexOfId(turns, observed["id"].toString());
    if (index < 0 || !terminalTurn(observed["status"]))
      continue;
    const auto saved = turns[index].toObject();
    if (saved["status"] != observed["status"])
      continue;
    const auto items = saved["items"].toArray();
    bool allSaved = true;
    for (const auto &item : observed["items"].toArray())
      allSaved &= indexOfId(items, item.toObject()["id"].toString()) >= 0;
    if (allSaved)
      live.removeAt(i);
  }
  if (live.isEmpty())
    headlessTurns.remove(id);
  else
    headlessTurns[id] = live;
}

void Service::applyHeadlessTurns(const QString &id, Object &thread) {
  const auto live = headlessTurns.value(id);
  if (live.isEmpty() || !owned.contains(id))
    return;
  auto turns = thread["turns"].toArray();
  for (int liveIndex = 0; liveIndex < live.size(); ++liveIndex) {
    const auto observed = live[liveIndex].toObject();
    const auto turnId = observed["id"].toString();
    const int index = indexOfId(turns, turnId);
    auto base = index < 0 ? Object{} : turns[index].toObject();
    const auto preview =
        normalizeTurn(merged(observed, plans.value(turnId)), false, id,
                      [this](const QString &t, const Object &item) {
                        return registerImages(t, item);
                      });
    const auto incoming = preview["items"].toArray();
    auto items = base["items"].toArray();
    const bool savedTerminal = terminalTurn(base["status"]);
    const auto observedItems = observed["items"].toArray();
    for (int i = 0; i < incoming.size(); ++i) {
      const auto item = incoming[i].toObject();
      const auto itemId = item["id"].toString();
      const int itemIndex = indexOfId(items, itemId);
      if (itemIndex >= 0) {
        const auto saved = items[itemIndex].toObject();
        const auto rawIndex = indexOfId(observedItems, itemId);
        const bool finalItem = rawIndex >= 0 &&
            observedItems[rawIndex].toObject()["_completed"].toBool();
        const bool needsText = item["type"] == "agentMessage" &&
            !saved["completedAtMs"].isDouble() && (finalItem ||
            item["text"].toString().startsWith(saved["text"].toString()));
        if (!savedTerminal && (item["type"] == "userMessage" || needsText))
          items[itemIndex] = merged(saved, item);
        continue;
      }
      // Keep persisted tool and message ordering, using the next shared item
      // as an anchor if a read had not yet included this notification.
      int position = items.size();
      for (int j = i + 1; j < incoming.size(); ++j) {
        const int anchor = indexOfId(items, incoming[j].toObject()["id"].toString());
        if (anchor >= 0) {
          position = anchor;
          break;
        }
      }
      items.insert(position, item);
    }
    if (index < 0) {
      base = preview;
    } else {
      if (!savedTerminal)
        base["status"] = preview["status"];
      for (const auto key : {"startedAtMs", "completedAtMs", "durationMs"})
        if (!base.contains(key) && preview.contains(key))
          base[key] = preview[key];
    }
    const auto errors = mergeTurnErrors(base["errors"].toArray(), preview["errors"].toArray());
    if (!errors.isEmpty())
      base["errors"] = errors;
    base["items"] = visibleTurnItems(items, MaxLiveTurnItems);
    if (items.size() > MaxLiveTurnItems) {
      base["truncated"] = true;
      base["itemsTruncatedBefore"] = true;
    }
    if (index >= 0)
      turns[index] = base;
    else {
      // An older notification can still be pending when a newer turn has
      // already appeared in the read result.
      const int next = liveIndex + 1 < live.size()
          ? indexOfId(turns, live[liveIndex + 1].toObject()["id"].toString())
          : -1;
      turns.insert(next < 0 ? turns.size() : next, base);
    }
    thread["updatedAt"] = qMax(thread["updatedAt"].toDouble(),
                               observed["_changedAt"].toDouble());
  }
  while (turns.size() > 2) {
    turns.removeFirst();
    thread["truncated"] = true;
  }
  thread["turns"] = turns;
  const auto latest = turns.last().toObject();
  if (latest["id"] != live.last().toObject()["id"])
    return;
  const bool active = latest["status"] == "inProgress";
  thread["status"] = active ? "active" : "idle";
  thread["activeTurnId"] = active ? latest["id"] : QJsonValue(QJsonValue::Null);
  if (!active) {
    thread["activeFlags"] = Array{};
    Array requests;
    for (const auto &v : thread["requests"].toArray()) {
      const auto r = v.toObject();
      const auto details = r["details"].toObject();
      if (r["turnId"] != latest["id"] ||
          (details["isBlocking"] == false && details["source"] != "asyncMessage"))
        requests.append(r);
    }
    thread["requests"] = requests;
  }
}

void Service::watch(const QString &id, bool forceHeadless, bool background) {
  if (id.isEmpty())
    return;
  ensureThreadSlot(id);
  const bool wasDesktop = desktopThreads.contains(id);
  const auto desktopWatch = desktop->watched.value(id);
  if (desktopWatch.memoryLimited || !desktopWatch.rejection.isEmpty()) {
    if (desktopThreads.remove(id)) {
      gapUsage(id);
      rawThreads.remove(id);
      log(desktopWatch.memoryLimited ? "desktop-state-memory-limit"
                                    : desktopWatch.rejection);
    }
    if (settings["runtime"] == "desktop") {
      auto thread = snapshot["threads"].toObject()[id].toObject();
      if (!thread.isEmpty()) {
        thread["ownerAvailable"] = false;
        thread["status"] = "unavailable";
        thread["activeTurnId"] = QJsonValue::Null;
        thread["requests"] = Array{};
        thread["revision"] = double(thread["revision"].toInteger() + 1);
        commit({{"type", "thread.updated"}, {"thread", thread}});
      }
      return;
    }
  }
  if (!forceHeadless && settings["runtime"] != "headless" &&
      desktop->connected && !owned.contains(id) && desktop->follow(id)) {
    headlessTurns.remove(id);
    desktopThreads.insert(id);
    observeDesktopUsage(id);
    if (desktop->watched[id].compatible) {
      idleReads.remove(id);
      if (background && wasDesktop &&
          snapshot["threads"].toObject().contains(id)) {
        // Body changes are queued by threadChanged. Periodic maintenance only
        // refreshes independent child metadata/usage and queued messages.
        updateThread(id, !dirtyThreads.contains(id));
        return;
      }
      rawThreads[id] = desktop->watched[id].raw;
      updateThread(id);
      return;
    }
    if (settings["runtime"] == "desktop")
      return;
  }
  if (settings["runtime"] == "desktop")
    throw Error("desktop-owner-unavailable");
  ensureRpc();
  auto source =
      rpc->call("thread/read", {{"threadId", id}, {"includeTurns", false}},
                15000)["thread"]
          .toObject();
  if (source["id"] != id)
    throw Error("headless-thread-unavailable");
  const auto sourceMetadata = source;
  const auto stamp = idleReadStamp(sourceMetadata);
  const auto cached = idleReads.value(id);
  const auto previous = snapshot["threads"].toObject()[id].toObject();
  if (background && !stamp.isEmpty() && cached.stamp == stamp &&
      now() - cached.verifiedAt < 60000 && previous["status"] == "idle" &&
      previous["requests"].toArray().isEmpty() &&
      rawThreads.value(id)["_normalized"].isObject() &&
      !desktopThreads.contains(id) && !dirtyThreads.contains(id)) {
    updateThread(id, true);
    return;
  }
  if (!effectiveSettings.contains(id) && !newThreads.contains(id))
    try {
      effectiveSettings[id] = nativeSaved(savedContext(source));
    } catch (...) {
    }
  Array turns;
  try {
    turns = rpc->call("thread/turns/list", {{"threadId", id},
                                            {"limit", 2},
                                            {"sortDirection", "desc"},
                                            {"itemsView", "full"}})["data"]
                .toArray();
  } catch (...) {
    if (!newThreads.contains(id))
      throw;
  }
  Array ordered;
  for (auto it = turns.end(); it != turns.begin();) {
    auto turn = timedTurn(id, (--it)->toObject(), true);
    turn["turnId"] = turn["id"];
    turn = merged(turn, plans.value(turn["id"].toString()));
    ordered.append(turn);
  }
  Array requests;
  for (const auto &r : pendingRequests)
    if (r["params"].toObject()["threadId"] == id)
      requests.append(r);
  source["title"] = source["name"].toString().isEmpty()
                        ? source["preview"].toString("未命名会话")
                        : source["name"].toString();
  source["updatedAt"] = source["updatedAt"].toDouble() * 1000;
  auto status = source["status"].toObject();
  if (status["type"] == "notLoaded")
    status["type"] = "idle";
  source["threadRuntimeStatus"] = status;
  source["turns"] = ordered;
  source["requests"] = requests;
  source["latestThreadSettings"] = effectiveSettings[id];
  source["latestTokenUsageInfo"] = tokenUsage.value(id);
  if (desktopThreads.remove(id))
    gapUsage(id);
  rawThreads[id] = source;
  updateThread(id);
  if (status["type"] == "idle")
    reconcileHeadlessTurns(id, ordered);
  if (!stamp.isEmpty() && stamp == idleReadStamp(sourceMetadata))
    idleReads[id] = {stamp, now()};
  else
    idleReads.remove(id);
}
void Service::queueThreadUpdate(const QString &id) {
  if (!id.isEmpty() && !dirtyThreads.contains(id))
    dirtyThreads.append(id);
}
void Service::updateThread(const QString &id, bool metadataOnly, bool enrich) {
  auto old = snapshot["threads"].toObject()[id].toObject();
  metadataOnly = metadataOnly && !old.isEmpty();
  Object raw;
  if (metadataOnly) {
    raw = {{"id", id}, {"codexerSubAgents", old["subAgents"]},
           {"codexerSubAgentsTruncated", old["subAgentsTruncated"]}};
  } else {
    raw = rawThreads.value(id);
    if (desktopThreads.contains(id) && !desktop->watched.value(id).raw.isEmpty())
      raw = desktop->watched.value(id).raw;
    if (raw.isEmpty())
      return;
  }
  const auto desktopWatch = desktop->watched.value(id);
  Object thread;
  if (metadataOnly) {
    if (enrich) enrichAgents(id, raw);
    if (snapshot.isEmpty()) return;
    old = snapshot["threads"].toObject()[id].toObject();
    thread = old;
    if (raw["codexerAgentDetails"].isArray())
      thread["subAgents"] = raw["codexerAgentDetails"];
    thread["subAgentsTruncated"] = raw["codexerSubAgentsTruncated"];
    thread["revision"] = double(old["revision"].toInteger(-1) + 1);
  } else if (!desktopThreads.contains(id) && raw["_normalized"].isObject()) {
    thread = raw["_normalized"].toObject();
    thread["revision"] = double(old["revision"].toInteger(-1) + 1);
  } else {
    raw["codexerSubAgents"] = old["subAgents"].toArray();
    raw["codexerSubAgentsTruncated"] = old["subAgentsTruncated"].toBool();
    if (enrich) {
      enrichAgents(id, raw);
      // A cached-state flush may have published newer IPC state while metadata
      // enrichment waited. Never overwrite it with the pre-wait conversation.
      if (desktopThreads.contains(id) &&
          (desktop->watched.value(id).revision != desktopWatch.revision ||
           desktop->watched.value(id).owner != desktopWatch.owner ||
           desktop->watched.value(id).receivedAt != desktopWatch.receivedAt)) {
        updateThread(id, false, false);
        return;
      }
      old = snapshot["threads"].toObject()[id].toObject();
    }
    if (snapshot.isEmpty())
      return;
    thread = normalizeThread(raw, old["revision"].toInteger(-1) + 1,
                             [this](const QString &t, const Object &item) {
                               return registerImages(t, item);
                             });
  }
  if (desktopThreads.contains(id) && !desktop->watched.value(id).compatible) {
    thread["ownerAvailable"] = false;
    thread["status"] = "unavailable";
    thread["activeTurnId"] = QJsonValue::Null;
    thread["requests"] = Array{};
  }
  if (!desktopThreads.contains(id))
    applyHeadlessTurns(id, thread);
  auto turns = thread["turns"].toArray();
  for (int i = 0; i < turns.size(); ++i) {
    auto turn = turns[i].toObject();
    const auto errors = recordTurnErrors(id, turn["id"].toString(), turn["errors"].toArray());
    if (!errors.isEmpty()) {
      turn["errors"] = errors;
      if (turn["status"] == "inProgress" && hasFinalTurnError(errors))
        turn["status"] = "failed";
    }
    observeFiles(id, turn);
    enrichUsage(id, turn);
    turns[i] = turn;
  }
  thread["turns"] = turns;
  const auto latest = turns.isEmpty() ? Object{} : turns.last().toObject();
  if (latest["status"] == "failed" && hasFinalTurnError(latest["errors"].toArray()) &&
      (thread["status"] == "active" || thread["status"] == "systemError") &&
      (thread["activeTurnId"].toString().isEmpty() || thread["activeTurnId"] == latest["id"])) {
    thread["status"] = "idle";
    thread["activeTurnId"] = QJsonValue::Null;
    thread["activeFlags"] = Array{};
    Array requests;
    for (const auto &value : thread["requests"].toArray())
      if (value.toObject()["turnId"] != latest["id"])
        requests.append(value);
    thread["requests"] = requests;
  }
  Array queue;
  for (const auto &v : queued(id)) {
    auto q = v.toObject();
    queue.append(Object{{"id", q["id"]},
                        {"text", q["text"].toString().left(1000)},
                        {"imageCount", q["images"].toArray().size()},
                        {"fileCount", q["attachments"].toArray().size()},
                        {"createdAt", q["createdAt"]},
                        {"status", q["status"]}});
  }
  thread["queuedMessages"] = queue;
  if (old["usage"].isObject())
    thread["usage"] = old["usage"];
  // Metadata/activity refreshes can omit usage. Keep the independent child
  // accounting until the next read-only usage scan replaces it.
  QHash<QString, Object> priorAgentUsage;
  for (const auto &v : old["subAgents"].toArray()) {
    const auto a = v.toObject();
    if (a["usage"].isObject()) priorAgentUsage[a["threadId"].toString()] = a["usage"].toObject();
  }
  auto agents = thread["subAgents"].toArray();
  QSet<QString> agentIds;
  for (const auto &v : agents) agentIds.insert(v.toObject()["threadId"].toString());
  for (const auto &v : old["subAgents"].toArray()) {
    const auto a = v.toObject();
    const auto child = a["threadId"].toString();
    if (child != id && !agentIds.contains(child) && agents.size() < 32) {
      agents.append(a);
      agentIds.insert(child);
    }
  }
  if (old["subAgentsTruncated"].toBool()) thread["subAgentsTruncated"] = true;
  for (int i = 0; i < agents.size(); ++i) {
    auto a = agents[i].toObject();
    if (priorAgentUsage.contains(a["threadId"].toString())) {
      a["usage"] = priorAgentUsage.value(a["threadId"].toString());
      agents[i] = a;
    }
  }
  thread["subAgents"] = agents;
  thread = boundTurns(thread);
  auto comparable = old;
  comparable["revision"] = thread["revision"];
  if (thread != comparable)
    commit({{"type", "thread.updated"}, {"thread", thread}});
  if (thread["status"] == "active")
    awaitingQueue.remove(id);
  if (!desktopThreads.contains(id)) {
    // Keep the bounded display state, not every raw tool output from the RPC
    // response.
    if (metadataOnly) {
      rawThreads[id]["_normalized"] = thread;
      return;
    }
    rawThreads[id] = {{"id", id},
                      {"cwd", raw["cwd"]},
                      {"projectId", raw["projectId"]},
                      {"latestThreadSettings", effectiveSettings[id]},
                      {"_normalized", thread}};
  }
}

Object Service::timedTurn(const QString &id, Object turn, bool recent) {
  auto timings = turn["itemTimingsById"].toObject();
  QSet<QString> missing;
  auto items = turn["items"].toArray();
  for (int i = qMax(0, int(items.size()) - (recent ? 20 : 80));
       i < items.size(); ++i)
    missing.insert(items[i].toObject()["id"].toString());
  QJsonValue cursor(QJsonValue::Null);
  for (int n = 0; n < 2 && !missing.isEmpty(); ++n) {
    try {
      auto page = rpc->call("thread/items/list",
                            {{"threadId", id},
                             {"turnId", turn["id"]},
                             {"cursor", cursor},
                             {"limit", 100},
                             {"sortDirection", recent ? "desc" : "asc"}},
                            5000);
      if (!page["data"].isArray() || page["data"].toArray().size() > 100)
        break;
      for (auto v : page["data"].toArray()) {
        auto e = v.toObject();
        auto itemId = e["item"].toObject()["id"].toString();
        if (e["turnId"] != turn["id"] || itemId.isEmpty())
          continue;
        Object t;
        for (auto key : {"startedAtMs", "completedAtMs"})
          if (e[key].isDouble())
            t[key] = e[key];
        timings[itemId] = t;
        missing.remove(itemId);
      }
      cursor = page["nextCursor"];
      if (!cursor.isString() || cursor.toString().isEmpty())
        break;
    } catch (...) {
      break;
    }
  }
  turn["itemTimingsById"] = timings;
  return turn;
}
void Service::enrichAgents(const QString &id, Object &raw) {
  if (!rpc || !rpc->connected())
    return;
  const auto initial = subAgentMetadata(raw)["subAgents"].toArray();
  QHash<QString, Object> agents;
  for (auto v : initial)
    agents[v.toObject()["threadId"].toString()] = v.toObject();
  QHash<QString, Object> metadata;
  try {
    auto page = rpc->call(
        "thread/list",
        {{"ancestorThreadId", id},
         {"sourceKinds", Array{"subAgent", "subAgentReview", "subAgentCompact",
                               "subAgentThreadSpawn", "subAgentOther"}},
         {"limit", 33},
         {"sortKey", "updated_at"},
         {"sortDirection", "desc"},
         {"useStateDbOnly", true}},
        5000);
    for (auto v : page["data"].toArray()) {
      auto t = v.toObject();
      auto child = t["id"].toString();
      if (child.isEmpty() || child == id || child.size() > 160)
        continue;
      metadata[child] = t;
      if (!agents.contains(child))
        agents[child] = {{"threadId", child},
                         {"parentThreadId", id},
                         {"status", "unknown"},
                         {"statusSource", "reported"}};
    }
    if (page["data"].toArray().size() > 32 || page["nextCursor"].isString())
      raw["codexerSubAgentsTruncated"] = true;
  } catch (...) {
  }
  Array result;
  for (auto it = agents.begin(); it != agents.end() && result.size() < 32;
       ++it) {
    auto child = it.key();
    auto a = it.value();
    auto key = id + ':' + child;
    if (now() - agentDetailsAt.value(key) > 2000) {
      Object t = metadata.value(child);
      if (t.isEmpty())
        try {
          t = rpc->call("thread/read",
                        {{"threadId", child}, {"includeTurns", false}},
                        3000)["thread"]
                  .toObject();
        } catch (...) {
        }
      Object detail;
      if (t["id"] == child) {
        for (const auto &pair : QList<QPair<QString, QString>>{
                 {"name", "agentNickname"},
                 {"role", "agentRole"},
                 {"parentThreadId", "parentThreadId"}})
          if (t[pair.second].isString())
            detail[pair.first] = t[pair.second].toString().left(
                pair.first == "parentThreadId" ? 160 : 256);
        // Only inspect bounded plaintext in a verified child's rollout. Never
        // forward encrypted content.
        auto path = t["path"].toString();
        QFileInfo f(path);
        auto root = QFileInfo(settings["codexHome"].toString() + "/sessions")
                        .canonicalFilePath();
        if (!root.isEmpty() && f.isFile() && path.endsWith(".jsonl") &&
            within(root, f.canonicalFilePath()))
          try {
            QFile file(f.canonicalFilePath());
            if (!file.open(QIODevice::ReadOnly))
              throw Error("file-unavailable");
            auto head = file.read(256 * 1024);
            auto lines = head.split('\n');
            Object meta = parse(lines.first()).toObject();
            auto p = meta["payload"].toObject();
            auto spawn = p["source"]
                             .toObject()["subagent"]
                             .toObject()["thread_spawn"]
                             .toObject();
            if (meta["type"] != "session_meta" || p["id"] != child ||
                p["parent_thread_id"].toString(
                    spawn["parent_thread_id"].toString()) != id ||
                (spawn.contains("parent_thread_id") &&
                 spawn["parent_thread_id"] != id))
              throw Error("sub-agent-parent-mismatch");
            for (const auto &pair :
                 QList<QPair<QString, QString>>{{"name", "agent_nickname"},
                                                {"role", "agent_role"},
                                                {"path", "agent_path"}}) {
              auto v = p[pair.second].toString(spawn[pair.second].toString());
              if (!v.isEmpty())
                detail[pair.first] = v.left(pair.first == "path" ? 1000 : 256);
            }
            if (file.size() > head.size()) {
              file.seek(qMax<qint64>(head.size(), file.size() - 256 * 1024));
              auto tail = file.read(256 * 1024).split('\n');
              if (!tail.isEmpty())
                tail.removeFirst();
              lines += tail;
            }
            for (auto line : lines)
              try {
                auto event = parse(line).toObject();
                auto v = event["payload"].toObject();
                if (event["type"] == "turn_context" && v["model"].isString())
                  detail["model"] = v["model"].toString().left(200);
                if (event["type"] == "event_msg") {
                  auto kind = v["type"].toString();
                  if (QStringList{"task_started", "task_complete",
                                  "turn_aborted", "task_interrupted",
                                  "task_failed"}
                          .contains(kind)) {
                    detail["status"] = kind == "task_started"    ? "running"
                                       : kind == "task_complete" ? "completed"
                                       : kind == "task_failed"   ? "errored"
                                                               : "interrupted";
                    detail["statusSource"] = "activity";
                  }
                  if (kind == "task_started")
                    detail.remove("message");
                  if (v["last_agent_message"].isString())
                    detail["message"] =
                        v["last_agent_message"].toString().left(2000);
                }
                if (event["type"] == "response_item" &&
                    v["type"] == "message" &&
                    (v["role"] == "assistant" || v["role"] == "user")) {
                  QStringList text;
                  for (auto part : v["content"].toArray())
                    if (QStringList{"input_text", "output_text", "text"}
                            .contains(part.toObject()["type"].toString()) &&
                        part.toObject()["text"].isString())
                      text << part.toObject()["text"].toString();
                  auto body = text.join('\n').trimmed();
                  if (!body.isEmpty() &&
                      !QRegularExpression(
                           "^(# "
                           "AGENTS\\.md|<environment_context>|<INSTRUCTIONS>)")
                           .match(body)
                           .hasMatch())
                    detail[v["role"] == "user" ? "task" : "message"] =
                        body.left(2000);
                }
              } catch (...) {
              }
          } catch (...) {
          }
        auto runtime = t["status"].toObject()["type"].toString();
        if (runtime == "active" || runtime == "systemError" ||
            (runtime == "idle" &&
             QStringList{"unknown", "running", "pendingInit", "idle"}.contains(
                 detail["status"].toString(a["status"].toString())))) {
          detail["status"] = runtime == "active"        ? "running"
                             : runtime == "systemError" ? "errored"
                                                        : "idle";
          detail["statusSource"] = "thread";
        }
      }
      agentDetails[key] = detail;
      agentDetailsAt[key] = now();
    }
    a = merged(a, agentDetails.value(key));
    if (a["status"] == "running")
      a.remove("message");
    result.append(a);
  }
  raw["codexerAgentDetails"] = result;
}

Object Service::history(const QString &id, QJsonValue cursor) {
  ensureRpc();
  const QString prefix = "codexer-items-v1:";
  Object window;
  auto pageCursor = cursor;
  if (cursor.toString().startsWith(prefix)) {
    try { window = parse(QByteArray::fromBase64(cursor.toString().mid(prefix.size()).toLatin1(), QByteArray::Base64UrlEncoding)).toObject(); }
    catch (...) { throw Error("history-cursor-invalid"); }
    if (window["thread"] != id || !window["turn"].isString() ||
        !(window["page"].isNull() || window["page"].isString()) || !window["before"].isString())
      throw Error("history-cursor-invalid");
    pageCursor = window["page"];
  }
  auto page = rpc->call("thread/turns/list", {{"threadId", id},
                                              {"cursor", pageCursor},
                                              {"limit", 5},
                                              {"sortDirection", "desc"},
                                              {"itemsView", "full"}});
  if (!page["data"].isArray() || page["data"].toArray().size() > 5)
    throw Error("history-response-invalid");
  Array turns;
  QJsonValue nextCursor = page.value("nextCursor");
  bool found = window.isEmpty();
  bool full = false;
  auto continuation = [&](const Object &turn, const QString &before) {
    auto encoded = prefix + QString::fromLatin1(json(Object{{"thread", id}, {"page", pageCursor},
      {"turn", turn["id"]}, {"before", before}}).toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
    if (encoded.size() > 2048) throw Error("history-cursor-too-large");
    return encoded;
  };
  for (const auto &v : page["data"].toArray()) {
    auto source = v.toObject();
    if (!found && source["id"] != window["turn"]) continue;
    auto items = source["items"].toArray();
    int end = items.size();
    if (!found && !window["before"].toString().isEmpty()) {
      end = -1;
      for (int i = 0; i < items.size(); ++i) if (items[i].toObject()["id"] == window["before"]) {end = i; break;}
      if (end < 0) throw Error("history-cursor-stale");
    }
    found = true;
    int start = qMax(0, end - 80);
    source = timedTurn(id, source, false);
    auto turn = normalizeTurn(source, true, id,
                              [this](const QString &t, const Object &item) {
                                return registerImages(t, item);
                              });
    const auto errors = recordTurnErrors(id, turn["id"].toString(), turn["errors"].toArray());
    if (!errors.isEmpty()) {
      turn["errors"] = errors;
      if (turn["status"] == "inProgress" && hasFinalTurnError(errors))
        turn["status"] = "failed";
    }
    const auto allChanges = turn.value("fileChanges");
    do {
      Array slice; for (int i = start; i < end; ++i) slice.append(items[i]);
      auto raw = source; raw["items"] = slice;
      auto normalized = normalizeTurn(raw, true, id, [this](const QString &t, const Object &item) {return registerImages(t, item);});
      turn["items"] = normalized["items"];
      if (!allChanges.isUndefined()) turn["fileChanges"] = allChanges;
      Array candidate = turns; candidate.append(turn);
      if (json(Object{{"turns", candidate}}).size() <= 5 * 1024 * 1024) break;
      if (!turns.isEmpty()) {nextCursor = continuation(source, end < items.size() ? items[end].toObject()["id"].toString() : QString()); full = true; break;}
      if (end - start <= 1) throw Error("history-too-large");
      start += qMax(1, (end - start) / 2);
    } while (true);
    if (full) break;
    turn["itemsTruncatedBefore"] = start > 0;
    turn["itemsTruncatedAfter"] = end < items.size();
    turn["truncated"] = start > 0 || end < items.size() || turn["truncated"].toBool();
    observeFiles(id, turn);
    enrichUsage(id, turn);
    turns.append(turn);
    if (start > 0) {nextCursor = continuation(source, items[start].toObject()["id"].toString()); break;}
  }
  if (!found) throw Error("history-cursor-stale");
  Object result{{"threadId", id},
                {"turns", turns},
                {"nextCursor", nextCursor},
                {"generatedAt", double(now())}};
  result = boundTurns(result, 6 * 1024 * 1024);
  if (json(result).size() > 6 * 1024 * 1024)
    throw Error("history-too-large");
  return result;
}
Object Service::release(bool force) {
  Object result{{"released", 0}, {"deferred", owned.size()}};
  if (owned.isEmpty() || active() || !pendingRequests.isEmpty() ||
      !newThreads.isEmpty() || refreshing)
    return result;
  for (const auto &id : owned) {
    if (!force && now() - acquired[id] < 5000)
      return result;
    auto t = rpc->call("thread/read",
                       {{"threadId", id}, {"includeTurns", false}})["thread"]
                 .toObject();
    if (t["id"] != id || !QStringList{"idle", "notLoaded"}.contains(
                             t["status"].toObject()["type"].toString()))
      return result;
  }
  int count = owned.size();
  if (refresh(true) == "refreshed") {
    result["released"] = count;
    result["deferred"] = 0;
    log("idle-session-writers-released");
  }
  return result;
}
QString Service::refresh(bool force) {
  if (active() || !pendingRequests.isEmpty() || !newThreads.isEmpty() ||
      refreshing)
    return "deferred";
  if (!rpc) {
    if (force)
      ensureRpc();
    refreshRequested = false;
    return force ? "refreshed" : "unchanged";
  }
  if (!force && rpc->connected() &&
      rpc->identity == fingerprint(executable(settings)))
    return "unchanged";
  QScopedValueRollback<bool> lock(refreshing, true);
  auto replacement = new Rpc(this);
  try {
    replacement->start(settings);
  } catch (...) {
    delete replacement;
    throw;
  }
  auto old = rpc;
  rpc = replacement;
  idleReads.clear();
  headlessTurns.clear();
  attachRpc(rpc);
  disconnect(old, nullptr, this, nullptr);
  for (const auto &id : usageObservations.keys())
    if (!desktopThreads.contains(id))
      gapUsage(id);
  delete old;
  owned.clear();
  acquired.clear();
  answeredRequests.clear();
  for (const auto &id : rawThreads.keys())
    queueThreadUpdate(id);
  refreshRequested = false;
  log("codex-runtime-refreshed");
  return "refreshed";
}
} // namespace Native
