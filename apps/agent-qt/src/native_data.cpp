#include "native.h"
#include <algorithm>
#include <cmath>
namespace Native {
static QString text(const QJsonValue &v, int limit) {
  return v.toString().left(limit).replace(QChar(0), QChar(0xfffd));
}
static QJsonValue nullable(const QJsonValue &v) {
  return v.isUndefined() ? QJsonValue(QJsonValue::Null) : v;
}
static QString stringId(const QJsonValue &v) {
  return v.toVariant().toString().left(160);
}
static bool user(const Object &item) {
  return item["type"] == "userMessage" || item["type"] == "steeringUserMessage";
}
Object permissionSettings(const Object &s) {
  auto sandbox = s["sandboxPolicy"].toObject()["type"].toString();
  if (sandbox.isEmpty() || s["approvalPolicy"].isNull() ||
      !s.contains("approvalPolicy") || !s["approvalsReviewer"].isString())
    return {};
  auto reviewer = s["approvalsReviewer"].toString(),
       approval = s["approvalPolicy"].toString("custom");
  QString mode = "custom";
  if (sandbox == "dangerFullAccess" && approval == "never" &&
      reviewer == "user")
    mode = "full-access";
  if (sandbox == "workspaceWrite" && approval == "on-request") {
    if (reviewer == "user")
      mode = "ask";
    if (reviewer == "guardian_subagent" || reviewer == "auto_review")
      mode = "auto-review";
  }
  if (sandbox == "readOnly" && approval == "on-request" && reviewer == "user")
    mode = "read-only";
  Object source{{"sandbox", s["sandboxPolicy"]},
                {"approval", s["approvalPolicy"]},
                {"reviewer", reviewer},
                {"profile", nullable(s["activePermissionProfile"])},
                {"roots", nullable(s["runtimeWorkspaceRoots"])}};
  return {{"mode", mode},
          {"sandbox", sandbox},
          {"approval", approval},
          {"reviewer", reviewer},
          {"fingerprint", hash(json(source))}};
}
Object permissionPreset(const QString &mode, const Array &roots) {
  const bool full = mode == "full-access", ro = mode == "read-only";
  Object policy = full ? Object{{"type", "dangerFullAccess"}}
                  : ro ? Object{{"type", "readOnly"}, {"networkAccess", false}}
                       : Object{{"type", "workspaceWrite"},
                                {"writableRoots", roots},
                                {"networkAccess", false},
                                {"excludeSlashTmp", false},
                                {"excludeTmpdirEnvVar", false}};
  return {{"approvalPolicy", full ? "never" : "on-request"},
          {"approvalsReviewer",
           mode == "auto-review" ? "guardian_subagent" : "user"},
          {"activePermissionProfile", Object{{"id", full ? ":danger-full-access"
                                                    : ro ? ":read-only"
                                                         : ":workspace"},
                                             {"extends", QJsonValue::Null}}},
          {"sandboxPolicy", policy},
          {"runtimeWorkspaceRoots", roots}};
}
Object normalizeSettings(const Object &raw) {
  auto s = raw["latestThreadSettings"].toObject(),
       collaboration = s.value("collaborationMode").toObject();
  if (collaboration.isEmpty())
    collaboration = raw["latestCollaborationMode"].toObject();
  auto mode = collaboration["settings"].toObject();
  auto pick = [](std::initializer_list<QJsonValue> values) {
    for (const auto &v : values)
      if (!v.isNull() && !v.isUndefined())
        return v;
    return QJsonValue(QJsonValue::Null);
  };
  Object result{
      {"model",
       pick({s["model"], raw["latestModel"], raw["model"], mode["model"]})},
      {"modelProvider", pick({s["modelProvider"], raw["modelProvider"]})},
      {"reasoningEffort",
       pick({s["effort"], raw["latestReasoningEffort"], raw["reasoningEffort"],
             mode["reasoning_effort"]})},
      {"collaborationMode",
       collaboration["mode"] == "plan" || collaboration["mode"] == "default"
           ? collaboration["mode"]
           : QJsonValue(QJsonValue::Null)}};
  auto permissions = permissionSettings(s);
  if (!permissions.isEmpty())
    result["permissions"] = permissions;
  return result;
}
Object approval(const Object &params) {
  auto schema = params["requestedSchema"].toObject(),
       meta = params["_meta"].toObject();
  if (params["mode"] != "form" || schema["type"] != "object" ||
      !schema.contains("properties") ||
      !schema["properties"].toObject().isEmpty() ||
      !schema["required"].toArray().isEmpty() ||
      meta["approveDisabled"].toBool() || meta["executionBound"].toBool())
    return {};
  for (auto it = meta.begin(); it != meta.end(); ++it)
    if (it.key().startsWith("openai/"))
      return {};
  Array scopes{"once"},
      persist = meta["persist"].isArray()    ? meta["persist"].toArray()
                : meta["persist"].isString() ? Array{meta["persist"]}
                                             : Array{};
  for (const auto &v : persist) {
    if (v != "session" && v != "always")
      return {};
    if (!scopes.contains(v))
      scopes.append(v);
  }
  const auto tool = meta["tool_params"].toObject();
  auto connector = meta["connector_id"].toString().toLower().replace(
      QRegularExpression("[^a-z0-9]+"), "-");
  auto server = params["serverName"].toString();
  QString message = meta["subtitle"].isString() ? meta["subtitle"].toString()
                                                : params["message"].toString();
  if (message.size() > 8192)
    return {};
  Object result{{"scopes", scopes}};
  if (server == "browser" || server == "browser-use" ||
      connector == "browser" || connector == "browser-use") {
    if (!meta["codex_approval_kind"].isNull() &&
        meta.contains("codex_approval_kind") &&
        meta["codex_approval_kind"] != "mcp_tool_call")
      return {};
    QUrl target(meta["origin"].toString(
        tool["origin"].toString(tool["url"].toString())));
    if (!target.isValid() ||
        !QStringList{"http", "https"}.contains(target.scheme()) ||
        !target.userInfo().isEmpty() || target.host().isEmpty() ||
        target.toString().size() > 2048)
      return {};
    target.setPath(QString{});
    target.setQuery(QString{});
    target.setFragment(QString{});
    result["kind"] = "browser";
    result["target"] = target.toString(QUrl::RemovePath | QUrl::RemoveQuery |
                                       QUrl::RemoveFragment);
  } else {
    if (meta["codex_approval_kind"] != "mcp_tool_call" ||
        !(connector == "computer-use" ||
          connector.startsWith("computer-use-")) ||
        persist.isEmpty() || tool["app"].toString().trimmed().isEmpty() ||
        tool["app"].toString().size() > 1000)
      return {};
    auto target = tool["app"].toString();
    for (const auto &v : meta["tool_params_display"].toArray()) {
      auto o = v.toObject();
      if (o["name"] == "app" && o["value"].isString()) {
        if (o["value"].toString().size() > 1000)
          return {};
        if (!o["value"].toString().trimmed().isEmpty())
          target = o["value"].toString();
      }
    }
    result["kind"] = "computer";
    result["target"] = target;
    if (meta["riskLevel"] == "high")
      result["elevatedRisk"] = true;
  }
  if (!message.isEmpty())
    result["message"] = message;
  return result;
}
Object approvalResponse(const Object &params, const QString &decision,
                        const QString &scope) {
  auto card = approval(params);
  if (card.isEmpty() || !card["scopes"].toArray().contains(scope) ||
      (decision != "accept" && scope != "once"))
    throw Error("approval-scope-not-available");
  return {{"action", decision},
          {"content", decision == "accept" ? QJsonValue(Object{})
                                           : QJsonValue(QJsonValue::Null)},
          {"_meta", decision == "accept" && scope != "once"
                        ? QJsonValue(Object{{"persist", scope}})
                        : QJsonValue(QJsonValue::Null)}};
}
QString asyncAnswer(const Object &request, const Object &answers) {
  auto details = request["details"].toObject();
  auto questions = details["questions"].toArray();
  if (questions.isEmpty() || answers.isEmpty())
    throw Error("invalid-answer-set");
  QSet<QString> known;
  Array replies;
  for (const auto &value : questions) {
    auto q = value.toObject();
    auto id = q["id"].toString();
    known.insert(id);
    if (!answers.contains(id))
      continue;
    auto a = answers[id].toObject()["answers"].toArray();
    if (a.size() != 1 || a[0].toString().trimmed().isEmpty() ||
        a[0].toString().size() > 8192)
      throw Error("invalid-answer-set");
    replies.append(Object{
        {"questionItemId",
         QString::fromUtf8(json(Array{"request_user_input_async",
                                      details["sourceItemId"], id.toInt()}))},
        {"question", q["question"]},
        {"answer", a[0]}});
  }
  for (auto it = answers.begin(); it != answers.end(); ++it)
    if (!known.contains(it.key()))
      throw Error("invalid-answer-set");
  auto result = "<send_user_message_question_reply>\n" +
                QString::fromUtf8(json(replies)) +
                "\n</send_user_message_question_reply>";
  if (result.size() > 32000)
    throw Error("invalid-answer-set");
  return result;
}
static Array rawTurns(const Object &raw) {
  auto container = raw["turnHistory"].toObject();
  if (container["kind"] != "canonical")
    return raw["turns"].toArray();
  auto history = container["history"].toObject(),
       entities = history["entitiesByKey"].toObject();
  Array result;
  for (const auto &island : history["islands"].toArray())
    for (const auto &entry : island.toObject()["entries"].toArray())
      result.append(entities[entry.toObject()["value"].toVariant().toString()]);
  return result;
}
static void timing(Object &output, const Object &raw, bool turn = false) {
  for (const auto &key : {"startedAtMs", "completedAtMs", "durationMs"})
    if (raw[key].isDouble() && raw[key].toDouble() >= 0)
      output[key] = raw[key];
  if (turn) {
    if (raw["turnStartedAtMs"].isDouble())
      output["startedAtMs"] = raw["turnStartedAtMs"];
    if (!output.contains("startedAtMs") && raw["startedAt"].isDouble())
      output["startedAtMs"] = raw["startedAt"].toDouble() * 1000;
    if (!output.contains("completedAtMs") && raw["completedAt"].isDouble())
      output["completedAtMs"] = raw["completedAt"].toDouble() * 1000;
    if (!output.contains("completedAtMs") && raw["status"] != "inProgress" &&
        output.contains("startedAtMs") && output.contains("durationMs"))
      output["completedAtMs"] =
          output["startedAtMs"].toDouble() + output["durationMs"].toDouble();
  }
}
static Array fileEntries(const Object &item) {
  if (item["changes"].isArray())
    return item["changes"].toArray();
  Array entries;
  auto changes = item["changes"].toObject();
  for (auto it = changes.begin(); it != changes.end(); ++it) {
    auto entry = it.value().toObject();
    entry["path"] = it.key();
    entries.append(entry);
  }
  return entries;
}
static Array subAgents(const Object &item, const QString &parent) {
  Array result;
  if (item["type"] == "subAgentActivity") {
    const auto id = item["agentThreadId"].toString();
    if (id.isEmpty() || id == parent || id.size() > 160)
      return result;
    const auto kind = item["kind"].toString();
    Object agent{{"threadId", id},
                 {"parentThreadId", parent},
                 {"status", kind == "started"       ? "running"
                            : kind == "completed"   ? "completed"
                            : kind == "interrupted" ? "interrupted"
                                                    : "unknown"},
                 {"statusSource", "activity"}};
    if (item["agentPath"].isString())
      agent["path"] = text(item["agentPath"], 1000);
    return {agent};
  }
  if (item["type"] != "collabAgentToolCall")
    return result;
  auto states = item["agentsStates"].toObject();
  if (states.isEmpty())
    states = item["agentStates"].toObject();
  QSet<QString> ids;
  for (const auto &v : item["receiverThreadIds"].toArray())
    ids.insert(v.toString());
  for (auto it = states.begin(); it != states.end(); ++it)
    ids.insert(it.key());
  if (item["newThreadId"].isString())
    ids.insert(item["newThreadId"].toString());
  for (const auto &id : ids) {
    if (id.isEmpty() || id == parent || id.size() > 160 || result.size() >= 32)
      continue;
    auto state = states[id];
    const auto source = state.toObject();
    QString status =
        state.isString() ? state.toString() : source["status"].toString();
    if (status.isEmpty() && !source.isEmpty())
      status = source.keys().first();
    if (!QStringList{"pendingInit", "running", "idle", "interrupted",
                     "completed", "errored", "shutdown", "notFound"}
             .contains(status))
      status = "unknown";
    Object agent{{"threadId", id},
                 {"parentThreadId", parent},
                 {"status", status},
                 {"statusSource", "reported"}};
    auto message = source["message"].toString(source[status].toString());
    if (!message.isEmpty())
      agent["message"] = message.left(2000);
    if (item["prompt"].isString())
      agent["task"] = text(item["prompt"], 2000);
    if (item["model"].isString())
      agent["model"] = text(item["model"], 200);
    for (auto receiver : item["receiverThreads"].toArray()) {
      auto thread = receiver.toObject()["thread"].toObject();
      if (thread["id"] != id)
        continue;
      for (const auto &pair : QList<QPair<QString, QString>>{
               {"name", "agentNickname"}, {"role", "agentRole"}})
        if (thread[pair.second].isString())
          agent[pair.first] = text(thread[pair.second], 256);
      auto runtime = thread["status"].toObject()["type"].toString();
      if (runtime == "active" || runtime == "idle" ||
          runtime == "systemError") {
        agent["status"] =
            runtime == "active" ? "running"
            : runtime == "systemError"
                ? "errored"
                : (QStringList{"running", "pendingInit", "unknown", "idle"}
                           .contains(status)
                       ? "idle"
                       : status);
        agent["statusSource"] = "thread";
        if (agent["status"] == "running")
          agent.remove("message");
      }
    }
    result.append(agent);
  }
  return result;
}
static Object normalizeItem(
    const Object &item, const Object &turn, bool history,
    const QString &threadId,
    const std::function<Array(const QString &, const Object &)> &images) {
  auto type = item["type"].toString("unknown");
  Object out{
      {"id", stringId(item["id"]).isEmpty() ? "unknown" : stringId(item["id"])},
      {"type", type.left(100)},
      {"truncated", false}};
  for (const auto &key : {"status", "phase"})
    if (item[key].isString() &&
        (QString(key) != "phase" || item[key] == "commentary" ||
         item[key] == "final_answer"))
      out[key] = text(item[key], 80);
  QString body = item["text"].toString();
  auto parts = item.contains("content") ? item["content"].toArray()
                                        : item["input"].toArray();
  if (body.isEmpty()) {
    QStringList values;
    for (const auto &part : parts)
      if (part.toObject()["text"].isString())
        values << part.toObject()["text"].toString();
    body = values.join('\n');
  }
  if (type == "reasoning") {
    QStringList values;
    for (const auto &s : item["summary"].toArray())
      if (s.isString())
        values << s.toString();
    body = values.join("\n\n");
  }
  QStringList presentedFiles;
  if (user(item)) {
    auto wrapper =
        QRegularExpression("^\\s*(?:#{1,3}\\s*)?Files mentioned by the "
                           "user:\\s*([\\s\\S]*?)\\n\\s*(?:#{1,3}\\s*)?My "
                           "request:\\s*([\\s\\S]*)$",
                           QRegularExpression::CaseInsensitiveOption)
            .match(body);
    if (wrapper.hasMatch()) {
      auto names =
          QRegularExpression(
              "^\\s*(?:#{1,4}\\s*)?([^:\\r\\n\\\\/]+\\.[a-z0-9]{1,12}):",
              QRegularExpression::MultilineOption |
                  QRegularExpression::CaseInsensitiveOption)
              .globalMatch(wrapper.captured(1));
      while (names.hasNext() && presentedFiles.size() < 40)
        presentedFiles << names.next().captured(1).trimmed();
      if (!presentedFiles.isEmpty())
        body = wrapper.captured(2).trimmed();
    }
    auto context =
        QRegularExpression(
            "^\\s*<in-app-browser-context\\s+source=[\"']ambient-ui-state[\"']>"
            "\\s*[\\s\\S]*?</in-app-browser-context>\\s*(?:(?:#{1,3}\\s*)?My "
            "request:\\s*)?",
            QRegularExpression::CaseInsensitiveOption)
            .match(body);
    if (context.hasMatch())
      body = body.mid(context.capturedLength()).trimmed();
    auto matches =
        QRegularExpression("<send_user_message_question_reply>([\\s\\S]*?)</"
                           "send_user_message_question_reply>")
            .globalMatch(body);
    Array presentations;
    QString rendered;
    int offset = 0;
    bool found = false;
    while (matches.hasNext()) {
      auto match = matches.next();
      Array replies;
      try {
        auto value = parse(match.captured(1).toUtf8());
        replies = value.isArray() ? value.toArray() : Array{value};
      } catch (...) {
        continue;
      }
      bool valid = !replies.isEmpty() && replies.size() <= 20 &&
                   match.capturedLength() <= 32000;
      for (auto v : replies) {
        auto o = v.toObject();
        valid &= o["questionItemId"].isString() &&
                 !o["questionItemId"].toString().isEmpty() &&
                 o["questionItemId"].toString().size() <= 400 &&
                 o["question"].isString() &&
                 o["question"].toString().size() <= 8192 &&
                 o["answer"].isString() &&
                 o["answer"].toString().size() <= 8192;
      }
      if (!valid)
        continue;
      found = true;
      auto prefix = body.mid(offset, match.capturedStart() - offset);
      rendered += prefix;
      if (!prefix.isEmpty())
        presentations.append(Object{{"type", "text"}, {"text", prefix}});
      QStringList labels;
      for (auto v : replies) {
        auto o = v.toObject();
        presentations.append(Object{{"type", "questionAnswer"},
                                    {"question", o["question"]},
                                    {"answer", o["answer"]}});
        labels << o["question"].toString() + '\n' + o["answer"].toString();
      }
      rendered += labels.join("\n\n");
      offset = match.capturedEnd();
    }
    if (found) {
      auto suffix = body.mid(offset);
      rendered += suffix;
      if (!suffix.isEmpty())
        presentations.append(Object{{"type", "text"}, {"text", suffix}});
      body = rendered;
      Array bounded;
      int remaining = history ? 32000 : 4096;
      for (auto v : presentations) {
        if (remaining <= 0 || bounded.size() >= 40)
          break;
        auto part = v.toObject();
        for (auto key : part["type"] == "text"
                            ? QStringList{"text"}
                            : QStringList{"question", "answer"}) {
          auto content = text(part[key], remaining);
          remaining -= content.size();
          part[key] = content;
        }
        bounded.append(part);
      }
      out["userMessageParts"] = bounded;
    }
  }
  int limit = history ? 32000 : 4096, outputLimit = history ? 32000 : 8192;
  if (!body.isEmpty())
    out["text"] = body.left(limit);
  if (item["command"].isString())
    out["command"] = text(item["command"], history ? 8192 : 4096);
  auto output = item["aggregatedOutput"].toString();
  if (!output.isEmpty())
    out["output"] = output.right(outputLimit);
  if (item["tool"].isString())
    out["tool"] = text(item["tool"], 300);
  auto time =
      turn["itemTimingsById"].toObject()[item["id"].toString()].toObject();
  timing(out, item);
  timing(out, time);
  if (out.contains("startedAtMs") && out.contains("completedAtMs") &&
      out["completedAtMs"].toDouble() >= out["startedAtMs"].toDouble())
    out["durationMs"] =
        out["completedAtMs"].toDouble() - out["startedAtMs"].toDouble();
  if (!out.contains("startedAtMs")) {
    auto key = type == "commandExecution"
                   ? "commandExecutionStartedAtMsById"
                   : "aeonAssistantMessageStartedAtMsById";
    auto v = turn[key].toObject()[item["id"].toString()];
    if (v.isDouble())
      out["startedAtMs"] = v;
  }
  Array files, operations;
  for (const auto &name : presentedFiles)
    files.append(name.left(1000));
  for (const auto &v : fileEntries(item)) {
    auto change = v.toObject();
    auto path = text(change["path"], 1000);
    if (path.isEmpty() || files.size() >= 40)
      continue;
    files.append(path);
    auto kind = change["kind"].isString()
                    ? change["kind"].toString()
                    : change["kind"].toObject()["type"].toString(
                          change["type"].toString());
    operations.append(
        Object{{"path", path},
               {"kind", QStringList{"add", "update", "delete"}.contains(kind)
                            ? kind
                            : "unknown"}});
  }
  if (!files.isEmpty())
    out["files"] = files;
  if (type == "fileChange" && !operations.isEmpty())
    out["fileOperations"] = operations;
  auto refs = images ? images(threadId, item) : Array{};
  if (!refs.isEmpty())
    out["images"] = refs;
  auto agents = subAgents(item, threadId);
  if (!agents.isEmpty())
    out["subAgents"] = agents;
  if (type == "agentMessage" && !item["questions"].toArray().isEmpty() &&
      item["id"].toString().size() <= 154)
    out["questionRequestId"] = "async:" + item["id"].toString();
  out["truncated"] =
      body.size() > limit || output.size() > outputLimit ||
      item["command"].toString().size() > (history ? 8192 : 4096);
  return out;
}
static QJsonValue turnIdentity(const Object &turn) {
  for (const auto &key : {"turnId", "id"}) {
    auto value = turn[key];
    if (value.isString() && !value.toString().isEmpty() &&
        value.toString().size() <= 160)
      return value;
  }
  return QJsonValue::Null;
}
Object normalizeTurn(
    const Object &raw, bool history, const QString &threadId,
    const std::function<Array(const QString &, const Object &)> &images) {
  Object result{{"id", turnIdentity(raw).toString("unknown")},
                {"status", text(raw["status"], 80).isEmpty()
                               ? "unknown"
                               : text(raw["status"], 80)},
                {"items", Array{}},
                {"truncated", false}};
  timing(result, raw, true);
  auto source = raw["items"].toArray();
  Array items;
  QSet<QString> seen;
  QHash<QString, Object> persisted;
  for (const auto &v : source) {
    auto item = v.toObject();
    if (item["type"] == "userMessage" && item["clientId"].isString())
      persisted[item["clientId"].toString()] = item;
  }
  for (const auto &v : source) {
    auto item = v.toObject();
    if (item["type"] == "steered")
      continue;
    if (item["type"] == "steeringUserMessage" &&
        QStringList{"pending", "accepted"}.contains(
            item["status"].toString())) {
      auto client = item["serverClientUserMessageId"].toString(
          item["clientUserMessageId"].toString());
      auto id = item["serverUserMessageId"].toString(
          persisted[client]["id"].toString());
      if (!id.isEmpty())
        item["id"] = id;
    }
    auto id = item["id"].toString();
    if (!id.isEmpty() && seen.contains(id))
      continue;
    seen.insert(id);
    items.append(item);
  }
  int limit = history ? 80 : 20;
  QSet<int> selected;
  QList<int> users;
  for (int i = 0; i < items.size(); ++i)
    if (user(items[i].toObject()))
      users.append(i);
  if (users.size() > limit)
    users = QList<int>{users[0]} + users.mid(users.size() - limit + 1);
  for (int i : users)
    selected.insert(i);
  for (int i = items.size() - 1; i >= 0 && selected.size() < limit; --i)
    selected.insert(i);
  Array normalized;
  for (int i = 0; i < items.size(); ++i)
    if (selected.contains(i))
      normalized.append(
          normalizeItem(items[i].toObject(), raw, history, threadId, images));
  result["items"] = normalized;
  if (items.size() > limit) {
    result["truncated"] = true;
    result["itemsTruncatedBefore"] = true;
  }
  Object changes;
  for (const auto &v : items) {
    auto item = v.toObject();
    if (item["type"] != "fileChange" ||
        QStringList{"inProgress", "failed", "declined"}.contains(
            item["status"].toString()))
      continue;
    for (const auto &entry : fileEntries(item)) {
      const auto c = entry.toObject();
      auto path = text(c["path"], 1000);
      if (path.isEmpty() || (!changes.contains(path) && changes.size() >= 40))
        continue;
      auto old = changes[path].toObject();
      auto diff = c["diff"].toString(c["unifiedDiff"].toString(
          c["unified_diff"].toString(c["content"].toString())));
      auto kind = c["kind"].toObject()["type"].toString(c["type"].toString());
      if (kind == "add" || kind == "delete") {
        auto lines = diff.split('\n');
        if (!lines.isEmpty() && lines.last().isEmpty())
          lines.removeLast();
        for (auto &line : lines)
          line.prepend(kind == "add" ? '+' : '-');
        diff = lines.join('\n');
      }
      int adds = 0, deletes = 0;
      bool hunk = kind == "add" || kind == "delete";
      for (const auto &line : diff.split('\n')) {
        if (line.startsWith("@@ ")) {
          hunk = true;
          continue;
        }
        if (line.startsWith("diff --git ")) {
          hunk = false;
          continue;
        }
        if (!hunk && (line.startsWith("+++ ") || line.startsWith("--- ")))
          continue;
        if (line.startsWith('+'))
          ++adds;
        if (line.startsWith('-'))
          ++deletes;
      }
      auto combined = old["diff"].toString();
      if (!combined.isEmpty() && !diff.isEmpty())
        combined += '\n';
      combined += diff;
      changes[path] = Object{
          {"path", path},
          {"additions", old["additions"].toInt() + adds},
          {"deletions", old["deletions"].toInt() + deletes},
          {"diff", combined.left(8192)},
          {"truncated", old["truncated"].toBool() || combined.size() > 8192}};
    }
  }
  if (!changes.isEmpty()) {
    Array values;
    for (const auto &value : changes)
      values.append(value);
    result["fileChanges"] = values;
  }
  if (!history) {
    Array plan = raw["plan"].isArray()
                     ? raw["plan"].toArray()
                     : raw["plan"].toObject()["plan"].toArray();
    Array steps;
    for (const auto &v : plan) {
      if (steps.size() >= 60)
        break;
      auto o = v.toObject();
      steps.append(Object{{"step", text(o["step"], 2000)},
                          {"status", text(o["status"], 80)}});
    }
    result["plan"] = steps;
    result["diff"] = text(raw["diff"], 16384);
  }
  return result;
}
Object normalizeThread(
    const Object &raw, qint64 revision,
    const std::function<Array(const QString &, const Object &)> &images) {
  auto runtime = raw["threadRuntimeStatus"].toObject();
  auto status = runtime["type"].toString("unavailable");
  if (!QStringList{"notLoaded", "idle", "active", "systemError"}.contains(
          status))
    status = "unavailable";
  auto turns = rawTurns(raw);
  Array normalized, agents, requests, flags;
  QJsonValue activeId(QJsonValue::Null);
  QSet<QString> agentIds;
  QHash<QString, Object> latestAgents;
  for (auto v : raw["codexerSubAgents"].toArray()) {
    auto a = v.toObject();
    if (!a["threadId"].toString().isEmpty())
      latestAgents[a["threadId"].toString()] = a;
  }
  for (const auto &v : turns) {
    const auto turn = v.toObject();
    if (turn["status"] == "inProgress")
      activeId = turnIdentity(turn);
    for (const auto &iv : turn["items"].toArray())
      for (const auto &a : subAgents(iv.toObject(), raw["id"].toString())) {
        auto id = a.toObject()["threadId"].toString();
        latestAgents[id] = merged(latestAgents[id], a.toObject());
        if (a.toObject()["status"] == "running")
          latestAgents[id].remove("message");
        agentIds.insert(id);
      }
  }
  for (auto v : raw["codexerAgentDetails"].toArray()) {
    auto a = v.toObject();
    const auto id = a["threadId"].toString();
    latestAgents[id] = merged(latestAgents[id], a);
    if (a["status"] == "running")
      latestAgents[id].remove("message");
  }
  for (const auto &a : latestAgents) {
    if (agents.size() >= 32)
      break;
    agents.append(a);
  }
  for (int i = qMax(0, turns.size() - 2); i < turns.size(); ++i)
    normalized.append(normalizeTurn(turns[i].toObject(), false,
                                    raw["id"].toString(), images));
  const QMap<QString, QString> kinds{
      {"item/commandExecution/requestApproval", "commandApproval"},
      {"item/fileChange/requestApproval", "fileApproval"},
      {"item/permissions/requestApproval", "permissionsApproval"},
      {"item/tool/requestUserInput", "userInput"},
      {"mcpServer/elicitation/request", "mcpElicitation"}};
  for (const auto &v : raw["requests"].toArray()) {
    auto r = v.toObject();
    if (r["completed"].toBool() || requests.size() >= 40)
      continue;
    auto p = r["params"].toObject();
    auto kind = kinds.value(r["method"].toString(), "unsupported");
    Object details;
    for (auto key :
         {"questions", "isBlocking", "autoResolutionMs", "changes",
          "permissions", "availableDecisions", "networkApprovalContext",
          "requestedSchema", "message", "mode", "kind", "cwd", "commandActions",
          "additionalPermissions", "grantRoot", "approvalId", "environmentId"})
      if (p.contains(key))
        details[key] = p[key];
    bool truncated = json(details).size() > 16384 ||
                     p["command"].toString().size() > 16384 ||
                     p["reason"].toString().size() > 8192;
    auto card = kind == "mcpElicitation" ? approval(p) : Object{};
    Object request{
        {"id", stringId(r["id"])},
        {"kind", kind},
        {"turnId",
         p["turnId"].isString() && !p["turnId"].toString().isEmpty() &&
                 p["turnId"].toString().size() <= 160
             ? p["turnId"] : QJsonValue(QJsonValue::Null)},
        {"details", truncated ? Object{} : details},
        {"detailsTruncated", truncated},
        {"respondable", !truncated && (QStringList{"commandApproval",
                                                   "fileApproval", "userInput"}
                                           .contains(kind) ||
                                       !card.isEmpty())}};
    if (p["command"].isString())
      request["command"] = text(p["command"], 16384);
    if (p["reason"].isString())
      request["reason"] = text(p["reason"], 8192);
    if (!truncated && !card.isEmpty())
      request["approval"] = card;
    requests.append(request);
  }
  for (const auto &tv : turns) {
    const auto t = tv.toObject();
    if (t["status"] != "inProgress" || turnIdentity(t).isNull())
      continue;
    auto items = t["items"].toArray();
    QSet<QString> answered;
    for (const auto &iv : items) {
      auto item = iv.toObject();
      if (!user(item))
        continue;
      auto parts = item["content"].isArray() ? item["content"].toArray()
                                             : item["input"].toArray();
      for (const auto &pv : parts) {
        auto match =
            QRegularExpression("<send_user_message_question_reply>\\s*(\\[.*?"
                               "\\])\\s*</send_user_message_question_reply>",
                               QRegularExpression::DotMatchesEverythingOption)
                .match(pv.toObject()["text"].toString());
        if (match.hasMatch())
          try {
            for (const auto &r : parse(match.captured(1).toUtf8()).toArray())
              answered.insert(r.toObject()["questionItemId"].toString());
          } catch (...) {
          }
      }
    }
    for (const auto &iv : items) {
      auto item = iv.toObject();
      auto questions = item["questions"].toArray();
      if (item["type"] != "agentMessage" || questions.isEmpty() ||
          questions.size() > 20 || json(questions).size() > 12000 ||
          requests.size() >= 40)
        continue;
      Array qs;
      int index = 0;
      for (const auto &qv : questions) {
        auto q = qv.toObject();
        auto key = QString::fromUtf8(
            json(Array{"request_user_input_async", item["id"], index}));
        if (answered.contains(key)) {
          ++index;
          continue;
        }
        Array options;
        for (const auto &label : q["options"].toArray())
          options.append(
              Object{{"label", text(label, 8192)}, {"description", ""}});
        qs.append(Object{{"id", QString::number(index++)},
                         {"header", ""},
                         {"question", text(q["title"], 8192)},
                         {"isOther", true},
                         {"isSecret", false},
                         {"options", options}});
      }
      if (qs.isEmpty())
        continue;
      requests.append(
          Object{{"id", "async:" + item["id"].toString()},
                 {"kind", "userInput"},
                 {"turnId", turnIdentity(t)},
                 {"details", Object{{"source", "asyncMessage"},
                                    {"sourceItemId", item["id"]},
                                    {"questions", qs},
                                    {"isBlocking", false}}},
                 {"detailsTruncated", false},
                 {"respondable", true}});
    }
  }
  for (const auto &v : runtime["activeFlags"].toArray()) {
    if (flags.size() >= 20)
      break;
    flags.append(v.isString() ? text(v, 100) : text(v.toObject()["type"], 100));
  }
  Object result{
      {"id", raw["id"]},
      {"title", text(raw["title"], 1000).isEmpty() ? "Untitled"
                                                   : text(raw["title"], 1000)},
      {"cwd", raw["cwd"].isString() ? QJsonValue(text(raw["cwd"], 4096))
                                    : QJsonValue(QJsonValue::Null)},
      {"status", status},
      {"activeFlags", flags},
      {"ownerAvailable", true},
      {"truncated", turns.size() > 2 || raw["requests"].toArray().size() > 40},
      {"revision", double(revision)},
      {"activeTurnId",
       status == "active" ? activeId : QJsonValue(QJsonValue::Null)},
      {"updatedAt", raw["updatedAt"].isDouble() ? raw["updatedAt"]
                                                : QJsonValue(double(now()))},
      {"settings", normalizeSettings(raw)},
      {"subAgents", agents},
      {"subAgentsTruncated",
       latestAgents.size() > 32 || raw["codexerSubAgentsTruncated"].toBool()},
      {"turns", normalized},
      {"requests", requests},
      {"tokenUsage", raw["latestTokenUsageInfo"].isObject() &&
                             json(raw["latestTokenUsageInfo"]).size() <= 4096
                         ? raw["latestTokenUsageInfo"]
                         : QJsonValue(QJsonValue::Null)}};
  while (json(result).size() > 256 * 1024) {
    auto ts = result["turns"].toArray();
    bool removed = false;
    for (int i = 0; i < ts.size(); ++i) {
      auto t = ts[i].toObject();
      auto is = t["items"].toArray();
      int index = -1;
      for (int j = 0; j < is.size(); ++j)
        if (!user(is[j].toObject())) {
          index = j;
          break;
        }
      if (index < 0 && !is.isEmpty())
        index = 0;
      if (index >= 0) {
        is.removeAt(index);
        t["items"] = is;
        t["truncated"] = true;
        t["itemsTruncatedBefore"] = true;
        ts[i] = t;
        removed = true;
        break;
      }
      if (!t["diff"].toString().isEmpty() ||
          !t["fileChanges"].toArray().isEmpty()) {
        t["diff"] = "";
        t.remove("fileChanges");
        ts[i] = t;
        removed = true;
        break;
      }
    }
    result["turns"] = ts;
    result["truncated"] = true;
    if (!removed) {
      auto rs = result["requests"].toArray();
      if (rs.isEmpty())
        break;
      rs.removeLast();
      result["requests"] = rs;
    }
  }
  return result;
}
Object normalizeCatalog(const QString &device, const Array &rawProjects,
                        const Array &rawThreads, const Array &models) {
  Array projects, threads;
  QSet<QString> ids;
  for (const auto &v : rawProjects) {
    auto p = v.toObject();
    Array roots;
    for (const auto &r : p["roots"].toArray()) {
      auto path = r.isString() ? r.toString() : r.toObject()["path"].toString();
      if (!path.isEmpty() && roots.size() < 20)
        roots.append(path.left(4096));
    }
    projects.append(
        Object{{"id", p["id"]},
               {"name", p["name"].toString("未命名项目").left(1000)},
               {"roots", roots},
               {"position", p["position"].toInt()},
               {"updatedAt", p["updatedAt"].toDouble() * 1000}});
  }
  for (const auto &v : rawThreads) {
    auto t = v.toObject();
    auto id = t["id"].toString();
    if (id.isEmpty() || ids.contains(id))
      continue;
    ids.insert(id);
    QJsonValue projectId(QJsonValue::Null);
    int longest = -1;
    for (const auto &pv : projects) {
      auto p = pv.toObject();
      if (p["id"] == t["projectId"]) {
        projectId = p["id"];
        break;
      }
      for (const auto &r : p["roots"].toArray())
        if (!t["cwd"].toString().isEmpty() &&
            within(r.toString(), t["cwd"].toString()) &&
            r.toString().size() > longest) {
          longest = r.toString().size();
          projectId = p["id"];
        }
    }
    threads.append(
        Object{{"id", id},
               {"title", t["name"].toString().isEmpty()
                             ? t["preview"].toString("未命名会话").left(1000)
                             : text(t["name"], 1000)},
               {"cwd", t["cwd"].isString() ? QJsonValue(text(t["cwd"], 4096))
                                           : QJsonValue(QJsonValue::Null)},
               {"projectId", projectId},
               {"updatedAt", t["updatedAt"].toDouble() * 1000},
               {"archived", t["archived"].toBool()},
               {"settings", normalizeSettings(t)}});
  }
  return {{"protocolVersion", 1},         {"deviceId", device},
          {"generatedAt", double(now())}, {"projects", projects},
          {"threads", threads},           {"models", models}};
}
static QJsonValue patchValue(QJsonValue current, const Array &path, int offset,
                             const QString &op, const QJsonValue &value) {
  if (offset == path.size()) {
    if (op == "remove")
      return QJsonValue(QJsonValue::Undefined);
    return value;
  }
  auto key = path[offset];
  if (key.toString() == "__proto__" || key.toString() == "prototype" ||
      key.toString() == "constructor")
    throw Error("invalid-desktop-patch");
  if (current.isArray()) {
    auto array = current.toArray();
    int i = key.isDouble() ? key.toInt(-1) : key.toString().toInt();
    if (i < 0 || i > array.size())
      throw Error("invalid-desktop-patch");
    if (offset + 1 == path.size() && op == "add")
      array.insert(i, value);
    else {
      if (i >= array.size())
        throw Error("invalid-desktop-patch");
      auto updated = patchValue(array[i], path, offset + 1, op, value);
      if (updated.isUndefined())
        array.removeAt(i);
      else
        array[i] = updated;
    }
    return array;
  }
  if (!current.isObject())
    throw Error("invalid-desktop-patch");
  auto object = current.toObject();
  auto name = key.toVariant().toString();
  if (!object.contains(name) && (offset + 1 < path.size() || op != "add"))
    throw Error("invalid-desktop-patch");
  auto updated = patchValue(object[name], path, offset + 1, op, value);
  if (updated.isUndefined())
    object.remove(name);
  else
    object[name] = updated;
  return object;
}
Object applyPatch(Object source, const Array &patches) {
  if (patches.size() > 100000)
    throw Error("invalid-desktop-patch");
  QJsonValue result(source);
  for (const auto &v : patches) {
    auto p = v.toObject();
    auto op = p["op"].toString();
    if (!QStringList{"add", "replace", "remove"}.contains(op) ||
        !p["path"].isArray())
      throw Error("invalid-desktop-patch");
    result = patchValue(result, p["path"].toArray(), 0, op, p["value"]);
  }
  if (!result.isObject())
    throw Error("invalid-desktop-patch");
  return result.toObject();
}
bool validCommand(const Object &command) {
  auto bounded = [](QJsonValue v, int min, int max) {
    return v.isString() && v.toString().size() >= min &&
           v.toString().size() <= max;
  };
  auto id = [&](QJsonValue v) { return bounded(v, 1, 160); };
  auto oneOf = [](QJsonValue v, QStringList choices) {
    return v.isString() && choices.contains(v.toString());
  };
  auto digest = [](QJsonValue v) {
    return v.isString() &&
           QRegularExpression("^[a-f0-9]{64}$").match(v.toString()).hasMatch();
  };
  for (auto key : {"commandId", "deviceId", "expectedEpoch"})
    if (!id(command[key]))
      return false;
  auto expiry = command["expiresAt"].toDouble(-1);
  if (!command["expiresAt"].isDouble() || !std::isfinite(expiry) ||
      std::floor(expiry) != expiry || std::abs(expiry) > 9007199254740991.0 ||
      !command["payload"].isObject())
    return false;
  const auto p = command["payload"].toObject();
  auto type = p["type"].toString();
  if (type == "runtime.refresh")
    return p.size() == 1;
  if (type == "project.create")
    return id(p["parentId"]) && bounded(p["name"], 1, 100) &&
           !p["name"].toString().trimmed().isEmpty() &&
           bounded(p["relativePath"], 1, 1024) &&
           oneOf(p["mode"], {"new", "existing"});
  if (type == "project.delete")
    return id(p["projectId"]) &&
           QRegularExpression(
               "^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$")
               .match(p["token"].toString())
               .hasMatch() &&
           p["deleteDirectory"].isBool();
  if (type == "project.delete.prepare" || type == "thread.create")
    return id(p["projectId"]);
  if (!id(p["threadId"]))
    return false;
  if (type == "thread.rename")
    return bounded(p["name"], 1, 1000) &&
           !p["name"].toString().trimmed().isEmpty();
  if (QStringList{"thread.watch", "thread.archive", "thread.delete"}.contains(
          type))
    return true;
  auto model = [&](QJsonValue v) { return bounded(v, 1, 200); };
  auto effort = [&](QJsonValue v) { return v.isNull() || bounded(v, 0, 80); };
  if (type == "thread.model.update")
    return model(p["model"]) &&
           !QRegularExpression("[\\s\\x00-\\x1f]")
                .match(p["model"].toString())
                .hasMatch() &&
           model(p["expectedModel"]);
  if (type == "thread.effort.update")
    return oneOf(p["effort"], {"none", "minimal", "low", "medium", "high",
                               "xhigh", "max", "ultra"}) &&
           model(p["expectedModel"]) && effort(p["expectedEffort"]);
  if (type == "thread.mode.update")
    return oneOf(p["mode"], {"default", "plan"}) &&
           (p["expectedMode"].isNull() ||
            oneOf(p["expectedMode"], {"default", "plan"})) &&
           model(p["expectedModel"]) && effort(p["expectedEffort"]);
  if (type == "thread.permissions.update")
    return oneOf(p["mode"],
                 {"read-only", "ask", "auto-review", "full-access"}) &&
           digest(p["expectedPermissions"]);
  if (type.startsWith("turn.queue.")) {
    if (!id(p["queueId"]))
      return false;
    if (type == "turn.queue.steer")
      return id(p["turnId"]);
    if (type == "turn.queue.read" || type == "turn.queue.remove")
      return true;
    if (type == "turn.queue.update")
      return bounded(p["text"], 0, 32000) &&
             bounded(p["expectedText"], 0, 32000);
    return false;
  }
  if (type == "turn.start" || type == "turn.steer" || type == "turn.queue") {
    if (!bounded(p["text"], 0, 32000) ||
        (type == "turn.steer" && !id(p["turnId"])))
      return false;
    for (auto key : {"images", "attachments"}) {
      if (p.contains(key) && (!p[key].isArray() || p[key].toArray().size() > 4))
        return false;
      for (auto v : p[key].toArray())
        if (!digest(v))
          return false;
    }
    return !p["text"].toString().trimmed().isEmpty() ||
           !p["images"].toArray().isEmpty() ||
           !p["attachments"].toArray().isEmpty();
  }
  if (type == "turn.interrupt")
    return id(p["turnId"]);
  if (!id(p["requestId"]))
    return false;
  if (type == "elicitation.respond")
    return (p["turnId"].isNull() || id(p["turnId"])) &&
           oneOf(p["decision"], {"accept", "decline", "cancel"}) &&
           oneOf(p["scope"], {"once", "session", "always"});
  if (!id(p["turnId"]))
    return false;
  if (type == "approval.respond")
    return oneOf(p["decision"], {"accept", "decline", "cancel"});
  if (type != "input.respond" || !p["answers"].isObject() ||
      p["answers"].toObject().size() > 20)
    return false;
  auto answers = p["answers"].toObject();
  for (auto it = answers.begin(); it != answers.end(); ++it) {
    auto a = it.value().toObject()["answers"];
    if (it.key().size() > 200 || !a.isArray() || a.toArray().size() > 20)
      return false;
    for (auto v : a.toArray())
      if (!bounded(v, 0, 8192))
        return false;
  }
  return true;
}
} // namespace Native
