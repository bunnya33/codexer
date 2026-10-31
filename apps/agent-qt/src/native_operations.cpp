#include "native.h"
namespace Native {
static Object findThread(const Object &catalog, const QString &id) {
  for (const auto &v : catalog["threads"].toArray())
    if (v.toObject()["id"] == id)
      return v.toObject();
  return {};
}
static Object findProject(const Object &catalog, const QString &id) {
  for (const auto &v : catalog["projects"].toArray())
    if (v.toObject()["id"] == id)
      return v.toObject();
  return {};
}
static Array appendText(const Array &inputs, const QString &text) {
  Array result;
  if (!text.trimmed().isEmpty())
    result.append(
        Object{{"type", "text"}, {"text", text}, {"text_elements", Array{}}});
  for (const auto &v : inputs)
    result.append(v);
  return result;
}
void Service::checkCommand(const Object &command, int generation) const {
  if (paused || !allowed || stopping || generation != remoteGeneration)
    throw Error("remote-disconnected");
  if (now() >= command["expiresAt"].toDouble())
    throw Error("command-expired");
}
Object Service::execute(Object command) {
  const auto generation = remoteGeneration;
  checkCommand(command, generation);
  auto p = command["payload"].toObject();
  auto type = p["type"].toString(), id = p["threadId"].toString();
  if (paused || !allowed || stopping)
    throw Error("remote-disconnected");
  if (type == "runtime.refresh") {
    refreshRequested = true;
    return {{"runtimeRefresh", refresh(true)}};
  }
  if (type.startsWith("project."))
    return project(command);
  if (type == "thread.create" || type == "thread.rename" ||
      type == "thread.archive" || type == "thread.delete")
    return manage(command);
  if (findThread(catalog, id).isEmpty() && !newThreads.contains(id))
    throw Error("thread-not-in-catalog");
  watch(id);
  checkCommand(command, generation);
  if (type == "thread.watch")
    return {{"watched", true}};
  if (type.startsWith("turn.queue"))
    return queue(command);
  auto prepared = inputs(id, p["images"].toArray(), p["attachments"].toArray());
  if (generation != remoteGeneration || paused || !allowed)
    throw Error("remote-disconnected");
  if (now() >= command["expiresAt"].toDouble())
    throw Error("command-expired");
  try {
    return executeTurn(command, prepared, desktopThreads.contains(id));
  } catch (const Error &error) {
    if (error.code != "thread-writer-busy" || error.uncertain ||
        settings["runtime"] == "headless" || !desktop->connected ||
        desktopThreads.contains(id))
      throw;
    if (!desktop->follow(id, true) ||
        !waitFor(
            [&] {
              return desktop->watched.contains(id) &&
                     desktop->watched[id].compatible;
            },
            2000))
      throw;
    if (generation != remoteGeneration || paused || !allowed ||
        now() >= command["expiresAt"].toDouble())
      throw Error("remote-disconnected");
    desktopThreads.insert(id);
    rawThreads[id] = desktop->watched[id].raw;
    updateThread(id);
    return executeTurn(command, prepared, true);
  }
}
Object Service::executeTurn(Object command, const Array &prepared,
                            bool onDesktop) {
  const auto generation = remoteGeneration;
  auto p = command["payload"].toObject();
  auto type = p["type"].toString(), id = p["threadId"].toString(),
       turnId = p["turnId"].toString();
  auto thread = snapshot["threads"].toObject()[id].toObject(),
       s = thread["settings"].toObject();
  if (!thread["ownerAvailable"].toBool())
    throw Error("thread-owner-unavailable");
  if (onDesktop &&
      (!desktop->watched.contains(id) || !desktop->watched[id].compatible))
    throw Error("desktop-owner-unavailable");
  if (type == "input.respond" &&
      p["requestId"].toString().startsWith("async:")) {
    Object request;
    for (const auto &v : thread["requests"].toArray())
      if (v.toObject()["id"] == p["requestId"] &&
          v.toObject()["turnId"] == p["turnId"] &&
          v.toObject()["respondable"].toBool())
        request = v.toObject();
    if (request.isEmpty() || thread["activeTurnId"] != p["turnId"])
      throw Error("stale-request");
    p = {{"type", "turn.steer"},
         {"threadId", id},
         {"turnId", turnId},
         {"text", asyncAnswer(request, p["answers"].toObject())}};
    command["payload"] = p;
    return executeTurn(command, {}, onDesktop);
  }
  if (type == "turn.start" && thread["status"] != "idle")
    throw Error("thread-not-idle");
  if (QStringList{"turn.steer", "turn.interrupt", "approval.respond"}.contains(
          type) &&
      thread["activeTurnId"] != p["turnId"])
    throw Error("stale-turn");
  QString method;
  Object params, expected, settingsChange;
  auto owner = onDesktop ? desktop->watched[id].owner : QString{};
  if (type == "turn.start") {
    Object request{{"threadId", id},
                   {"input", appendText(prepared, p["text"].toString())},
                   {"clientUserMessageId", command["commandId"]}};
    if (onDesktop) {
      method = "thread-follower-start-turn";
      params = {
          {"conversationId", id},
          {"turnStart",
           Object{{"request", request},
                  {"context", Object{{"attachments", Array{}},
                                     {"commentAttachments", Array{}},
                                     {"mcpAppModelContextAttachments", Array{}},
                                     {"responseItems", Array{}},
                                     {"inheritThreadSettings", true}}}}}};
    } else {
      auto saved = resume(id);
      checkCommand(command, generation);
      for (const auto &key : {"effort", "summary", "collaborationMode"})
        if (saved.contains(key))
          request[key] = saved[key];
      method = "turn/start";
      params = request;
    }
  } else if (type == "turn.steer") {
    if (onDesktop) {
      auto text = p["text"].toString();
      method = "thread-follower-steer-turn";
      params = {
          {"conversationId", id},
          {"input", appendText(prepared, text)},
          {"clientUserMessageId", command["commandId"]},
          {"restoreMessage",
           Object{{"id", command["commandId"]},
                  {"text", text},
                  {"context",
                   Object{{"prompt", text},
                          {"messageThreadId", id},
                          {"turnTrigger",
                           text.startsWith("<send_user_message_question_reply>")
                               ? "send_user_message_async_question"
                               : "user"},
                          {"addedFiles", Array{}},
                          {"fileAttachments", Array{}},
                          {"ideContext", QJsonValue::Null},
                          {"imageAttachments", Array{}},
                          {"workspaceRoots", thread["cwd"].isString()
                                                 ? Array{thread["cwd"]}
                                                 : Array{}}}},
                  {"cwd", thread["cwd"]},
                  {"createdAt", double(now())}}},
          {"attachments", Array{}},
          {"serviceTier", QJsonValue::Null},
          {"additionalContext", QJsonValue::Null},
          {"toolOutput", QJsonValue::Null}};
    } else {
      method = "turn/steer";
      params = {{"threadId", id},
                {"expectedTurnId", turnId},
                {"clientUserMessageId", command["commandId"]},
                {"input", appendText(prepared, p["text"].toString())}};
    }
  } else if (type == "turn.interrupt") {
    method = onDesktop ? "thread-follower-interrupt-turn" : "turn/interrupt";
    params = onDesktop ? Object{{"conversationId", id},
                                {"mode", "user-stop"},
                                {"expectedTurnId", turnId}}
                       : Object{{"threadId", id}, {"turnId", turnId}};
  } else if (type.startsWith("thread.") && type.endsWith(".update")) {
    if (thread["status"] != "idle")
      throw Error("thread-not-idle");
    Object change;
    if (type == "thread.permissions.update") {
      if (s["permissions"].toObject()["fingerprint"] !=
          p["expectedPermissions"])
        throw Error("stale-permissions");
      if (!QStringList{"read-only", "ask", "auto-review", "full-access"}
               .contains(p["mode"].toString()))
        throw Error("invalid-permissions");
      Array roots =
          onDesktop ? desktop->watched[id]
                          .raw["latestThreadSettings"]
                          .toObject()["runtimeWorkspaceRoots"]
                          .toArray()
                    : effectiveSettings[id]["runtimeWorkspaceRoots"].toArray();
      if (roots.isEmpty() && thread["cwd"].isString())
        roots.append(thread["cwd"]);
      if (roots.isEmpty() &&
          QStringList{"ask", "auto-review"}.contains(p["mode"].toString()))
        throw Error("workspace-roots-unavailable");
      if (!onDesktop) {
        resume(id);
        roots = effectiveSettings[id]["runtimeWorkspaceRoots"].toArray();
      }
      change = permissionPreset(p["mode"].toString(), roots);
      expected = {{"permissions", permissionSettings(change)}};
    } else {
      if (s["model"] != p["expectedModel"])
        throw Error("stale-model");
      if (type != "thread.model.update" &&
          s["reasoningEffort"] != p["expectedEffort"])
        throw Error("stale-effort");
      if (type == "thread.mode.update" &&
          s["collaborationMode"] != p["expectedMode"])
        throw Error("stale-settings");
      if (!onDesktop) {
        const auto saved = resume(id);
        if (saved["model"] != p["expectedModel"])
          throw Error("stale-model");
        if (type != "thread.model.update" &&
            saved["effort"].toString() != p["expectedEffort"].toString())
          throw Error("stale-effort");
      }
      if (type == "thread.model.update") {
        Object model;
        for (const auto &v : catalog["models"].toArray())
          if (v.toObject()["model"] == p["model"])
            model = v.toObject();
        if (model.isEmpty())
          throw Error("unsupported-model");
        change["model"] = p["model"];
        auto effort = s["reasoningEffort"];
        change["effort"] =
            model["supportedReasoningEfforts"].toArray().contains(effort)
                ? effort
                : model["defaultReasoningEffort"];
        expected = {{"model", p["model"]}};
      }
      if (type == "thread.effort.update") {
        bool supported = false;
        for (const auto &v : catalog["models"].toArray())
          if (v.toObject()["model"] == p["expectedModel"] &&
              v.toObject()["supportedReasoningEfforts"].toArray().contains(
                  p["effort"]))
            supported = true;
        if (!supported)
          throw Error("unsupported-effort");
        change["effort"] = p["effort"];
        expected = {{"effort", p["effort"]}};
      }
      if (type == "thread.mode.update") {
        if (!QStringList{"default", "plan"}.contains(p["mode"].toString()))
          throw Error("unsupported-collaboration-mode");
        change["collaborationMode"] = Object{
            {"mode", p["mode"]},
            {"settings", Object{{"model", s["model"]},
                                {"reasoning_effort", s["reasoningEffort"]},
                                {"developer_instructions", QJsonValue::Null}}}};
        expected = {{"mode", p["mode"]}};
      }
      if (!onDesktop && type != "thread.mode.update" &&
          effectiveSettings[id]["collaborationMode"].isObject()) {
        auto mode = effectiveSettings[id]["collaborationMode"].toObject();
        auto modeSettings = mode["settings"].toObject();
        modeSettings["model"] =
            change.contains("model") ? change["model"] : s["model"];
        modeSettings["reasoning_effort"] =
            change.contains("effort") ? change["effort"] : s["reasoningEffort"];
        mode["settings"] = modeSettings;
        change["collaborationMode"] = mode;
      }
    }
    method = onDesktop ? "thread-follower-update-thread-settings"
                       : "thread/settings/update";
    params = onDesktop
                 ? Object{{"conversationId", id}, {"threadSettings", change}}
                 : merged({{"threadId", id}}, change);
    if (onDesktop && type != "thread.permissions.update")
      params["condition"] = Object{{"ifModelEquals", p["expectedModel"]},
                                   {"ifEffortEquals", s["reasoningEffort"]}};
    settingsChange = change;
  } else if (type == "approval.respond" || type == "input.respond" ||
             type == "elicitation.respond") {
    Object request;
    auto requestId = p["requestId"].toString();
    auto answerKey = id + ':' + requestId;
    if (answeredRequests.contains(answerKey))
      throw Error("request-already-answered");
    if (onDesktop) {
      for (const auto &v : desktop->watched[id].raw["requests"].toArray())
        if (v.toObject()["id"].toVariant().toString() == requestId &&
            !v.toObject()["completed"].toBool())
          request = v.toObject();
    } else
      request = pendingRequests[requestId];
    auto rp = request["params"].toObject();
    if (request.isEmpty() || rp["threadId"] != id ||
        (rp["turnId"].isUndefined() ? QJsonValue(QJsonValue::Null)
                                    : rp["turnId"]) != p["turnId"])
      throw Error("stale-request");
    if (type == "elicitation.respond" && !p["turnId"].isNull() &&
        thread["activeTurnId"] != p["turnId"])
      throw Error("stale-turn");
    bool respondable = false;
    for (auto v : thread["requests"].toArray())
      if (v.toObject()["id"] == requestId &&
          v.toObject()["respondable"].toBool())
        respondable = true;
    if (!respondable)
      throw Error("unsupported-request-kind");
    if (type == "input.respond" && thread["activeTurnId"] != p["turnId"] &&
        rp["isBlocking"] != false)
      throw Error("stale-turn");
    Object response;
    if (type == "elicitation.respond") {
      if (request["method"] != "mcpServer/elicitation/request")
        throw Error("unsupported-request-kind");
      response =
          approvalResponse(rp, p["decision"].toString(), p["scope"].toString());
      method = "thread-follower-submit-mcp-server-elicitation-response";
    } else if (type == "approval.respond") {
      if (!QStringList{"item/commandExecution/requestApproval",
                       "item/fileChange/requestApproval"}
               .contains(request["method"].toString()))
        throw Error("unsupported-request-kind");
      auto decision = p["decision"].toString();
      if (!QStringList{"accept", "decline", "cancel"}.contains(decision) ||
          (rp["availableDecisions"].isArray() &&
           !rp["availableDecisions"].toArray().contains(decision)))
        throw Error("decision-not-available");
      response = {{"decision", decision}};
      method = request["method"] == "item/commandExecution/requestApproval"
                   ? "thread-follower-command-approval-decision"
                   : "thread-follower-file-approval-decision";
    } else {
      if (request["method"] != "item/tool/requestUserInput")
        throw Error("unsupported-request-kind");
      auto questions = rp["questions"].toArray();
      auto answers = p["answers"].toObject();
      if (questions.size() != answers.size())
        throw Error("invalid-answer-set");
      for (const auto &v : questions)
        if (!answers.contains(v.toObject()["id"].toString()))
          throw Error("invalid-answer-set");
      response = {{"answers", answers}};
      method = "thread-follower-submit-user-input";
    }
    if (!onDesktop) {
      checkCommand(command, generation);
      answeredRequests.insert(answerKey);
      rpc->respond(request["id"], response);
      pendingRequests.remove(requestId);
      dirtyThreads.insert(id);
      return {{"acknowledgedByAppServer", true}};
    }
    params = {{"conversationId", id}, {"requestId", request["id"]}};
    if (type == "approval.respond")
      params["decision"] = p["decision"];
    else
      params["response"] = response;
  } else
    throw Error("unsupported-command");
  checkCommand(command, generation);
  const bool answering = type == "approval.respond" ||
                         type == "input.respond" ||
                         type == "elicitation.respond";
  // Consume a response before the write: an unknown outcome must never submit
  // it twice.
  const auto answerKey = id + ':' + p["requestId"].toString();
  if (answering)
    answeredRequests.insert(answerKey);
  auto response = onDesktop ? desktop->call(method, params, owner)
                            : rpc->call(method, params);
  if (onDesktop) {
    if (response["handledByClientId"] != owner)
      throw Error("desktop-owner-mismatch", true);
    response = response["result"].toObject();
  }
  Object result{
      {onDesktop ? "acknowledgedByDesktop" : "acknowledgedByAppServer", true}};
  if (type == "turn.start") {
    auto turn = (onDesktop ? response["result"].toObject() : response)["turn"]
                    .toObject();
    auto tid = turn["id"].toString();
    if (tid.isEmpty())
      throw Error("incompatible-runtime-response", true);
    result["turnId"] = tid;
    newThreads.remove(id);
    if (!onDesktop && !completedTurns.remove(tid))
      busyTurns.insert(tid);
  } else if (type == "turn.steer") {
    auto tid = (onDesktop ? response["result"].toObject() : response)["turnId"]
                   .toString();
    if (tid != turnId)
      throw Error("incompatible-runtime-response", true);
    result["turnId"] = tid;
  } else if (type == "turn.interrupt") {
    if (onDesktop &&
        (response["ok"] != true || response["interruptedTurnId"] != turnId))
      throw Error("stale-turn");
    result["interruptedTurnId"] = turnId;
  } else if (type.startsWith("thread.")) {
    if (onDesktop && response["applied"] != true)
      throw Error(response["applied"] == false
                      ? "stale-settings"
                      : "incompatible-desktop-response",
                  response["applied"] != false);
    if (!onDesktop) {
      if (type == "thread.permissions.update") {
        auto confirmed = response["threadSettings"].toObject();
        if (permissionSettings(confirmed)["mode"] == p["mode"])
          effectiveSettings[id] = merged(effectiveSettings[id], confirmed);
        if (!waitFor(
                [&] {
                  return permissionSettings(effectiveSettings[id])["mode"] ==
                         p["mode"];
                },
                3000))
          throw Error("permissions-update-unconfirmed", true);
        expected["permissions"] = permissionSettings(effectiveSettings[id]);
      } else {
        effectiveSettings[id] = merged(effectiveSettings[id], settingsChange);
      }
    } else if (type == "thread.permissions.update") {
      if (!waitFor(
              [&] {
                return desktop->watched[id].compatible &&
                       permissionSettings(desktop->watched[id]
                                              .raw["latestThreadSettings"]
                                              .toObject())["mode"] == p["mode"];
              },
              3000))
        throw Error("permissions-update-unconfirmed", true);
      expected["permissions"] = permissionSettings(
          desktop->watched[id].raw["latestThreadSettings"].toObject());
    }
    result = merged(result, expected);
  } else if (onDesktop && response["ok"] != true)
    throw Error("incompatible-desktop-response", true);
  dirtyThreads.insert(id);
  return result;
}
Object Service::manage(const Object &command) {
  const auto generation = remoteGeneration;
  ensureRpc();
  checkCommand(command, generation);
  auto p = command["payload"].toObject();
  auto type = p["type"].toString(), id = p["threadId"].toString();
  if (type == "thread.create") {
    auto project = findProject(catalog, p["projectId"].toString());
    auto roots = project["roots"].toArray();
    if (roots.isEmpty())
      throw Error("project-root-unavailable");
    // Refuse before thread/start if every preview slot is protected. Never
    // create an unreported thread that a user might accidentally create again.
    ensureThreadSlot();
    auto response =
        rpc->call("thread/start", {{"projectId", p["projectId"]},
                                   {"cwd", roots[0]},
                                   {"runtimeWorkspaceRoots", roots},
                                   {"sandbox", "workspace-write"},
                                   {"approvalPolicy", "on-request"}});
    auto source = response["thread"].toObject();
    id = source["id"].toString();
    if (id.isEmpty())
      throw Error("incompatible-app-server-response", true);
    newThreads.insert(id);
    owned.insert(id);
    acquired[id] = now();
    effectiveSettings[id] = {
        {"model", response["model"]},
        {"effort", response["reasoningEffort"].isUndefined()
                       ? QJsonValue(QJsonValue::Null)
                       : response["reasoningEffort"]},
        {"approvalPolicy", response["approvalPolicy"]},
        {"approvalsReviewer", response["approvalsReviewer"]},
        {"sandboxPolicy", response["sandbox"]},
        {"runtimeWorkspaceRoots", roots}};
    source["title"] = "未命名会话";
    source["projectId"] = p["projectId"];
    source["threadRuntimeStatus"] = Object{{"type", "idle"}};
    source["latestThreadSettings"] = effectiveSettings[id];
    source["turns"] = Array{};
    source["updatedAt"] = double(now());
    rawThreads[id] = source;
    updateThread(id);
    auto list = catalog["threads"].toArray();
    list.prepend(Object{{"id", id},
                        {"title", "未命名会话"},
                        {"cwd", roots[0]},
                        {"projectId", p["projectId"]},
                        {"updatedAt", double(now())},
                        {"archived", false},
                        {"settings", normalizeSettings(source)}});
    catalog["threads"] = list;
    catalog["generatedAt"] = double(now());
    send({{"type", "device.catalog"}, {"catalog", catalog}});
    return {{"threadId", id}, {"acknowledgedByAppServer", true}};
  }
  if (findThread(catalog, id).isEmpty())
    throw Error("thread-not-in-catalog");
  if (type == "thread.rename" && (p["name"].toString().trimmed().isEmpty() ||
                                  p["name"].toString().size() > 1000))
    throw Error("invalid-thread-name");
  Object params{{"threadId", id}};
  if (type == "thread.rename")
    params["name"] = p["name"];
  rpc->call(type == "thread.rename"    ? "thread/name/set"
            : type == "thread.archive" ? "thread/archive"
                                       : "thread/delete",
            params);
  if (type == "thread.rename") {
    auto list = catalog["threads"].toArray();
    for (int i = 0; i < list.size(); ++i) {
      auto entry = list[i].toObject();
      if (entry["id"] == id) {
        entry["title"] = p["name"];
        entry["updatedAt"] = double(now());
        list[i] = entry;
      }
    }
    catalog["threads"] = list;
    dirtyThreads.insert(id);
  } else {
    newThreads.remove(id);
    desktopThreads.remove(id);
    gapUsage(id);
    desktop->unfollow(id);
    rawThreads.remove(id);
    owned.remove(id);
    acquired.remove(id);
    fileSources.remove(id);
    previewOrigins.remove(id);
    for (const auto &key : imageSources.keys())
      if (imageSources[key].first == id)
        imageSources.remove(key);
    refreshRequested = true;
    commit({{"type", "thread.removed"}, {"threadId", id}});
  }
  refreshCatalog();
  return {{"threadId", id}, {"acknowledgedByAppServer", true}};
}
Array Service::queued(const QString &id) {
  Array result;
  if (!journal.isOpen())
    return result;
  auto q = sql(journal,
               "SELECT id,text,images,attachments,created_at,status FROM "
               "queued_messages WHERE thread_id=? ORDER BY created_at,id",
               {id});
  while (q.next())
    result.append(Object{{"id", q.value(0).toString()},
                         {"threadId", id},
                         {"text", q.value(1).toString()},
                         {"images", parse(q.value(2).toByteArray())},
                         {"attachments", parse(q.value(3).toByteArray())},
                         {"createdAt", double(q.value(4).toLongLong())},
                         {"status", q.value(5).toString()}});
  return result;
}
void Service::queueStatus(const QString &id, const QString &status) {
  sql(journal, "UPDATE queued_messages SET status=? WHERE id=?", {status, id});
}
void Service::removeQueued(const QString &id) {
  sql(journal, "DELETE FROM queued_messages WHERE id=?", {id});
}
Object Service::queue(const Object &command) {
  const auto generation = remoteGeneration;
  auto p = command["payload"].toObject();
  auto id = p["threadId"].toString(), type = p["type"].toString();
  auto thread = snapshot["threads"].toObject()[id].toObject();
  if (!thread["ownerAvailable"].toBool())
    throw Error("thread-owner-unavailable");
  auto list = queued(id);
  auto queueId = p["queueId"].toString();
  if (type == "turn.queue") {
    if (thread["status"] != "active")
      throw Error("thread-not-active");
    if (list.size() >= 20)
      throw Error("queue-full");
    inputs(id, p["images"].toArray(), p["attachments"].toArray());
    checkCommand(command, generation);
    queueId = command["commandId"].toString();
    sql(journal,
        "INSERT INTO "
        "queued_messages(id,thread_id,text,images,attachments,created_at,"
        "status) VALUES(?,?,?,?,?,?,'queued')",
        {queueId, id, p["text"].toString(), json(p["images"].toArray()),
         json(p["attachments"].toArray()), now()});
  } else {
    Object saved;
    for (const auto &v : list)
      if (v.toObject()["id"] == queueId)
        saved = v.toObject();
    if (saved.isEmpty() || saved["status"] == "sending")
      throw Error("queue-item-unavailable");
    if (type == "turn.queue.read")
      return {{"queueId", queueId},
              {"text", saved["text"]},
              {"images", saved["images"]},
              {"attachments", saved["attachments"]}};
    if (type == "turn.queue.remove")
      removeQueued(queueId);
    else if (type == "turn.queue.update") {
      if (p["expectedText"] != saved["text"])
        throw Error("queue-item-changed");
      if (p["text"].toString().trimmed().isEmpty() &&
          saved["images"].toArray().isEmpty() &&
          saved["attachments"].toArray().isEmpty())
        throw Error("empty-input");
      sql(journal, "UPDATE queued_messages SET text=? WHERE id=?",
          {p["text"].toString(), queueId});
    } else if (type == "turn.queue.steer") {
      if (saved["status"] != "queued" || thread["activeTurnId"] != p["turnId"])
        throw Error("stale-turn");
      auto steer = command;
      auto payload = Object{
          {"type", "turn.steer"},      {"threadId", id},
          {"turnId", p["turnId"]},     {"text", saved["text"]},
          {"images", saved["images"]}, {"attachments", saved["attachments"]}};
      steer["payload"] = payload;
      queueStatus(queueId, "sending");
      try {
        execute(steer);
        removeQueued(queueId);
      } catch (const Error &e) {
        if (!e.uncertain)
          queueStatus(queueId, "failed");
        updateThread(id);
        throw;
      }
    }
  }
  updateThread(id);
  return {{"queueId", queueId}};
}
void Service::drainQueues() {
  for (const auto &v : snapshot["threads"].toObject()) {
    auto t = v.toObject();
    auto id = t["id"].toString();
    if (t["status"] != "idle" || !t["ownerAvailable"].toBool() ||
        awaitingQueue.contains(id))
      continue;
    for (const auto &qv : queued(id)) {
      auto q = qv.toObject();
      if (q["status"] != "queued")
        continue;
      auto qid = q["id"].toString();
      queueStatus(qid, "sending");
      awaitingQueue.insert(id);
      updateThread(id);
      Object command{{"commandId", qid},
                     {"deviceId", credentials["deviceId"]},
                     {"expectedEpoch", snapshot["epoch"]},
                     {"expiresAt", double(now() + 60000)},
                     {"payload", Object{{"type", "turn.start"},
                                        {"threadId", id},
                                        {"text", q["text"]},
                                        {"images", q["images"]},
                                        {"attachments", q["attachments"]}}}};
      try {
        execute(command);
        removeQueued(qid);
      } catch (const Error &e) {
        awaitingQueue.remove(id);
        if (!e.uncertain)
          queueStatus(qid, "failed");
        log("queued-turn-unconfirmed");
      }
      updateThread(id);
      break;
    }
  }
}
} // namespace Native
