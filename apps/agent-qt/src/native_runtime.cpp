#include "native.h"
#include <limits>
#include <zstd.h>
namespace Native {
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
    dirtyThreads.insert(p["threadId"].toString());
  });
  connect(value, &Rpc::notification, this, [this](QString method, Object p) {
    auto id = p["threadId"].toString(), turnId = p["turnId"].toString();
    if (id.isEmpty())
      return;
    if (method == "turn/started") {
      auto tid = p["turn"].toObject()["id"].toString();
      busyTurns.insert(tid);
      auto prior = usageObservations[id];
      usageObservations[id] = {
          {"turnId", tid}, {"baseline", prior["baseline"]}, {"coverage", true}};
    }
    if (method == "turn/completed") {
      awaitingQueue.remove(id);
      auto tid = p["turn"].toObject()["id"].toString();
      if (!busyTurns.remove(tid))
        completedTurns.insert(tid);
      for (const auto &key : pendingRequests.keys()) {
        auto params = pendingRequests[key]["params"].toObject();
        if (params["turnId"] == tid && params["isBlocking"] != false)
          pendingRequests.remove(key);
      }
      if (usage.isOpen())
        try {
          auto row = sql(
              usage,
              "SELECT value FROM turn_usage WHERE thread_id=? AND turn_id=?",
              {id, tid});
          if (row.next()) {
            auto u = parse(row.value(0).toByteArray()).toObject();
            u["state"] = usageObservations[id]["coverage"].toBool() ? "complete"
                                                                    : "partial";
            sql(usage,
                "UPDATE turn_usage SET value=? WHERE thread_id=? AND turn_id=?",
                {json(u), id, tid});
          }
        } catch (...) {
        }
      usageObservations[id]["idle"] = true;
    }
    if (method == "serverRequest/resolved")
      pendingRequests.remove(p["requestId"].toVariant().toString());
    if (method == "thread/settings/updated")
      effectiveSettings[id] =
          merged(effectiveSettings[id], p["threadSettings"].toObject());
    if (method == "turn/plan/updated")
      plans[turnId]["plan"] = p["plan"];
    if (method == "turn/diff/updated")
      plans[turnId]["diff"] = p["diff"];
    if (method == "thread/tokenUsage/updated") {
      tokenUsage[id] = p["tokenUsage"].toObject();
      try {
        observeUsage(id, turnId, p["tokenUsage"].toObject(), true);
      } catch (...) {
      }
    }
    dirtyThreads.insert(id);
  });
  connect(value, &Rpc::disconnected, this, [this, value] {
    if (rpc != value || refreshing)
      return;
    owned.clear();
    acquired.clear();
    busyTurns.clear();
    pendingRequests.clear();
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
                               threads, models);
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
  if (json(next).size() > 6 * 1024 * 1024 || projects.size() > 1000 ||
      listed.size() > 10000)
    throw Error("catalog-too-large");
  catalog = next;
  send({{"type", "device.catalog"}, {"catalog", catalog}});
  int count = 0;
  for (const auto &v : listed) {
    auto t = v.toObject();
    if (t["archived"].toBool())
      continue;
    auto id = t["id"].toString();
    if (count++ < threadLimit)
      dirtyThreads.insert(id);
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
    rawThreads.remove(removable);
    dirtyThreads.remove(removable);
    desktop->unfollow(removable);
    desktopThreads.remove(removable);
  }
  return true;
}
void Service::watch(const QString &id, bool forceHeadless) {
  if (id.isEmpty())
    return;
  ensureThreadSlot(id);
  if (!forceHeadless && settings["runtime"] != "headless" &&
      desktop->connected && !owned.contains(id) && desktop->follow(id)) {
    desktopThreads.insert(id);
    if (desktop->watched[id].compatible) {
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
    turn = merged(turn, plans[turn["id"].toString()]);
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
  desktopThreads.remove(id);
  rawThreads[id] = source;
  updateThread(id);
}
void Service::updateThread(const QString &id) {
  auto raw = rawThreads[id];
  if (desktopThreads.contains(id))
    raw = desktop->watched[id].raw;
  if (raw.isEmpty())
    return;
  auto old = snapshot["threads"].toObject()[id].toObject();
  const auto revision = old["revision"].toInteger(-1) + 1;
  Object thread;
  if (!desktopThreads.contains(id) && raw["_normalized"].isObject()) {
    thread = raw["_normalized"].toObject();
    thread["revision"] = double(revision);
  } else {
    raw["codexerSubAgents"] = old["subAgents"].toArray();
    raw["codexerSubAgentsTruncated"] = old["subAgentsTruncated"].toBool();
    enrichAgents(id, raw);
    thread = normalizeThread(raw, revision,
                             [this](const QString &t, const Object &item) {
                               return registerImages(t, item);
                             });
  }
  if (desktopThreads.contains(id) && !desktop->watched[id].compatible) {
    thread["ownerAvailable"] = false;
    thread["status"] = "unavailable";
    thread["activeTurnId"] = QJsonValue::Null;
    thread["requests"] = Array{};
  }
  auto turns = thread["turns"].toArray();
  for (int i = 0; i < turns.size(); ++i) {
    auto turn = turns[i].toObject();
    observeFiles(id, turn);
    enrichUsage(id, turn);
    turns[i] = turn;
  }
  thread["turns"] = turns;
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
  auto comparable = old;
  comparable["revision"] = thread["revision"];
  if (thread != comparable)
    commit({{"type", "thread.updated"}, {"thread", thread}});
  if (thread["status"] == "active")
    awaitingQueue.remove(id);
  if (!desktopThreads.contains(id)) {
    // Keep the bounded display state, not every raw tool output from the RPC
    // response.
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
  auto initial = normalizeThread(raw, 0)["subAgents"].toArray();
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
  auto page = rpc->call("thread/turns/list", {{"threadId", id},
                                              {"cursor", cursor},
                                              {"limit", 5},
                                              {"sortDirection", "desc"},
                                              {"itemsView", "full"}});
  if (!page["data"].isArray() || page["data"].toArray().size() > 5)
    throw Error("history-response-invalid");
  Array turns;
  for (const auto &v : page["data"].toArray()) {
    auto turn = normalizeTurn(timedTurn(id, v.toObject(), false), true, id,
                              [this](const QString &t, const Object &item) {
                                return registerImages(t, item);
                              });
    observeFiles(id, turn);
    enrichUsage(id, turn);
    turns.append(turn);
  }
  Object result{{"threadId", id},
                {"turns", turns},
                {"nextCursor", page["nextCursor"]},
                {"generatedAt", double(now())}};
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
  attachRpc(rpc);
  disconnect(old, nullptr, this, nullptr);
  delete old;
  owned.clear();
  acquired.clear();
  answeredRequests.clear();
  for (const auto &id : rawThreads.keys())
    dirtyThreads.insert(id);
  refreshRequested = false;
  log("codex-runtime-refreshed");
  return "refreshed";
}
} // namespace Native
