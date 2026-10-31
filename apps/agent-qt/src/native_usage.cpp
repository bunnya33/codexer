#include "native.h"
#include <cmath>
namespace Native {
namespace {
const QStringList counters{"totalTokens", "inputTokens", "cachedInputTokens",
                           "outputTokens", "cacheWriteInputTokens",
                           "reasoningOutputTokens"};
Object breakdown(const QJsonValue &value) {
  if (!value.isObject())
    return {};
  const auto raw = value.toObject();
  Object result;
  for (int i = 0; i < counters.size(); ++i) {
    const auto v = raw[counters[i]];
    if (i >= 4 && v.isUndefined())
      continue;
    const auto n = v.toDouble(-1);
    if (!v.isDouble() || !std::isfinite(n) || n < 0 ||
        n > 9007199254740991.0 || std::floor(n) != n)
      return {};
    result[counters[i]] = n;
  }
  if (result.value("cachedInputTokens").toDouble() >
          result.value("inputTokens").toDouble() ||
      result.value("reasoningOutputTokens").toDouble() >
          result.value("outputTokens").toDouble())
    return {};
  return result;
}
bool same(const Object &a, const Object &b) {
  for (const auto &key : counters)
    if (a[key].toDouble() != b[key].toDouble())
      return false;
  return true;
}
Object validRecord(const Object &value) {
  auto result = breakdown(value);
  const auto state = value["state"].toString();
  if (result.isEmpty() ||
      !QStringList{"running", "complete", "partial"}.contains(state))
    return {};
  result["state"] = state;
  if (value.contains("model")) {
    const auto model = value["model"].toString();
    if (!value["model"].isString() || model.isEmpty() || model.size() > 200)
      return {};
    result["model"] = model;
  }
  return result;
}
} // namespace
Object Service::usageRecord(const QString &threadId, const QString &turnId) {
  if (!usage.isOpen())
    return {};
  auto row = sql(usage,
                 "SELECT value FROM turn_usage WHERE thread_id=? AND turn_id=?",
                 {threadId, turnId});
  if (!row.next())
    return {};
  try {
    return validRecord(parse(row.value(0).toByteArray()).toObject());
  } catch (...) {
    return {};
  }
}
bool Service::saveUsage(const QString &threadId, const QString &turnId,
                        const Object &value) {
  const auto record = validRecord(value);
  if (!usage.isOpen() || record.isEmpty() || turnId.isEmpty())
    return false;
  sql(usage,
      "INSERT INTO turn_usage(thread_id,turn_id,value) VALUES(?,?,?) ON "
      "CONFLICT(thread_id,turn_id) DO UPDATE SET value=excluded.value",
      {threadId, turnId, json(record)});
  return true;
}
void Service::startUsage(const QString &id, const QString &turnId,
                         const QString &model) {
  if (turnId.isEmpty())
    return;
  const auto prior = usageObservations.value(id);
  if (prior["turnId"] == turnId && !prior["idle"].toBool())
    return;
  Object observation{{"turnId", turnId}, {"idle", false},
                     {"baseline", prior["baseline"]}, {"coverage", true},
                     {"firstNotification", true}};
  if (!model.isEmpty() && model.size() <= 200)
    observation["model"] = model;
  usageObservations[id] = observation;
}
void Service::finishUsage(const QString &id, const QString &turnId) {
  if (!usageObservations.contains(id) ||
      usageObservations.value(id).value("turnId") != turnId)
    return;
  auto &observation = usageObservations[id];
  observation["idle"] = true;
  auto saved = usageRecord(id, turnId);
  const auto state = observation.value("coverage").toBool() ? "complete" : "partial";
  if (saved.isEmpty() || saved.value("state") == state ||
      (saved.value("state") == "complete" && qstrcmp(state, "partial") == 0))
    return;
  saved["state"] = state;
  saveUsage(id, turnId, saved);
}
void Service::gapUsage(const QString &id) {
  const auto observation = usageObservations.take(id);
  if (observation.isEmpty() || observation["idle"].toBool())
    return;
  const auto turnId = observation["turnId"].toString();
  try {
    auto saved = usageRecord(id, turnId);
    if (!saved.isEmpty() && saved.value("state") != "complete") {
      saved["state"] = "partial";
      saveUsage(id, turnId, saved);
    }
  } catch (...) {
    log("token-usage-observation-failed");
  }
}
void Service::attachDesktop() {
  connect(desktop, &Desktop::threadChanged, this, [this](const QString &id) {
    if (!desktopThreads.contains(id))
      return;
    // Observe every IPC change before the display queue coalesces updates.
    try {
      observeDesktopUsage(id);
    } catch (...) {
      gapUsage(id);
      log("token-usage-observation-failed");
    }
    dirtyThreads.insert(id);
  });
}
void Service::observeDesktopUsage(const QString &id) {
  const auto watch = desktop->watched.constFind(id);
  if (watch == desktop->watched.cend() || !watch->compatible) {
    gapUsage(id);
    return;
  }
  // Read IDs and counters only; do not normalize/copy tool output per patch.
  const auto meta = usageMetadata(watch->raw);
  const auto value = meta["usage"].toObject();
  const auto total = breakdown(value["total"]);
  const auto turnId = meta["turnId"].toString();
  const bool idle = !meta["active"].toBool();
  if (!idle && turnId.isEmpty()) {
    // Desktop briefly publishes a temporary turn without its official ID.
    if (!usageObservations.contains(id))
      usageObservations[id] = {{"idle", false}, {"baseline", total},
                               {"coverage", false}};
    return;
  }
  if (!usageObservations.contains(id)) {
    // A follower's initial snapshot establishes a baseline, never past usage.
    usageObservations[id] = {{"turnId", turnId}, {"idle", idle},
                             {"baseline", total}, {"coverage", false}};
    return;
  }
  auto &observation = usageObservations[id];
  if (observation.value("turnId").toString() != turnId) {
    const auto previous = observation.value("turnId").toString();
    const bool skipped = !previous.isEmpty() &&
                         !meta["turnIds"].toArray().contains(previous);
    observation = {{"turnId", turnId}, {"idle", idle},
                   {"baseline", skipped ? total : observation.value("baseline")},
                   {"coverage", !skipped && observation.value("idle").toBool() && !idle},
                   {"model", meta["model"]}};
    if (!observation.value("model").isString() ||
        observation.value("model").toString().isEmpty())
      observation.remove("model");
  }
  if (!turnId.isEmpty() && !total.isEmpty())
    observeUsage(id, turnId, value, false);
  if (!turnId.isEmpty() && idle)
    finishUsage(id, turnId);
  else
    observation["idle"] = idle;
}
void Service::observeUsage(const QString &id, const QString &turnId,
                           const Object &value, bool notification) {
  const auto total = breakdown(value["total"]), last = breakdown(value["last"]);
  if (!usage.isOpen() || turnId.isEmpty() || total.isEmpty())
    return;
  if (!usageObservations.contains(id)) {
    usageObservations[id] = {{"turnId", turnId}, {"idle", true},
                             {"baseline", total}, {"coverage", false}};
    return;
  }
  auto &observation = usageObservations[id];
  if (observation.value("turnId") != turnId) {
    if (notification && !observation.value("idle").toBool())
      return;
    observation = {{"turnId", turnId}, {"idle", true},
                   {"baseline", total}, {"coverage", false}};
    return;
  }
  const auto baseline = observation.value("baseline").toObject();
  if (!baseline.isEmpty() && same(total, baseline))
    return;
  auto previous = usageRecord(id, turnId);
  auto partial = [&] {
    observation["coverage"] = false;
    if (!previous.isEmpty()) {
      previous["state"] = "partial";
      saveUsage(id, turnId, previous);
    }
  };
  Object delta;
  if (!baseline.isEmpty()) {
    for (const auto &key : counters) {
      const double n = total[key].toDouble(), b = baseline[key].toDouble();
      if (n < b) {
        observation["baseline"] = total;
        observation["firstNotification"] = false;
        partial();
        return;
      }
      delta[key] = n - b;
    }
  } else if (!last.isEmpty() && observation.value("coverage").toBool() &&
             ((notification && observation.value("firstNotification").toBool()) ||
              same(total, last))) {
    delta = last;
  } else {
    observation["coverage"] = false;
    observation["baseline"] = total;
    observation["firstNotification"] = false;
    return;
  }
  observation["baseline"] = total;
  observation["firstNotification"] = false;
  Object saved;
  for (const auto &key : counters)
    saved[key] = previous.value(key).toDouble() + delta.value(key).toDouble();
  saved["state"] = observation.value("coverage").toBool()
                       ? observation.value("idle").toBool() ? "complete" : "running"
                       : "partial";
  const auto model = previous.contains("model") ? previous.value("model")
                                                : observation.value("model");
  if (model.isString())
    saved["model"] = model;
  if (!saveUsage(id, turnId, saved))
    partial();
}
void Service::enrichUsage(const QString &threadId, Object &turn) {
  const auto saved = usageRecord(threadId, turn.value("id").toString());
  if (!saved.isEmpty())
    turn["tokenUsage"] = saved;
}
} // namespace Native
