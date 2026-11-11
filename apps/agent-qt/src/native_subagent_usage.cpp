#include "native.h"
#include <cmath>

namespace Native {
namespace {
const QStringList fields{"totalTokens", "inputTokens", "cachedInputTokens",
                         "outputTokens", "cacheWriteInputTokens",
                         "reasoningOutputTokens"};
const QStringList rawFields{"total_tokens", "input_tokens", "cached_input_tokens",
                            "output_tokens", "cache_write_input_tokens",
                            "reasoning_output_tokens"};
bool counter(const QJsonValue &v) {
  const auto n = v.toDouble(-1);
  return v.isDouble() && std::isfinite(n) && n >= 0 &&
         n <= 9007199254740991.0 && std::floor(n) == n;
}
Object counts(const Object &raw) {
  Object result;
  for (int i = 0; i < fields.size(); ++i) {
    auto v = raw[rawFields[i]];
    if (i >= 4 && v.isUndefined()) v = 0;
    if (!counter(v)) return {};
    result[fields[i]] = v;
  }
  if (result["cachedInputTokens"].toDouble() > result["inputTokens"].toDouble() ||
      result["reasoningOutputTokens"].toDouble() > result["outputTokens"].toDouble())
    return {};
  return result;
}
Object unknownUsage(double total) {
  if (total < 0) return {};
  return {{"totalTokens", total}, {"recordedTokens", 0}, {"totalKnown", true},
          {"partial", total > 0}, {"models", Array{}}};
}
} // namespace

Object SubAgentUsageReader::readUsage(const QString &home, const QString &id,
                                     const QString &parent, const QString &path,
                                     double indexedTotal, qint64 &budget) {
  QFileInfo info(path);
  const auto canonical = info.canonicalFilePath();
  bool allowed = false;
  for (const auto &dir : {"sessions", "archived_sessions"}) {
    const auto root = QFileInfo(QDir(home).filePath(dir)).canonicalFilePath();
    allowed |= !root.isEmpty() && within(root, canonical);
  }
  if (!allowed || !info.isFile() || !path.endsWith(".jsonl")) {
    entries.remove(id);
    return unknownUsage(indexedTotal);
  }
  auto &entry = entries[id];
  const auto identity = fileIdentity(canonical);
  const auto modified = info.lastModified().toMSecsSinceEpoch();
  if (entry.path != canonical || entry.parent != parent ||
      entry.identity != identity || info.size() < entry.size ||
      (info.size() == entry.size && modified != entry.modified)) {
    entry = {};
    entry.path = canonical;
    entry.identity = identity;
    entry.parent = parent;
  }
  entry.size = info.size();
  entry.modified = modified;
  QFile file(canonical);
  if (!file.open(QIODevice::ReadOnly) || !file.seek(entry.offset))
    return unknownUsage(indexedTotal);
  qint64 allowance = qMin<qint64>(budget, 512 * 1024);
  while (!file.atEnd() && allowance > 0) {
    const auto start = file.pos();
    const auto line = file.readLine(qMin<qint64>(64 * 1024, allowance) + 1);
    if (line.isEmpty()) break;
    // Leave an unfinished final line to the writer. Long tool-output lines are
    // skipped in bounded chunks; a budget boundary must not discard a record.
    if (!line.endsWith('\n') && line.size() < 64 * 1024 && !entry.skipping) {
      file.seek(start);
      break;
    }
    allowance -= line.size();
    budget -= line.size();
    entry.offset = file.pos();
    if (entry.skipping) {
      entry.skipping = !line.endsWith('\n');
      continue;
    }
    if (!line.endsWith('\n')) {
      entry.skipping = true;
      const auto type = QRegularExpression("\"type\"\\s*:\\s*\"([^\"]+)\"")
                            .match(QString::fromUtf8(line.left(1024))).captured(1);
      if (!entry.header || type == "turn_context" || type == "event_msg" ||
          type == "token_usage_record") entry.partial = true;
      continue;
    }
    Object event;
    try {
      if (entry.header && !line.contains("token_count") &&
          !line.contains("turn_context") && !line.contains("token_usage_record")) continue;
      event = parse(line).toObject();
    } catch (...) {
      entry.partial = true;
      continue;
    }
    const auto payload = event["payload"].toObject();
    if (!entry.header) {
      const auto spawn = payload["source"].toObject()["subagent"].toObject()
                              ["thread_spawn"].toObject();
      const auto actualParent = payload["parent_thread_id"].toString(
          spawn["parent_thread_id"].toString());
      if (event["type"] != "session_meta" || payload["id"] != id ||
          actualParent != parent ||
          (spawn.contains("parent_thread_id") && spawn["parent_thread_id"] != parent)) {
        entries.remove(id);
        return {}; // An index/path mismatch must never expose another chat's usage.
      }
      entry.header = true;
      entry.startOrdinal = qMax<qint64>(0, payload["subagent_history_start_ordinal"].toInteger());
      continue;
    }
    if (event["ordinal"].isDouble() &&
        event["ordinal"].toDouble() < entry.startOrdinal) continue;
    if (event["type"] == "turn_context") {
      const auto model = payload["model"].toString();
      entry.model = !model.isEmpty() && model.size() <= 200 ? model : QString{};
      continue;
    }
    Object total;
    if (event["type"] == "token_usage_record") {
      if (payload["thread_id"] != id) continue;
      total = counts(payload["thread_token_usage"].toObject());
      if (!total.isEmpty()) entry.explicitRecords = true;
    } else if (event["type"] == "event_msg" && payload["type"] == "token_count" &&
               !entry.explicitRecords) {
      total = counts(payload["info"].toObject()["total_token_usage"].toObject());
    } else continue;
    if (total.isEmpty()) {
      // Some notifications contain only rate limits, without a usage sample.
      if (event["type"] == "token_usage_record" || payload["info"].isObject()) entry.partial = true;
      continue;
    }
    Object delta;
    bool backwards = false;
    for (const auto &key : fields) {
      const auto n = total[key].toDouble() - entry.previous[key].toDouble();
      backwards |= n < 0;
      delta[key] = n;
    }
    // Counter rollbacks cannot be attributed reliably to a model. Retain the
    // previous high-water mark and mark the price coverage as incomplete.
    if (backwards) {
      entry.partial = true;
      continue;
    }
    entry.previous = total;
    entry.seen = true;
    if (delta["totalTokens"].toDouble() == 0) continue;
    if (delta["cachedInputTokens"].toDouble() > delta["inputTokens"].toDouble() ||
        delta["reasoningOutputTokens"].toDouble() > delta["outputTokens"].toDouble()) {
      entry.partial = true;
      continue;
    }
    auto model = entry.model;
    // Bound wire size even for a long-lived child that changed models often.
    if (entry.models.size() >= 7 && !entry.models.contains(model)) model.clear();
    auto group = entry.models.value(model);
    group["model"] = model.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(model);
    bool valid = true;
    for (const auto &key : fields) {
      group[key] = group[key].toDouble() + delta[key].toDouble();
      valid &= counter(group[key]);
    }
    if (valid) entry.models[model] = group;
    else entry.partial = true;
  }
  if (!entry.header) return unknownUsage(indexedTotal);
  Array models;
  double recorded = 0;
  auto names = entry.models.keys();
  names.sort();
  for (const auto &name : names) {
    const auto group = entry.models.value(name);
    recorded += group["totalTokens"].toDouble();
    models.append(group);
  }
  const auto total = qMax(qMax(0.0, indexedTotal),
                          entry.previous["totalTokens"].toDouble());
  const bool complete = entry.offset == info.size() && !entry.skipping;
  if (!entry.seen && indexedTotal < 0) return {};
  return {{"totalTokens", total}, {"recordedTokens", recorded},
          {"totalKnown", indexedTotal >= 0 || (complete && entry.seen)},
          {"partial", entry.partial || !complete || recorded < total},
          {"models", models}};
}

void SubAgentUsageReader::retain(const QSet<QString> &ids) {
  for (auto it = entries.begin(); it != entries.end();)
    if (!ids.contains(it.key())) it = entries.erase(it);
    else ++it;
}

void Service::refreshSubAgentUsage(const QString &indexPath) {
  QHash<QString, Object> rows;
  QHash<QString, QStringList> children;
  if (!indexPath.isEmpty()) {
    const auto connection = "subagent-usage-" + uuid();
    {
      auto db = QSqlDatabase::addDatabase("QSQLITE", connection);
      db.setDatabaseName(indexPath);
      db.setConnectOptions("QSQLITE_OPEN_READONLY;QSQLITE_BUSY_TIMEOUT=100");
      if (db.open()) {
        QSqlQuery query(db);
        query.setForwardOnly(true);
        if (query.exec("SELECT id,source,rollout_path,tokens_used FROM threads WHERE source LIKE '%subagent%'"))
          while (query.next()) {
            Object source;
            try { source = parse(query.value(1).toByteArray()).toObject(); }
            catch (...) { continue; }
            const auto spawn = source["subagent"].toObject()["thread_spawn"].toObject();
            const auto parent = spawn["parent_thread_id"].toString();
            const auto id = query.value(0).toString();
            if (parent.isEmpty() || id.isEmpty() || id == parent || id.size() > 160 || parent.size() > 160)
              continue;
            Object row{{"path", query.value(2).toString()}, {"parent", parent}};
            bool ok = false;
            const auto n = query.value(3).toDouble(&ok);
            if (ok && !query.value(3).isNull() && counter(n)) row["total"] = n;
            for (const auto &pair : QList<QPair<QString, QString>>{
                     {"name", "agent_nickname"}, {"role", "agent_role"}})
              if (!spawn[pair.second].toString().isEmpty())
                row[pair.first] = spawn[pair.second].toString().left(256);
            rows[id] = row;
            children[parent].append(id);
          }
        db.close();
      }
    }
    QSqlDatabase::removeDatabase(connection);
  }
  const auto threads = snapshot["threads"].toObject();
  QHash<QString, Array> byThread;
  QSet<QString> wanted, truncated;
  for (auto it = threads.begin(); it != threads.end(); ++it) {
    Array agents = it.value().toObject()["subAgents"].toArray();
    QSet<QString> seen{it.key()};
    for (const auto &v : agents) seen.insert(v.toObject()["threadId"].toString());
    QStringList queue{it.key()};
    for (int i = 0; i < queue.size() && i < 1024; ++i) {
      for (const auto &child : children.value(queue[i])) {
        if (queue.contains(child) || child == it.key()) continue;
        queue.append(child);
        if (seen.contains(child)) continue;
        if (agents.size() >= 32) { truncated.insert(it.key()); continue; }
        seen.insert(child);
        auto row = rows.value(child);
        Object a{{"threadId", child}, {"parentThreadId", row["parent"]},
                 {"status", "unknown"}, {"statusSource", "reported"}};
        for (const auto &key : {"name", "role"})
          if (row.contains(key)) a[key] = row[key];
        agents.append(a);
      }
    }
    for (const auto &a : agents) wanted.insert(a.toObject()["threadId"].toString());
    byThread[it.key()] = agents;
  }
  subAgentUsage.retain(wanted);
  QStringList ids(wanted.begin(), wanted.end());
  ids.sort();
  QHash<QString, Object> values;
  qint64 budget = 4 * 1024 * 1024;
  auto home = settings["codexHome"].toString();
  if (home.isEmpty()) home = QDir::homePath() + "/.codex";
  int consumed = 0;
  for (int i = 0; i < ids.size(); ++i) {
    const auto id = ids[(subAgentUsageCursor + i) % ids.size()];
    const auto row = rows.value(id);
    if (row.isEmpty()) continue;
    const auto before = budget;
    try {
      values[id] = subAgentUsage.readUsage(home, id, row["parent"].toString(),
          row["path"].toString(), row["total"].toDouble(-1), budget);
    } catch (...) {
      values[id] = unknownUsage(row["total"].toDouble(-1));
    }
    if (before > budget) consumed = i + 1;
  }
  if (!ids.isEmpty()) subAgentUsageCursor = (subAgentUsageCursor + qMax(1, consumed)) % ids.size();
  for (auto it = threads.begin(); it != threads.end(); ++it) {
    auto thread = it.value().toObject();
    auto agents = byThread.value(it.key());
    for (int i = 0; i < agents.size(); ++i) {
      auto a = agents[i].toObject();
      const auto id = a["threadId"].toString();
      if (values.contains(id)) {
        if (values[id].isEmpty()) a.remove("usage");
        else a["usage"] = values[id];
      }
      agents[i] = a;
    }
    if (agents == thread["subAgents"].toArray() &&
        (!truncated.contains(it.key()) || thread["subAgentsTruncated"].toBool())) continue;
    thread["subAgents"] = agents;
    if (truncated.contains(it.key())) thread["subAgentsTruncated"] = true;
    thread["revision"] = thread["revision"].toDouble() + 1;
    commit({{"type", "thread.updated"}, {"thread", boundTurns(thread)}});
  }
}
} // namespace Native
