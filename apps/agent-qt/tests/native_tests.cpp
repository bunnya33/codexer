#include "native.h"
#include <QtEndian>
#include <QtTest>
#include <QtWebSockets/QWebSocketServer>
#include <algorithm>
#include <cstdio>
#include <iostream>
namespace Native {
static QString fixtureRoot;
static Object fixtureState() {
  try {
    return parse(read(fixtureRoot + "/fixture.json")).toObject();
  } catch (...) {
    return {};
  }
}
static int fixtureServer() {
  fixtureRoot = qEnvironmentVariable("CODEXER_NATIVE_FIXTURE");
  std::string line;
  while (std::getline(std::cin, line)) {
    Object request;
    try {
      request = parse(QByteArray::fromStdString(line)).toObject();
    } catch (...) {
      continue;
    }
    auto state = fixtureState();
    auto method = request["method"].toString();
    if (!request.contains("id"))
      continue;
    QFile log(fixtureRoot + "/requests.jsonl");
    if (log.open(QIODevice::Append)) {
      log.write(json(request) + '\n');
      log.close();
    }
    Object result, response{{"id", request["id"]}};
    if (method == "thread/read")
      result["thread"] = state["thread"];
    if (method == "thread/turns/list")
      result = {{"data", state["turns"].toArray()},
                {"nextCursor", QJsonValue::Null}};
    if (method == "project/list")
      result = {{"data", state["projects"].toArray()},
                {"nextCursor", QJsonValue::Null}};
    if (method == "thread/list")
      result = {{"data", state.contains("threadList")
                             ? state["threadList"].toArray()
                         : request["params"].toObject()["archived"].toBool()
                             ? Array{}
                             : Array{state["thread"]}},
                {"nextCursor", QJsonValue::Null}};
    if (method == "thread/items/list")
      result = {{"data", state["itemEntries"].toArray()},
                {"nextCursor", QJsonValue::Null}};
    if (method == "thread/settings/update") {
      if (state["rejectSettings"].toBool())
        response["error"] = Object{{"message", "settings rejected"}};
      else if (!state["omitSettingsAck"].toBool())
        result = {{"threadSettings", request["params"]}};
    }
    if (method == "project/create") {
      auto project = request["params"].toObject();
      project["id"] = "created-project";
      auto projects = state["projects"].toArray();
      projects.append(project);
      state["projects"] = projects;
      save(fixtureRoot + "/fixture.json", json(state));
      result["project"] = project;
    }
    if (method == "project/delete") {
      auto projects = state["projects"].toArray();
      for (int i = projects.size() - 1; i >= 0; --i)
        if (projects[i].toObject()["id"] ==
            request["params"].toObject()["projectId"])
          projects.removeAt(i);
      state["projects"] = projects;
      save(fixtureRoot + "/fixture.json", json(state));
    }
    if (method == "model/list") {
      Object model{{"model", "synthetic-model"},
                   {"displayName", "Synthetic"},
                   {"defaultReasoningEffort", "medium"},
                   {"supportedReasoningEfforts",
                    Array{Object{{"reasoningEffort", "medium"}},
                          Object{{"reasoningEffort", "high"}}}}};
      result = {{"data", Array{model}}, {"nextCursor", QJsonValue::Null}};
    }
    if (method == "thread/resume") {
      if (state["rejectWriter"].toBool())
        response["error"] = Object{
            {"message", "thread synthetic already has an active writer"}};
      else
        result = state["resume"].toObject();
    }
    if (method == "thread/start") {
      const int count = state["startCount"].toInt() + 1;
      state["startCount"] = count;
      result = state["resume"].toObject();
      auto thread = state["thread"].toObject();
      thread["id"] = "created-thread-" + QString::number(count);
      result["thread"] = thread;
      save(fixtureRoot + "/fixture.json", json(state));
    }
    if (method == "turn/start") {
      if (state["disconnectOnStart"].toBool())
        return 0;
      if (state["completeEarly"].toBool()) {
        Object event{{"method", "turn/completed"},
                     {"params", Object{{"threadId", "thread-test"},
                                       {"turn", Object{{"id", "turn-new"}}}}}};
        std::cout << json(event).constData() << '\n' << std::flush;
      }
      result = {{"turn", Object{{"id", "turn-new"}}}};
    }
    if (method == "turn/steer")
      result = {{"turnId", request["params"].toObject()["expectedTurnId"]}};
    if (!response.contains("error"))
      response["result"] = result;
    std::cout << json(response).constData() << '\n' << std::flush;
  }
  return 0;
}

class DesktopFixture : public QObject {
public:
  QLocalServer server;
  QPointer<QLocalSocket> peer;
  Object raw;
  QList<Object> requests;
  int ownerLookups = 0;
  int acceptedStarts = 0;
  bool hideFirstOwner = false, disconnectStart = false, hideOwner = false,
       rejectStarts = false;
  QString owner = "synthetic-owner";
  std::function<void()> onOwnerLookup;
  QString endpoint = "codexer-native-test-" + uuid();
  explicit DesktopFixture(Object state) : raw(state) {
    if (!server.listen(endpoint))
      throw Error("fixture-listen-failed");
    connect(&server, &QLocalServer::newConnection, this, [this] {
      peer = server.nextPendingConnection();
      auto bytes = std::make_shared<QByteArray>();
      connect(peer, &QLocalSocket::readyRead, this, [this, bytes] {
        bytes->append(peer->readAll());
        while (bytes->size() >= 4) {
          auto length = qFromLittleEndian<quint32>(bytes->constData());
          if (bytes->size() < length + 4)
            return;
          auto message = parse(bytes->mid(4, length)).toObject();
          bytes->remove(0, length + 4);
          auto method = message["method"].toString();
          if (message["type"] == "broadcast") {
            if (message["params"].toObject()["following"].toBool() &&
                message["targetClientIds"].toArray().contains(owner))
              snapshot();
            continue;
          }
          if (message["type"] != "request")
            continue;
          requests.append(message);
          Object response{{"type", "response"},
                          {"requestId", message["requestId"]},
                          {"resultType", "success"},
                          {"handledByClientId", owner}};
          if (method == "initialize")
            response["result"] = Object{{"clientId", "synthetic-follower"}};
          else if (method == "thread-owner-discovery") {
            ++ownerLookups;
            if (onOwnerLookup)
              onOwnerLookup();
            if (hideOwner || (hideFirstOwner && ownerLookups == 1)) {
              response["resultType"] = "error";
              response["error"] = "no-client-found";
            }
          } else if (message["targetClientId"] != owner ||
                     (rejectStarts && method == "thread-follower-start-turn")) {
            response["resultType"] = "error";
            response["error"] = "no-client-found";
          } else if (method == "thread-follower-start-turn") {
            if (disconnectStart) {
              peer->abort();
              return;
            }
            ++acceptedStarts;
            response["result"] = Object{
                {"result", Object{{"turn", Object{{"id", "desktop-turn"}}}}}};
          } else if (method == "thread-follower-steer-turn")
            response["result"] = Object{{"result", Object{{"turnId", "turn"}}}};
          else if (method == "thread-follower-update-thread-settings") {
            raw["latestThreadSettings"] = merged(
                raw["latestThreadSettings"].toObject(),
                message["params"].toObject()["threadSettings"].toObject());
            snapshot();
            response["result"] = Object{{"applied", true}};
          } else
            response["result"] =
                Object{{"ok", true}, {"interruptedTurnId", "turn"}};
          send(response);
        }
      });
    });
  }
  ~DesktopFixture() override {
    if (peer)
      peer->abort();
  }
  void send(Object value) {
    auto body = json(value);
    QByteArray frame(4, '\0');
    qToLittleEndian<quint32>(body.size(), frame.data());
    peer->write(frame + body);
  }
  void snapshot() {
    send({{"type", "broadcast"},
          {"method", "thread-stream-state-changed"},
          {"sourceClientId", owner},
          {"version", 11},
          {"params", Object{{"conversationId", "thread-test"},
                            {"hostId", "local"},
                            {"change", Object{{"type", "snapshot"},
                                              {"revision", 0},
                                              {"conversationState", raw}}}}}});
  }
  void patch(const Array &patches, qint64 base, qint64 revision) {
    send({{"type", "broadcast"}, {"method", "thread-stream-state-changed"},
          {"sourceClientId", owner}, {"version", 11},
          {"params", Object{{"conversationId", "thread-test"}, {"hostId", "local"},
              {"change", Object{{"type", "patches"}, {"baseRevision", double(base)},
                                {"revision", double(revision)}, {"patches", patches}}}}}});
  }
};
class NativeTests : public QObject {
  Q_OBJECT
  QTemporaryDir temp;
  std::unique_ptr<Service> agent;
  Object command(QString type = "turn.start") {
    return {{"commandId", uuid()},
            {"deviceId", agent->credentials["deviceId"]},
            {"expectedEpoch", agent->snapshot["epoch"]},
            {"expiresAt", double(now() + 60000)},
            {"payload", Object{{"type", type},
                               {"threadId", "thread-test"},
                               {"text", "synthetic input"}}}};
  }
  Object raw() {
    return {{"id", "thread-test"},
            {"title", "Synthetic"},
            {"cwd", temp.path()},
            {"threadRuntimeStatus", Object{{"type", "idle"}}},
            {"turns", Array{}},
            {"requests", Array{}},
            {"updatedAt", double(now())}};
  }
  void setFixture(Object changes = {}) {
    auto path = temp.path() + "/codex/sessions/2026/10/30/rollout.jsonl";
    Object metadata{
        {"type", "session_meta"},
        {"payload", Object{{"id", "thread-test"},
                           {"runtime_workspace_roots", Array{temp.path()}}}}};
    Object context{
        {"type", "turn_context"},
        {"payload", Object{{"cwd", temp.path()},
                           {"model", "synthetic-model"},
                           {"sandbox_policy",
                            Object{{"type", "workspace-write"},
                                   {"writable_roots", Array{temp.path()}}}},
                           {"approval_policy", "on-request"},
                           {"approvals_reviewer", "user"},
                           {"effort", "medium"}}}};
    save(path, json(metadata) + '\n' + json(context) + '\n');
    Object state{
        {"thread", Object{{"id", "thread-test"},
                          {"path", path},
                          {"cwd", temp.path()},
                          {"modelProvider", "openai"},
                          {"preview", "Synthetic"},
                          {"status", Object{{"type", "idle"}}},
                          {"updatedAt", double(now()) / 1000}}},
        {"turns", Array{}},
        {"projects",
         Array{Object{{"id", "project-test"},
                      {"name", "Synthetic"},
                      {"roots", Array{Object{{"path", temp.path()}}}}}}},
        {"resume",
         Object{{"model", "synthetic-model"},
                {"modelProvider", "openai"},
                {"cwd", temp.path()},
                {"approvalPolicy", "on-request"},
                {"approvalsReviewer", "user"},
                {"runtimeWorkspaceRoots", Array{temp.path()}},
                {"sandbox", Object{{"type", "workspaceWrite"},
                                   {"writableRoots", Array{temp.path()}}}}}}};
    save(temp.path() + "/fixture.json", json(merged(state, changes)));
  }
  void fillPreviews(int count = DefaultSyncedThreads) {
    Object threads;
    auto entries = agent->catalog["threads"].toArray();
    for (int i = 0; i < count; ++i) {
      const auto id = QString("preview-%1").arg(i, 2, 10, QChar('0'));
      auto source = raw();
      source["id"] = id;
      source["title"] = QString::fromUtf8("中文会话 😀");
      source["updatedAt"] = i + 1;
      threads[id] = normalizeThread(source, 0);
      agent->rawThreads[id] = source;
      agent->dirtyThreads.insert(id);
      entries.append(Object{{"id",id},{"projectId","project-test"},{"archived",false}});
    }
    agent->snapshot["threads"] = threads;
    agent->catalog["threads"] = entries;
  }
  Object counts(double input, double output, double cached) {
    return {{"totalTokens", input + output}, {"inputTokens", input},
            {"outputTokens", output}, {"cachedInputTokens", cached}};
  }
  Object usageState(const QString &turnId, bool active, const Object &total,
                    const QString &previous = "old") {
    auto result = raw();
    result["latestModel"] = "model-a";
    result["threadRuntimeStatus"] = Object{{"type", active ? "active" : "idle"}};
    result["latestTokenUsageInfo"] = Object{{"total", total}, {"last", total}};
    result["turns"] = Array{Object{{"id", previous}, {"status", "completed"}, {"items", Array{}}},
        Object{{"id", turnId}, {"status", active ? "inProgress" : "completed"}, {"items", Array{}}}};
    return result;
  }
  void desktopUsage(const Object &raw) {
    agent->desktopThreads.insert("thread-test");
    auto &watch = agent->desktop->watched["thread-test"];
    watch.raw = raw;
    watch.compatible = true;
    emit agent->desktop->threadChanged("thread-test");
  }
private slots:
  void init() {
    QVERIFY(temp.isValid());
    auto previous = QDir(temp.path()).entryList(QDir::Files);
    for (const auto &name : previous)
      QFile::remove(temp.path() + '/' + name);
    fixtureRoot = temp.path();
    qputenv("CODEXER_NATIVE_FIXTURE", fixtureRoot.toUtf8());
    agent = std::make_unique<Service>(temp.path());
    agent->settings = agent->defaults();
    agent->settings["codexBinary"] = QCoreApplication::applicationFilePath();
    agent->settings["codexHome"] = temp.path() + "/codex";
    agent->settings["runtime"] = "headless";
    agent->credentials = {{"deviceId", uuid()},
                          {"session", "synthetic-not-transmitted"},
                          {"relayUrl", "http://127.0.0.1:1"}};
    agent->network = new QNetworkAccessManager(agent.get());
    agent->desktop = new Desktop(agent.get());
    agent->attachDesktop();
    agent->view = {{"logs", Array{}}};
    agent->paused = false;
    agent->initialized = true;
    agent->snapshot = {
        {"protocolVersion", 1},
        {"deviceId", agent->credentials["deviceId"]},
        {"epoch", uuid()},
        {"lastSeq", 0},
        {"generatedAt", double(now())},
        {"hostname", "Synthetic"},
        {"platform", platform()},
        {"agentVersion", CODEXER_AGENT_VERSION},
        {"runtime", Object{{"kind", "official-app-server"},
                           {"connected", true},
                           {"experimental", true},
                           {"capabilities", Object{{"observe", true},
                                                   {"startTurn", true},
                                                   {"interrupt", true},
                                                   {"approvals", true},
                                                   {"userInput", true}}}}},
        {"threads", Object{}}};
    agent->openJournal();
    setFixture();
  }
  void cleanup() {
    agent.reset();
    qunsetenv("CODEX_REMOTE_DESKTOP_ENDPOINT");
  }
  void framePatches() {
    auto result = applyPatch(
        {{"id", "x"}, {"items", Array{1, 2}}},
        {Object{{"op", "add"}, {"path", Array{"items", 1}}, {"value", 3}}});
    QCOMPARE(result["items"].toArray(), Array({1, 3, 2}));
    QVERIFY_EXCEPTION_THROWN(
        applyPatch({}, {Object{{"op", "add"},
                               {"path", Array{"__proto__", "x"}},
                               {"value", true}}}),
        Error);
  }
  void permissions() {
    auto preset = permissionPreset("ask", {temp.path()});
    auto permission = permissionSettings(preset);
    QCOMPARE(permission["mode"], QJsonValue("ask"));
    QCOMPARE(permission["fingerprint"].toString().size(), 64);
    QVERIFY(permissionSettings(
                permissionPreset("full-access", {}))["fingerprint"] !=
            permission["fingerprint"]);
  }
  void approvalBoundaries() {
    Object request{{"mode", "form"},
                   {"serverName", "browser"},
                   {"requestedSchema",
                    Object{{"type", "object"}, {"properties", Object{}}}},
                   {"_meta", Object{{"origin", "https://example.test/path"},
                                    {"persist", Array{"session"}}}}};
    QCOMPARE(approval(request)["target"], QJsonValue("https://example.test"));
    QVERIFY_EXCEPTION_THROWN(approvalResponse(request, "decline", "session"),
                             Error);
    auto meta = request["_meta"].toObject();
    meta["executionBound"] = true;
    request["_meta"] = meta;
    QVERIFY(approval(request).isEmpty());
  }
  void normalizeUserAndTiming() {
    auto thread = raw();
    Object turn{
        {"id", "turn"},
        {"status", "completed"},
        {"startedAt", 100},
        {"completedAt", 102},
        {"items", Array{Object{{"id", "u"},
                               {"type", "userMessage"},
                               {"content", Array{Object{{"type", "text"},
                                                        {"text", "你好"}}}}},
                        Object{{"id", "a"},
                               {"type", "agentMessage"},
                               {"phase", "final_answer"},
                               {"text", "done"}}}}};
    thread["turns"] = Array{turn};
    auto output = normalizeThread(thread, 1);
    auto t = output["turns"].toArray()[0].toObject();
    QCOMPARE(t["startedAtMs"], QJsonValue(100000));
    QCOMPARE(t["completedAtMs"], QJsonValue(102000));
    QCOMPARE(t["items"].toArray()[0].toObject()["text"],
             QJsonValue(QString::fromUtf8("你好")));
    QCOMPARE(t["items"].toArray()[1].toObject()["phase"],
             QJsonValue("final_answer"));
  }
  void preservesPromptWhenTruncating() {
    auto thread = raw();
    Array items{Object{{"id", "prompt"},
                       {"type", "userMessage"},
                       {"content", Array{Object{{"text", "keep me"}}}}}};
    for (int n = 0; n < 40; ++n)
      items.append(Object{{"id", QString::number(n)},
                          {"type", "commandExecution"},
                          {"aggregatedOutput", QString(20000, 'x')}});
    thread["turns"] = Array{
        Object{{"id", "turn"}, {"status", "completed"}, {"items", items}}};
    auto out = normalizeThread(thread, 0);
    QVERIFY(json(out).size() <= 256 * 1024);
    auto visible = out["turns"].toArray()[0].toObject()["items"].toArray();
    bool found = false;
    for (const auto &v : visible)
      found |= v.toObject()["id"] == "prompt";
    QVERIFY(found);
  }
  void incompleteActiveTurnIdentity() {
    auto thread = raw();
    thread["threadRuntimeStatus"] = Object{{"type", "active"}};
    const Array identities{Object{}, Object{{"turnId", QJsonValue::Null}},
                           Object{{"turnId", ""}}, Object{{"id", ""}},
                           Object{{"turnId", ""}, {"id", "fallback"}},
                           Object{{"turnId", "current"}, {"id", "legacy"}},
                           Object{{"turnId", QString(161, 'x')}}};
    const Array expected{QJsonValue::Null, QJsonValue::Null, QJsonValue::Null,
                         QJsonValue::Null, "fallback", "current", QJsonValue::Null};
    for (int i = 0; i < identities.size(); ++i) {
      auto turn = identities[i].toObject();
      turn["status"] = "inProgress";
      turn["items"] = Array{};
      thread["turns"] = Array{Object{{"id", "previous"}, {"status", "inProgress"}}, turn};
      auto out = normalizeThread(thread, 0);
      QCOMPARE(out["status"], QJsonValue("active"));
      QCOMPARE(out["activeTurnId"], expected[i]);
      QVERIFY(!out["turns"].toArray().last().toObject()["id"].toString().isEmpty());
    }
    thread["turns"] = Array{Object{{"id", "current"}, {"status", "inProgress"}}};
    QCOMPARE(normalizeThread(thread, 1)["activeTurnId"], QJsonValue("current"));
    thread["threadRuntimeStatus"] = Object{{"type", "idle"}};
    QVERIFY(normalizeThread(thread, 2)["activeTurnId"].isNull());
  }
  void asyncQuestions() {
    auto thread = raw();
    thread["threadRuntimeStatus"] = Object{{"type", "active"}};
    thread["turns"] = Array{
        Object{{"id", "turn"},
               {"status", "inProgress"},
               {"items",
                Array{Object{{"id", "question"},
                             {"type", "agentMessage"},
                             {"questions",
                              Array{Object{{"title", "Which?"},
                                           {"options", Array{"A", "B"}}}}}}}}}};
    auto out = normalizeThread(thread, 0);
    auto requests = out["requests"].toArray();
    QCOMPARE(requests.size(), 1);
    auto answer = asyncAnswer(requests[0].toObject(),
                              {{"0", Object{{"answers", Array{"A"}}}}});
    QVERIFY(answer.contains("request_user_input_async"));
    QVERIFY_EXCEPTION_THROWN(
        asyncAnswer(requests[0].toObject(),
                    {{"unknown", Object{{"answers", Array{"A"}}}}}),
        Error);
  }
  void savedContextAndRoots() {
    auto source = fixtureState()["thread"].toObject();
    auto saved = agent->savedContext(source);
    QCOMPARE(saved["runtimeWorkspaceRoots"].toArray(), Array{temp.path()});
    QCOMPARE(saved["approvalPolicy"], QJsonValue("on-request"));
  }
  void rejectsWrongMetadata() {
    auto source = fixtureState()["thread"].toObject();
    source["id"] = "other";
    QVERIFY_EXCEPTION_THROWN(agent->savedContext(source), Error);
  }
  void rejectsOutsideRollout() {
    auto source = fixtureState()["thread"].toObject();
    source["path"] = temp.path() + "/outside.jsonl";
    save(source["path"].toString(), "{}\n");
    QVERIFY_EXCEPTION_THROWN(agent->savedContext(source), Error);
  }
  void journalDoesNotResend() {
    auto cmd = command("runtime.refresh");
    agent->processCommand(cmd);
    agent->processCommand(cmd);
    auto rows = sql(agent->journal, "SELECT COUNT(*) FROM native_commands");
    QVERIFY(rows.next());
    QCOMPARE(rows.value(0).toInt(), 1);
    auto result = sql(agent->journal, "SELECT result FROM native_commands");
    QVERIFY(result.next());
    QCOMPARE(parse(result.value(0).toByteArray()).toObject()["status"],
             QJsonValue("succeeded"));
    auto reused = cmd;
    reused["payload"] =
        Object{{"type", "thread.watch"}, {"threadId", "unrelated"}};
    agent->processCommand(reused);
    QCOMPARE(sql(agent->journal, "SELECT COUNT(*) FROM native_commands")
                 .lastError()
                 .type(),
             QSqlError::NoError);
  }
  void staleCommandNeverExecutes() {
    auto cmd = command();
    cmd["expectedEpoch"] = "stale";
    agent->processCommand(cmd);
    QVERIFY(!agent->rpc);
    auto q = sql(agent->journal, "SELECT result FROM native_commands");
    QVERIFY(q.next());
    QCOMPARE(parse(q.value(0).toByteArray()).toObject()["code"],
             QJsonValue("stale-device-epoch"));
  }
  void writerConflictDoesNotSend() {
    setFixture({{"rejectWriter", true}});
    agent->refreshCatalog();
    try {
      agent->execute(command());
      QFAIL("resume conflict must fail");
    } catch (const Error &e) {
      QCOMPARE(e.code, QString("thread-writer-busy"));
      QVERIFY(!e.uncertain);
    }
    auto requests = read(temp.path() + "/requests.jsonl");
    QVERIFY(!requests.contains("turn/start"));
  }
  void uncertainStartNotResent() {
    setFixture({{"disconnectOnStart", true}});
    agent->refreshCatalog();
    auto cmd = command();
    agent->processCommand(cmd);
    auto q = sql(agent->journal, "SELECT result FROM native_commands");
    QVERIFY(q.next());
    QCOMPARE(parse(q.value(0).toByteArray()).toObject()["status"],
             QJsonValue("unknown"));
    auto before = read(temp.path() + "/requests.jsonl");
    agent->processCommand(cmd);
    QCOMPARE(read(temp.path() + "/requests.jsonl"), before);
  }
  void completionBeforeAckDoesNotRemainBusy() {
    setFixture({{"completeEarly", true}});
    agent->refreshCatalog();
    auto result = agent->execute(command());
    QCOMPARE(result["turnId"], QJsonValue("turn-new"));
    QVERIFY(!agent->busyTurns.contains("turn-new"));
  }
  void activeRefreshDeferred() {
    agent->ensureRpc();
    auto previous = agent->rpc;
    agent->busyTurns.insert("busy");
    QCOMPARE(agent->refresh(true), QString("deferred"));
    QCOMPARE(agent->rpc, previous);
  }
  void newThreadRefreshDeferred() {
    agent->ensureRpc();
    agent->newThreads.insert("new");
    QCOMPARE(agent->refresh(true), QString("deferred"));
  }
  void pendingApprovalReleaseDeferred() {
    agent->ensureRpc();
    agent->owned.insert("thread-test");
    agent->pendingRequests["approval"] = {{"id", "approval"}};
    QCOMPARE(agent->release(true)["released"], QJsonValue(0));
  }
  void idleReleaseRecyclesOwnRuntime() {
    agent->ensureRpc();
    auto previous = agent->rpc;
    agent->owned.insert("thread-test");
    agent->acquired["thread-test"] = now() - 10000;
    QCOMPARE(agent->release(true)["released"], QJsonValue(1));
    QVERIFY(agent->rpc != previous);
    QVERIFY(agent->owned.isEmpty());
  }
  void failedReplacementKeepsRuntime() {
    agent->ensureRpc();
    auto previous = agent->rpc;
    agent->settings["codexBinary"] = temp.path() + "/missing.exe";
    QVERIFY_EXCEPTION_THROWN(agent->refresh(true), Error);
    QCOMPARE(agent->rpc, previous);
    QVERIFY(previous->connected());
  }
  void pauseKeepsLocalTaskAlive() {
    agent->ensureRpc();
    agent->busyTurns.insert("busy");
    auto previous = agent->rpc;
    agent->pause();
    QVERIFY(agent->paused);
    QCOMPARE(agent->rpc, previous);
    QVERIFY(previous->connected());
    QVERIFY(agent->busyTurns.contains("busy"));
  }
  void fileOnlyFromObservedMessage() {
    auto path = temp.path() + "/report.txt";
    save(path, "hello");
    Object request{{"threadId", "thread-test"}, {"path", path}};
    QVERIFY_EXCEPTION_THROWN(agent->readFile(request), Error);
    agent->observeFiles(
        "thread-test",
        {{"items", Array{Object{{"type", "agentMessage"},
                                {"text", "[report](<" + path + ">)"}}}}});
    auto info = agent->readFile(request);
    request["version"] = info["version"];
    request["offset"] = 0;
    QCOMPARE(QByteArray::fromBase64(
                 agent->readFile(request)["base64"].toString().toLatin1()),
             QByteArray("hello"));
    save(path, "changed contents");
    QVERIFY_EXCEPTION_THROWN(agent->readFile(request), Error);
  }
  void localCitationAliases_data() {
    QTest::addColumn<QString>("format");
    for (const auto &format : {"native", "drive-prefix", "backslashes",
                               "encoded", "file-url", "localhost-url",
                               "line-anchor", "line-column"})
      QTest::newRow(format) << QString(format);
  }
  void localCitationAliases() {
    QFETCH(QString, format);
    auto citation = [&](QString path) {
      if (format == "drive-prefix") {
#ifdef Q_OS_WIN
        path.prepend('/');
#endif
      } else if (format == "backslashes") {
        path.replace('/', '\\');
      } else if (format == "encoded") {
        path = QString::fromLatin1(QUrl::toPercentEncoding(path, "/:()"));
      } else if (format == "file-url" || format == "localhost-url") {
        auto url = QUrl::fromLocalFile(path);
        if (format == "localhost-url")
          url.setHost("localhost");
        path = url.toString(QUrl::FullyEncoded);
      } else if (format == "line-anchor") {
        path += "#L12-L15";
      } else if (format == "line-column") {
        path += ":12:3";
      }
      return path;
    };
    auto path = temp.path() + QString::fromUtf8("/中文 file (1).txt");
    save(path, "citation contents");
    agent->observeFiles(
        "thread-test",
        {{"items", Array{Object{{"type", "agentMessage"},
                                {"text", "[File](<" + citation(path) + ">)"}}}}});
    Object request{{"threadId", "thread-test"}, {"path", path}};
    auto info = agent->readFile(request);
    QCOMPARE(info["size"].toInt(), 17);
    request["version"] = info["version"];
    request["offset"] = 0;
    QCOMPARE(QByteArray::fromBase64(
                 agent->readFile(request)["base64"].toString().toLatin1()),
             QByteArray("citation contents"));
    request["threadId"] = "other-thread";
    QVERIFY_EXCEPTION_THROWN(agent->readFile(request), Error);

    auto imagePath = temp.path() + QString::fromUtf8("/中文 image (1).png");
    save(imagePath, QByteArray::fromHex(
                        "89504e470d0a1a0a00000000000000000000000000000000"));
    auto refs = agent->registerImages(
        "thread-test", {{"type", "agentMessage"},
                        {"text", "![Image](<" + citation(imagePath) + ">)"}});
    QCOMPARE(refs.size(), 1);
    QCOMPARE(agent->readImage("thread-test", refs[0].toObject()["id"].toString())
                 ["mimeType"], QJsonValue("image/png"));
  }
  void literalPercentFileNames() {
    auto path = temp.path() + "/literal%20%23L12.txt";
    save(path, "literal percent");
    auto citation = QString::fromLatin1(QUrl::toPercentEncoding(path, "/:"));
    agent->observeFiles(
        "thread-test",
        {{"items", Array{Object{{"type", "agentMessage"},
                                {"text", "[File](" + citation + ")"}}}}});
    QCOMPARE(agent->readFile({{"threadId", "thread-test"}, {"path", path}})
                 ["name"], QJsonValue("literal%20%23L12.txt"));
    auto imagePath = temp.path() + "/image 100%.png";
    save(imagePath, QByteArray::fromHex(
                        "89504e470d0a1a0a00000000000000000000000000000000"));
    auto refs = agent->registerImages(
        "thread-test", {{"type", "agentMessage"},
                        {"text", "![Image](<" + imagePath + ">)"}});
    QCOMPARE(refs.size(), 1);
    QVERIFY(!agent->readImage("thread-test", refs[0].toObject()["id"].toString())
                 .isEmpty());
  }
  void visualizationPreviewFile() {
    auto path = temp.path() + QString::fromUtf8("/中文 dashboard (1).html");
    const QByteArray html("<button>Preview fixture</button>");
    save(path, html);
    const auto marker = QString::fromUtf8("visualize") +
                        QString::fromUtf8(json(Object{{"path", path},
                                                       {"mode", "wide"}})) +
                        QString::fromUtf8("");
    Object turn{{"items", Array{Object{{"type", "agentMessage"},
                                       {"text", marker}}}}};
    agent->observeFiles("thread-test", turn);
    Object request{{"threadId", "thread-test"}, {"path", path}};
    Object info;
    try { info = agent->readFile(request); }
    catch (const Error &e) { QFAIL(qPrintable(e.code)); }
    QCOMPARE(info["size"].toInt(), html.size());
    request["version"] = info["version"];
    request["offset"] = 0;
    QCOMPARE(QByteArray::fromBase64(
                 agent->readFile(request)["base64"].toString().toLatin1()), html);
    request["threadId"] = "other-thread";
    QVERIFY_EXCEPTION_THROWN(agent->readFile(request), Error);

    auto codeOnly = turn;
    codeOnly["items"] = Array{Object{{"type", "agentMessage"},
                                    {"text", "```text\n" + marker + "\n```"}}};
    agent->observeFiles("code-only", codeOnly);
    QVERIFY(!agent->fileSources["code-only"].contains(path));

    // Both live desktop updates and paginated history use observeFiles after
    // normalization. Exercise each entry point with fresh authorization state.
    auto source = raw();
    Object sourceTurn{{"id", "preview-turn"}, {"turnId", "preview-turn"},
                       {"status", "completed"}};
    sourceTurn["items"] = Array{Object{{"id", "preview-message"},
                                       {"type", "agentMessage"},
                                       {"text", marker}}};
    source["turns"] = Array{sourceTurn};
    agent->fileSources.clear();
    agent->rawThreads["thread-test"] = source;
    agent->updateThread("thread-test");
    QVERIFY(agent->fileSources["thread-test"].contains(path));
    agent->fileSources.clear();
    setFixture({{"turns", Array{sourceTurn}}});
    auto history = agent->history("thread-test", QJsonValue::Null);
    QCOMPARE(history["turns"].toArray().size(), 1);
    QVERIFY(agent->fileSources["thread-test"].contains(path));
  }
  void realVisualizationPreviewReadProbe() {
    const auto fixture = qEnvironmentVariable("CODEXER_PREVIEW_READ_PROBE");
    if (fixture.isEmpty())
      QSKIP("Read-only real preview probe requires explicit fixture path");
    const auto value = parse(read(fixture)).toObject();
    const auto path = value["path"].toString();
    const auto id = value["threadId"].toString();
    QVERIFY(!path.isEmpty() && !id.isEmpty());
    agent->observeFiles(id, {{"items", Array{Object{{"type", "agentMessage"},
                                                   {"text", value["text"]}}}}});
    Object request{{"threadId", id}, {"path", path}};
    auto info = agent->readFile(request);
    request["version"] = info["version"];
    request["offset"] = 0;
    auto file = agent->readFile(request);
    const auto bytes = QByteArray::fromBase64(file["base64"].toString().toLatin1());
    QCOMPARE(bytes, read(path, 256 * 1024));
    save(fixture + ".result.json", json(Object{{"threadId", id}, {"path", path},
         {"bytes", bytes.size()}, {"sha256", hash(bytes)}, {"readOnly", true}}));
  }
  void imagesScopedToThread() {
    QByteArray bytes =
        QByteArray::fromHex("89504e470d0a1a0a00000000000000000000000000000000");
    auto path = temp.path() + "/image.png";
    save(path, bytes);
    auto refs = agent->registerImages(
        "thread-test",
        {{"type", "agentMessage"}, {"text", "![image](<" + path + ">)"}});
    QCOMPARE(refs.size(), 1);
    auto id = refs[0].toObject()["id"].toString();
    QCOMPARE(agent->readImage("thread-test", id)["mimeType"],
             QJsonValue("image/png"));
    QVERIFY_EXCEPTION_THROWN(agent->readImage("other", id), Error);
  }
  void firstConnectionAfterLoadingServerLimit_data() {
    QTest::addColumn<int>("limit");
    QTest::newRow("legacy-no-limit") << 0;
    QTest::newRow("default-limit") << 20;
    QTest::newRow("extended-limit") << 30;
  }
  void firstConnectionAfterLoadingServerLimit() {
    QFETCH(int, limit);
    agent->snapshot = {};
    agent->status();
    QVERIFY(agent->snapshot.isEmpty());
    agent->applyThreadLimit(limit ? QJsonValue(limit) : QJsonValue(QJsonValue::Undefined));
    QVERIFY(agent->snapshot.isEmpty());
    QTcpServer http;
    QWebSocketServer websocket("Synthetic", QWebSocketServer::NonSecureMode);
    QVERIFY(http.listen(QHostAddress::LocalHost, 0));
    QList<Object> received;
    connect(&websocket, &QWebSocketServer::newConnection, &websocket, [&] {
      auto peer = websocket.nextPendingConnection();
      connect(peer, &QWebSocket::textMessageReceived, &websocket, [&](QString text) {
        received.append(parse(text.toUtf8()).toObject());
      });
      Object welcome{{"type", "device.welcome"}, {"features", Array{"catalog"}}};
      if (limit) welcome["threadLimit"] = limit;
      peer->sendTextMessage(QString::fromUtf8(json(welcome)));
    });
    connect(&http, &QTcpServer::newConnection, &http, [&] {
      auto peer = http.nextPendingConnection();
      auto handler = std::make_shared<QMetaObject::Connection>();
      *handler = connect(peer, &QTcpSocket::readyRead, peer, [&, peer, handler] {
        const auto request = peer->peek(peer->bytesAvailable());
        if (!request.contains("\r\n\r\n")) return;
        disconnect(*handler);
        if (request.startsWith("GET /v1/ws/device ")) {
          websocket.handleConnection(peer);
          return;
        }
        peer->readAll();
        Object result{{"release", QJsonValue::Null}};
        if (request.startsWith("GET /v1/agent/")) {
          result = {{"active", true}};
          if (limit) result["threadLimit"] = limit;
        }
        const auto body = json(result);
        peer->write("HTTP/1.1 200 OK\r\nContent-Length: " + QByteArray::number(body.size()) +
                    "\r\nConnection: close\r\n\r\n" + body);
        peer->disconnectFromHost();
        connect(peer, &QTcpSocket::disconnected, peer, &QObject::deleteLater);
      });
    });
    agent->credentials["relayUrl"] = "http://127.0.0.1:" + QString::number(http.serverPort());
    QString previousEpoch;
    for (int attempt = 0; attempt < 2; ++attempt) {
      received.clear();
      try {
        agent->connectAgent();
      } catch (const Error &error) {
        QFAIL(qPrintable(error.code));
      }
      QVERIFY(waitFor([&] { return !received.isEmpty(); }, 3000));
      QCOMPARE(received.first()["type"], QJsonValue("device.snapshot"));
      const auto state = received.first()["snapshot"].toObject();
      QCOMPARE(state["deviceId"], agent->credentials["deviceId"]);
      QCOMPARE(state["protocolVersion"], QJsonValue(1));
      QCOMPARE(state["agentVersion"], QJsonValue(CODEXER_AGENT_VERSION));
      QVERIFY(!state["hostname"].toString().isEmpty());
      QVERIFY(!state["epoch"].toString().isEmpty());
      QVERIFY(state["epoch"].toString() != previousEpoch);
      QVERIFY(state["threads"].isObject());
      QVERIFY(state["runtime"].toObject()["capabilities"].isObject());
      QVERIFY(!agent->paused);
      QCOMPARE(agent->threadLimit, limit ? limit : DefaultSyncedThreads);
      previousEpoch = state["epoch"].toString();
      agent->closeAgent();
      QVERIFY(agent->snapshot.isEmpty());
    }
  }
  void relaySnapshotAndReconnect() {
    QWebSocketServer server("Synthetic", QWebSocketServer::NonSecureMode);
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));
    agent->credentials["relayUrl"] =
        "http://127.0.0.1:" + QString::number(server.serverPort());
    QList<Object> received;
    QWebSocket *peer = nullptr;
    connect(&server, &QWebSocketServer::newConnection, &server, [&] {
      peer = server.nextPendingConnection();
      connect(peer, &QWebSocket::textMessageReceived, &server, [&](QString s) {
        received.append(parse(s.toUtf8()).toObject());
      });
    });
    agent->connectRelay();
    QVERIFY(waitFor([&] { return !received.isEmpty(); }, 3000));
    QCOMPARE(received.first()["type"], QJsonValue("device.snapshot"));
    peer->sendTextMessage(QString::fromUtf8(json(Object{
        {"type", "device.welcome"},
        {"features", Array{"files", "previews", "catalog", "attachments"}}})));
    QVERIFY(waitFor([&] { return received.size() >= 3; }, 3000));
    QVERIFY(agent->snapshot["runtime"]
                .toObject()["capabilities"]
                .toObject()["attachments"]
                .toBool());
    agent->pause();
    QVERIFY(agent->paused);
  }

  void continueCommandThroughRelay_data() {
    QTest::addColumn<bool>("onDesktop");
    QTest::newRow("app-server") << false;
    QTest::newRow("desktop") << true;
  }
  void continueCommandThroughRelay() {
    QFETCH(bool, onDesktop);
    const auto stopped = Object{{"id", "stopped"}, {"status", "interrupted"},
                                {"items", Array{}}};
    std::unique_ptr<DesktopFixture> desktopFixture;
    if (onDesktop) {
      auto state = raw();
      state["turns"] = Array{stopped};
      desktopFixture = std::make_unique<DesktopFixture>(state);
      qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", desktopFixture->endpoint.toUtf8());
      agent->settings["runtime"] = "auto";
      agent->desktop->open(agent->settings);
      QVERIFY(agent->desktop->follow("thread-test"));
      QVERIFY(waitFor([&] { return agent->desktop->watched["thread-test"].compatible; }, 1000));
    } else {
      setFixture({{"turns", Array{stopped}}});
    }
    agent->refreshCatalog();
    agent->watch("thread-test");

    QWebSocketServer server("Synthetic", QWebSocketServer::NonSecureMode);
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));
    QList<Object> received;
    QWebSocket *peer = nullptr;
    connect(&server, &QWebSocketServer::newConnection, &server, [&] {
      peer = server.nextPendingConnection();
      connect(peer, &QWebSocket::textMessageReceived, &server, [&](QString text) {
        received.append(parse(text.toUtf8()).toObject());
      });
    });
    agent->credentials["relayUrl"] =
        "http://127.0.0.1:" + QString::number(server.serverPort());
    agent->connectRelay();
    QVERIFY(waitFor([&] { return !received.isEmpty(); }, 3000));
    auto cmd = command("turn.continue");
    cmd["payload"] = Object{{"type", "turn.continue"},
                            {"threadId", "thread-test"}, {"turnId", "stopped"}};
    const auto wire = QString::fromUtf8(json(Object{{"type", "command"}, {"command", cmd}}));
    for (int delivery = 1; delivery <= 2; ++delivery) {
      peer->sendTextMessage(wire);
      QVERIFY(waitFor([&] { return !agent->commandQueue.isEmpty() || agent->paused; }, 3000));
      QVERIFY(!agent->paused);
      QCOMPARE(agent->relay->state(), QAbstractSocket::ConnectedState);
      QCOMPARE(agent->commandQueue.size(), 1);
      agent->tick();
      QVERIFY(waitFor([&] {
        return std::count_if(received.begin(), received.end(), [&](const Object &message) {
          return message["type"] == "command.result" &&
                 message["result"].toObject()["commandId"] == cmd["commandId"];
        }) == delivery;
      }, 3000));
      const auto result = std::find_if(received.crbegin(), received.crend(), [&](const Object &message) {
        return message["type"] == "command.result" &&
               message["result"].toObject()["commandId"] == cmd["commandId"];
      })->value("result").toObject();
      QCOMPARE(result["status"], QJsonValue("succeeded"));
      QCOMPARE(result["result"].toObject()["turnId"],
               QJsonValue(onDesktop ? "desktop-turn" : "turn-new"));
      QVERIFY(!agent->paused);
      QCOMPARE(agent->relay->state(), QAbstractSocket::ConnectedState);
    }
    QList<Object> requests;
    if (onDesktop) {
      requests = desktopFixture->requests;
    } else {
      for (const auto &line : read(temp.path() + "/requests.jsonl").split('\n'))
        if (!line.isEmpty())
          requests.append(parse(line).toObject());
    }
    int starts = 0;
    for (const auto &request : requests) {
      if (request["method"] != (onDesktop ? "thread-follower-start-turn" : "turn/start"))
        continue;
      ++starts;
      const auto params = request["params"].toObject();
      QCOMPARE(onDesktop ? params["turnStart"].toObject()["request"].toObject()["input"]
                         : params["input"], QJsonValue(Array{}));
    }
    QCOMPARE(starts, 1);
    agent->pause();
  }

  void createAtCapacityKeepsOrderedBoundedWireState() {
    agent->refreshCatalog();
    fillPreviews();
    QWebSocketServer server("Synthetic", QWebSocketServer::NonSecureMode);
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));
    QList<Object> received;
    connect(&server,&QWebSocketServer::newConnection,&server,[&] {
      auto peer=server.nextPendingConnection();
      connect(peer,&QWebSocket::textMessageReceived,&server,[&](QString text) {
        received.append(parse(text.toUtf8()).toObject());
      });
    });
    agent->credentials["relayUrl"]="http://127.0.0.1:"+QString::number(server.serverPort());
    agent->connectRelay();
    QVERIFY(waitFor([&]{return !received.isEmpty();},3000));
    auto cmd=command("thread.create");
    cmd["payload"]=Object{{"type","thread.create"},{"projectId","project-test"}};
    agent->processCommand(cmd);
    QVERIFY(waitFor([&]{return received.last()["type"]=="command.result";},3000));
    QCOMPARE(received.last()["result"].toObject()["status"],QJsonValue("succeeded"));
    auto state=received.first()["snapshot"].toObject();
    auto threads=state["threads"].toObject();
    qint64 sequence=state["lastSeq"].toInteger();
    QStringList changes;
    for (const auto &message:received) {
      if(message["type"]!="device.event") continue;
      auto event=message["event"].toObject(),change=event["change"].toObject();
      QCOMPARE(event["seq"].toInteger(),++sequence);
      const auto type=change["type"].toString(); changes.append(type);
      if(type=="thread.removed") threads.remove(change["threadId"].toString());
      if(type=="thread.updated") {auto t=change["thread"].toObject();threads[t["id"].toString()]=t;}
      QVERIFY(threads.size()<=DefaultSyncedThreads);
    }
    QCOMPARE(changes,QStringList({"thread.removed","thread.updated"}));
    QVERIFY(!threads.contains("preview-00"));
    QVERIFY(threads.contains("created-thread-1"));
    QVERIFY(!agent->rawThreads.contains("preview-00"));
    QVERIFY(!agent->dirtyThreads.contains("preview-00"));
    bool inCatalog=false;
    for(const auto &t:agent->catalog["threads"].toArray()) inCatalog|=t.toObject()["id"]=="preview-00";
    QVERIFY(inCatalog);
    QVERIFY(!agent->paused);
    QCOMPARE(agent->relay->state(),QAbstractSocket::ConnectedState);
    const auto requests=read(temp.path()+"/requests.jsonl");
    agent->processCommand(cmd);
    QCOMPARE(read(temp.path()+"/requests.jsonl"),requests);
    QVERIFY(!requests.contains("thread/delete"));
    agent->pause();
  }
  void protectedPreviewsAreNotEvicted_data() {
    QTest::addColumn<QString>("protection");
    for(const auto &value:QStringList{"active","active-id","request","pending-request","subagent","queue","stored-queue","owned","new","awaiting"})
      QTest::newRow(qPrintable(value))<<value;
  }
  void protectedPreviewsAreNotEvicted() {
    QFETCH(QString,protection);
    fillPreviews();
    auto threads=agent->snapshot["threads"].toObject(), t=threads["preview-00"].toObject();
    if(protection=="active") t["status"]="active";
    if(protection=="active-id") t["activeTurnId"]="turn";
    if(protection=="request") t["requests"]=Array{Object{{"id","approval"}}};
    if(protection=="pending-request") agent->pendingRequests["request"]={{"params",Object{{"threadId","preview-00"}}}};
    if(protection=="subagent") t["subAgents"]=Array{Object{{"status","running"}}};
    if(protection=="queue") t["queuedMessages"]=Array{Object{{"id","queued"}}};
    if(protection=="stored-queue") sql(agent->journal,"INSERT INTO queued_messages(id,thread_id,text,images,created_at,status) VALUES('pending','preview-00','prompt','[]',1,'queued')");
    if(protection=="owned") agent->owned.insert("preview-00");
    if(protection=="new") agent->newThreads.insert("preview-00");
    if(protection=="awaiting") agent->awaitingQueue.insert("preview-00");
    threads["preview-00"]=t;agent->snapshot["threads"]=threads;
    auto source=raw();source["id"]="extra";
    agent->commit({{"type","thread.updated"},{"thread",normalizeThread(source,0)}});
    threads=agent->snapshot["threads"].toObject();
    QVERIFY(threads.contains("preview-00"));
    QVERIFY(!threads.contains("preview-01"));
    QVERIFY(threads.contains("extra"));
    QCOMPARE(threads.size(),DefaultSyncedThreads);
  }
  void allProtectedRefusesBeforeCreatingAndKeepsExistingUpdates() {
    agent->refreshCatalog();fillPreviews();
    for(const auto &id:agent->snapshot["threads"].toObject().keys()) agent->owned.insert(id);
    const auto before=agent->snapshot;
    auto cmd=command("thread.create");cmd["payload"]=Object{{"type","thread.create"},{"projectId","project-test"}};
    agent->processCommand(cmd);
    QCOMPARE(agent->snapshot,before);
    QVERIFY(!read(temp.path()+"/requests.jsonl").contains("thread/start"));
    auto q=sql(agent->journal,"SELECT result FROM native_commands");QVERIFY(q.next());
    auto result=parse(q.value(0).toByteArray()).toObject();
    QCOMPARE(result["status"],QJsonValue("failed"));QCOMPARE(result["code"],QJsonValue("thread-limit"));
    auto source=raw();source["id"]="extra";
    QVERIFY_EXCEPTION_THROWN(agent->commit({{"type","thread.updated"},{"thread",normalizeThread(source,0)}}),Error);
    QCOMPARE(agent->snapshot,before);
    auto existing=before["threads"].toObject()["preview-00"].toObject();existing["title"]="changed";
    agent->commit({{"type","thread.updated"},{"thread",existing}});
    QCOMPARE(agent->snapshot["lastSeq"].toInteger(),before["lastSeq"].toInteger()+1);
    QVERIFY(!agent->paused);
  }
  void liveThreadLimitChangesKeepProtectedTasks() {
    fillPreviews();
    agent->relayMessage({{"type","device.settings"},{"threadLimit",30}});
    QCOMPARE(agent->threadLimit,30);
    for(int i=0;i<10;++i) {auto source=raw();source["id"]="extra-"+QString::number(i);agent->commit({{"type","thread.updated"},{"thread",normalizeThread(source,0)}});}
    QCOMPARE(agent->snapshot["threads"].toObject().size(),30);
    agent->owned.insert("preview-00");agent->owned.insert("preview-01");
    agent->relayMessage({{"type","device.settings"},{"threadLimit",1}});
    QCOMPARE(agent->snapshot["threads"].toObject().size(),2);
    QVERIFY_EXCEPTION_THROWN(agent->ensureThreadSlot(),Error);
    agent->owned.remove("preview-01");
    QVERIFY(agent->trimThreadPreviews(agent->threadLimit));
    QCOMPARE(agent->snapshot["threads"].toObject().size(),1);
    QVERIFY(agent->snapshot["threads"].toObject().contains("preview-00"));
    for(const auto &bad:Array{0,31,1.5,"30",QJsonValue::Null}) QVERIFY_EXCEPTION_THROWN(agent->applyThreadLimit(bad),Error);
    QCOMPARE(agent->threadLimit,1);
  }

  void settingsRejectionDoesNotChangeLocalPolicy() {
    setFixture({{"rejectSettings", true}});
    agent->refreshCatalog();
    agent->watch("thread-test");
    const auto before = agent->effectiveSettings["thread-test"];
    auto cmd = command("thread.effort.update");
    auto p = cmd["payload"].toObject();
    p["expectedModel"] = "synthetic-model";
    p["expectedEffort"] = "medium";
    p["effort"] = "high";
    cmd["payload"] = p;
    QVERIFY_EXCEPTION_THROWN(agent->execute(cmd), Error);
    QCOMPARE(agent->effectiveSettings["thread-test"]["effort"],
             before["effort"]);
  }
  void activeSettingsDoNotResumeOrInterruptTheWriter() {
    agent->refreshCatalog();
    agent->watch("thread-test");
    agent->resume("thread-test");
    auto threads = agent->snapshot["threads"].toObject();
    auto thread = threads["thread-test"].toObject();
    thread["status"] = "active";
    thread["activeTurnId"] = "turn";
    threads["thread-test"] = thread;
    agent->snapshot["threads"] = threads;
    const auto before = read(temp.path() + "/requests.jsonl");
    auto cmd = command("thread.effort.update");
    cmd["payload"] = Object{{"type", "thread.effort.update"},
                            {"threadId", "thread-test"},
                            {"expectedModel", "synthetic-model"},
                            {"expectedEffort", "medium"}, {"effort", "high"}};
    QVERIFY(agent->executeTurn(cmd, {}, false)["acknowledgedByAppServer"].toBool());
    auto p = Object{{"type", "thread.permissions.update"},
                    {"threadId", "thread-test"}, {"mode", "read-only"},
                    {"expectedPermissions", permissionSettings(agent->effectiveSettings["thread-test"])["fingerprint"]}};
    cmd["payload"] = p;
    QVERIFY(agent->executeTurn(cmd, {}, false)["acknowledgedByAppServer"].toBool());
    const auto added = read(temp.path() + "/requests.jsonl").mid(before.size());
    QVERIFY(added.contains("thread/settings/update"));
    QVERIFY(!added.contains("thread/resume"));
    QVERIFY(!added.contains("turn/interrupt"));
    agent->owned.remove("thread-test");
    QVERIFY_EXCEPTION_THROWN(agent->executeTurn(cmd, {}, false), Error);
    QCOMPARE(read(temp.path() + "/requests.jsonl").mid(before.size()), added);
  }
  void continueInterruptedTurnWithNoUserText() {
    setFixture({{"turns", Array{Object{{"id", "stopped"},
                                      {"status", "interrupted"}, {"items", Array{}}}}}});
    agent->refreshCatalog();
    agent->watch("thread-test");
    auto cmd = command("turn.continue");
    cmd["payload"] = Object{{"type", "turn.continue"},
                            {"threadId", "thread-test"}, {"turnId", "stopped"}};
    QCOMPARE(agent->execute(cmd)["turnId"], QJsonValue("turn-new"));
    int starts = 0;
    for (const auto &line : read(temp.path() + "/requests.jsonl").split('\n')) {
      if (line.isEmpty()) continue;
      const auto req = parse(line).toObject();
      if (req["method"] != "turn/start") continue;
      ++starts;
      QCOMPARE(req["params"].toObject()["input"].toArray(), Array{});
    }
    QCOMPARE(starts, 1);
    auto payload = cmd["payload"].toObject();
    payload["turnId"] = "different-turn";
    cmd["payload"] = payload;
    const auto before = read(temp.path() + "/requests.jsonl");
    QVERIFY_EXCEPTION_THROWN(agent->executeTurn(cmd, {}, false), Error);
    QCOMPARE(read(temp.path() + "/requests.jsonl"), before);
  }
  void permissionsRequireActualConfirmation() {
    agent->refreshCatalog();
    agent->watch("thread-test");
    auto cmd = command("thread.permissions.update");
    auto p = cmd["payload"].toObject();
    p["mode"] = "full-access";
    p["expectedPermissions"] = permissionSettings(
        agent->effectiveSettings["thread-test"])["fingerprint"];
    cmd["payload"] = p;
    auto result = agent->execute(cmd);
    QCOMPARE(result["permissions"].toObject()["mode"],
             QJsonValue("full-access"));
    agent->watch("thread-test");
    p["mode"] = "read-only";
    p["expectedPermissions"] = permissionSettings(
        agent->effectiveSettings["thread-test"])["fingerprint"];
    cmd["payload"] = p;
    auto resume = fixtureState()["resume"].toObject();
    resume["sandbox"] = Object{{"type", "dangerFullAccess"}};
    resume["approvalPolicy"] = "never";
    setFixture({{"omitSettingsAck", true}, {"resume", resume}});
    try {
      agent->execute(cmd);
      QFAIL("unconfirmed permissions must not succeed");
    } catch (const Error &e) {
      QCOMPARE(e.code, QString("permissions-update-unconfirmed"));
      QVERIFY(e.uncertain);
    }
    QCOMPARE(
        permissionSettings(agent->effectiveSettings["thread-test"])["mode"],
        QJsonValue("full-access"));
  }
  void rejectsResumeWithMissingWritableRoot() {
    auto state = fixtureState();
    auto response = state["resume"].toObject();
    response["sandbox"] =
        Object{{"type", "workspaceWrite"},
               {"writableRoots", Array{temp.path() + "/different"}}};
    setFixture({{"resume", response}});
    agent->refreshCatalog();
    QVERIFY_EXCEPTION_THROWN(agent->execute(command()), Error);
    QVERIFY(!read(temp.path() + "/requests.jsonl").contains("turn/start"));
  }
  void requestApprovalAndDuplicateResponse() {
    agent->refreshCatalog();
    agent->watch("thread-test");
    Object request{
        {"id", 42},
        {"method", "item/commandExecution/requestApproval"},
        {"params", Object{{"threadId", "thread-test"},
                          {"turnId", "turn"},
                          {"availableDecisions", Array{"accept", "decline"}}}}};
    agent->pendingRequests["42"] = request;
    auto rawThread = raw();
    rawThread["threadRuntimeStatus"] = Object{{"type", "active"}};
    rawThread["turns"] = Array{
        Object{{"id", "turn"}, {"status", "inProgress"}, {"items", Array{}}}};
    rawThread["requests"] = Array{request};
    agent->rawThreads["thread-test"] = rawThread;
    agent->updateThread("thread-test");
    auto cmd = command("approval.respond");
    cmd["payload"] = Object{{"type", "approval.respond"},
                            {"threadId", "thread-test"},
                            {"turnId", "turn"},
                            {"requestId", "42"},
                            {"decision", "accept"}};
    QVERIFY(
        agent->executeTurn(cmd, {}, false)["acknowledgedByAppServer"].toBool());
    agent->pendingRequests["42"] = request;
    QVERIFY_EXCEPTION_THROWN(agent->executeTurn(cmd, {}, false), Error);
  }
  void timingJoinedByItemId() {
    setFixture({{"itemEntries", Array{Object{{"turnId", "turn"},
                                             {"item", Object{{"id", "b"}}},
                                             {"startedAtMs", 200},
                                             {"completedAtMs", 300}},
                                      Object{{"turnId", "turn"},
                                             {"item", Object{{"id", "a"}}},
                                             {"startedAtMs", 100},
                                             {"completedAtMs", 150}}}}});
    agent->ensureRpc();
    auto turn = agent->timedTurn(
        "thread-test",
        {{"id", "turn"},
         {"items", Array{Object{{"id", "a"}}, Object{{"id", "b"}}}}},
        true);
    QCOMPARE(
        turn["itemTimingsById"].toObject()["a"].toObject()["completedAtMs"],
        QJsonValue(150));
  }
  void legacyCommandsNeverExecuteAgain() {
    auto cmd = command();
    auto key =
        QString::fromUtf8(json(Array{cmd["deviceId"], cmd["commandId"]}));
    sql(agent->journal,
        "INSERT INTO commands(key,hash,state,result) VALUES(?,?,'succeeded',?)",
        {key, "old-json-key-order", json(Object{{"status", "succeeded"}})});
    agent->processCommand(cmd);
    QVERIFY(!agent->rpc);
  }
  void persistentQueueDoesNotResendSendingRows() {
    sql(agent->journal,
        "INSERT INTO "
        "queued_messages(id,thread_id,text,images,attachments,created_at,"
        "status) VALUES('queue','thread-test','hello','[]','[]',1,'sending')");
    auto credentials = agent->credentials;
    agent->closeAgent();
    agent->credentials = credentials;
    agent->openJournal();
    auto rows = agent->queued("thread-test");
    QCOMPARE(rows.size(), 1);
    QCOMPARE(rows[0].toObject()["status"], QJsonValue("failed"));
  }
  void nativeProjectCreateAndDelete() {
    QTemporaryDir projects;
    QVERIFY(projects.isValid());
    agent->settings["projectParents"] = Array{projects.path()};
    setFixture({{"threadList", Array{}}, {"projects", Array{}}});
    agent->refreshCatalog();
    auto parent = agent->catalog["projectCreation"]
                      .toObject()["parents"]
                      .toArray()[0]
                      .toObject()["id"];
    auto cmd = command("project.create");
    cmd["payload"] = Object{{"type", "project.create"},
                            {"parentId", parent},
                            {"name", "Sample"},
                            {"relativePath", "new-project"},
                            {"mode", "new"}};
    auto created = agent->project(cmd);
    QCOMPARE(created["projectId"], QJsonValue("created-project"));
    QVERIFY(QFileInfo(projects.path() + "/new-project").isDir());
    save(projects.path() + "/new-project/owned.txt", "isolated fixture");
    cmd["payload"] = Object{{"type", "project.delete.prepare"},
                            {"projectId", "created-project"}};
    auto plan = agent->project(cmd);
    QVERIFY(plan["directoryDeletion"].toBool());
    cmd["payload"] = Object{{"type", "project.delete"},
                            {"projectId", "created-project"},
                            {"token", plan["token"]},
                            {"deleteDirectory", true}};
    auto deleted = agent->project(cmd);
    QVERIFY(deleted["directoryDeleted"].toBool());
    QVERIFY(!QFileInfo::exists(projects.path() + "/new-project"));
  }
  void projectDeletionRejectsNonemptyAndProtected() {
    agent->refreshCatalog();
    auto cmd = command("project.delete.prepare");
    cmd["payload"] = Object{{"type", "project.delete.prepare"},
                            {"projectId", "project-test"}};
    QVERIFY_EXCEPTION_THROWN(agent->project(cmd), Error);
    setFixture({{"threadList", Array{}}});
    auto plan = agent->project(cmd);
    QVERIFY(!plan["directoryDeletion"].toBool());
    QVERIFY(QFileInfo(temp.path()).isDir());
  }
  void projectDeletionPinsIdentity() {
    QTemporaryDir projects;
    auto path = projects.path() + "/target";
    QDir().mkdir(path);
    setFixture({{"threadList", Array{}},
                {"projects",
                 Array{Object{{"id", "project-test"},
                              {"name", "Target"},
                              {"roots", Array{Object{{"path", path}}}}}}}});
    agent->refreshCatalog();
    auto cmd = command("project.delete.prepare");
    cmd["payload"] = Object{{"type", "project.delete.prepare"},
                            {"projectId", "project-test"}};
    auto plan = agent->project(cmd);
    QVERIFY(plan["directoryDeletion"].toBool());
    QVERIFY(QDir().rename(path, path + "-original"));
    QVERIFY(QDir().mkdir(path));
    save(path + "/keep.txt", "must survive");
    cmd["payload"] = Object{{"type", "project.delete"},
                            {"projectId", "project-test"},
                            {"token", plan["token"]},
                            {"deleteDirectory", true}};
    QVERIFY_EXCEPTION_THROWN(agent->project(cmd), Error);
    QVERIFY(QFileInfo::exists(path + "/keep.txt"));
  }
  void updateDownloadUsesReleaseIdAndVerifiesHash() {
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));
    QByteArray package = "synthetic installer bytes";
    auto releaseId = uuid();
    QStringList paths;
    Object release{{"id", releaseId},
                   {"target", "agent-windows-x64-setup"},
                   {"name", "Sample.exe"},
                   {"version", "99.0.0"},
                   {"buildNumber", 1},
                   {"notes", ""},
                   {"size", package.size()},
                   {"sha256", hash(package)},
                   {"uploadedAt", double(now())}};
    connect(&server, &QTcpServer::newConnection, &server, [&] {
      auto peer = server.nextPendingConnection();
      auto buffer = std::make_shared<QByteArray>();
      connect(peer, &QTcpSocket::readyRead, peer, [&, peer, buffer] {
        buffer->append(peer->readAll());
        if (!buffer->contains("\r\n\r\n"))
          return;
        auto path = QString::fromUtf8(buffer->split(' ')[1]);
        paths << path;
        auto body = path.endsWith("/download")
                        ? package
                        : json(Object{{"release", release}});
        peer->write("HTTP/1.1 200 OK\r\nContent-Length: " +
                    QByteArray::number(body.size()) +
                    "\r\nConnection: close\r\n\r\n" + body);
        peer->disconnectFromHost();
      });
      connect(peer, &QTcpSocket::disconnected, peer, &QObject::deleteLater);
    });
    agent->credentials["relayUrl"] =
        "http://127.0.0.1:" + QString::number(server.serverPort());
    agent->checkUpdate();
    QVERIFY(agent->updateState["available"].toBool());
    agent->downloadUpdate();
    QVERIFY(waitFor([&] { return !agent->download; }, 5000));
    QVERIFY(agent->updateState["downloaded"].toBool());
    QCOMPARE(read(agent->downloadedPath), package);
    QVERIFY(paths.contains("/v1/client-releases/agent-windows-x64-setup/" +
                           releaseId + "/download"));
    release["sha256"] = QString(64, '0');
    agent->checkUpdate();
    agent->downloadUpdate();
    QVERIFY(waitFor([&] { return !agent->download; }, 5000));
    QVERIFY(!agent->updateState["downloaded"].toBool());
  }

  void desktopUsageCollectedBeforeDisplayBatching() {
    const auto initial = usageState("old", false, counts(1000, 100, 500));
    DesktopFixture fixture(initial);
    qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
    agent->settings["runtime"] = "auto";
    agent->desktop->open(agent->settings);
    QVERIFY(agent->desktop->follow("thread-test"));
    QVERIFY(waitFor([&] { return agent->desktop->watched["thread-test"].compatible; }, 1000));
    agent->watch("thread-test"); // Initial snapshot arrived before watch membership.
    const auto seq = agent->snapshot["lastSeq"].toInteger();
    auto change = [](Array path, QJsonValue value) {
      return Object{{"op", "replace"}, {"path", path}, {"value", value}};
    };
    fixture.patch({change({"threadRuntimeStatus", "type"}, "active"),
        change({"turns"}, usageState("new", true, {})["turns"])}, 0, 1);
    fixture.patch({change({"latestTokenUsageInfo"}, Object{{"total", counts(1500, 130, 900)},
        {"last", counts(500, 30, 400)}})}, 1, 2);
    fixture.patch({change({"latestTokenUsageInfo"}, Object{{"total", counts(1900, 150, 1200)},
        {"last", counts(400, 20, 300)}})}, 2, 3);
    fixture.patch({change({"threadRuntimeStatus", "type"}, "idle"),
        change({"turns"}, usageState("new", false, {})["turns"])}, 3, 4);
    QVERIFY(waitFor([&] { return agent->desktop->watched["thread-test"].revision == 4; }, 1000));
    // No display update/timer has run; every raw IPC patch was observed.
    QCOMPARE(agent->snapshot["lastSeq"].toInteger(), seq);
    const auto saved = agent->usageRecord("thread-test", "new");
    QCOMPARE(saved["inputTokens"], QJsonValue(900));
    QCOMPARE(saved["outputTokens"], QJsonValue(50));
    QCOMPARE(saved["cachedInputTokens"], QJsonValue(700));
    QCOMPARE(saved["state"], QJsonValue("complete"));
    QCOMPARE(saved["model"], QJsonValue("model-a"));
    QVERIFY(agent->usageRecord("thread-test", "old").isEmpty());
    agent->updateThread("thread-test");
    const auto live = agent->snapshot["threads"].toObject()["thread-test"].toObject();
    QCOMPARE(live["turns"].toArray().last().toObject()["tokenUsage"], QJsonValue(saved));
    setFixture({{"turns", Array{Object{{"id", "new"}, {"status", "completed"}, {"items", Array{}}}}}});
    QCOMPARE(agent->history("thread-test", QJsonValue::Null)["turns"].toArray()[0].toObject()["tokenUsage"], QJsonValue(saved));
    fixture.snapshot();
    QVERIFY(waitFor([&] { return agent->desktop->watched["thread-test"].revision == 0; }, 1000));
    QCOMPARE(agent->usageRecord("thread-test", "new"), saved);
  }
  void desktopUsageTemporaryIdentityAndCanonicalHistory() {
    desktopUsage(usageState("old", false, counts(1000, 100, 500)));
    auto temporary = usageState("", true, counts(1000, 100, 500));
    desktopUsage(temporary);
    desktopUsage(usageState("new", true, counts(1000, 100, 500)));
    auto canonical = usageState("new", false, counts(1500, 130, 900));
    const auto turns = canonical.take("turns").toArray();
    canonical["turnHistory"] = Object{{"kind", "canonical"}, {"history", Object{
        {"entitiesByKey", Object{{"a", turns[0]}, {"b", turns[1]}}},
        {"islands", Array{Object{{"entries", Array{Object{{"value", "a"}}, Object{{"value", "b"}}}}}}}}}};
    desktopUsage(canonical);
    const auto saved = agent->usageRecord("thread-test", "new");
    QCOMPARE(saved["inputTokens"], QJsonValue(500));
    QCOMPARE(saved["state"], QJsonValue("complete"));
    QVERIFY(agent->usageRecord("thread-test", "unknown").isEmpty());
  }
  void desktopUsageMidTurnAndConnectionGap() {
    desktopUsage(usageState("new", true, counts(1500, 130, 900)));
    QVERIFY(agent->usageRecord("thread-test", "new").isEmpty());
    desktopUsage(usageState("new", true, counts(1900, 150, 1200)));
    agent->desktop->watched["thread-test"].compatible = false;
    emit agent->desktop->threadChanged("thread-test");
    QVERIFY(!agent->usageObservations.contains("thread-test"));
    desktopUsage(usageState("new", true, counts(2500, 180, 1600)));
    desktopUsage(usageState("new", false, counts(2700, 190, 1700)));
    const auto saved = agent->usageRecord("thread-test", "new");
    QCOMPARE(saved["inputTokens"], QJsonValue(600));
    QCOMPARE(saved["outputTokens"], QJsonValue(30));
    QCOMPARE(saved["state"], QJsonValue("partial"));
  }
  void desktopUsageSkippedTurnsAndCounterReset() {
    desktopUsage(usageState("old", false, counts(1000, 100, 500)));
    desktopUsage(usageState("new", true, counts(1900, 150, 1200), "skipped"));
    QVERIFY(agent->usageRecord("thread-test", "new").isEmpty());
    desktopUsage(usageState("new", true, counts(2000, 160, 1250), "skipped"));
    desktopUsage(usageState("new", true, counts(100, 10, 50), "skipped"));
    desktopUsage(usageState("new", false, counts(200, 20, 100), "skipped"));
    const auto saved = agent->usageRecord("thread-test", "new");
    QCOMPARE(saved["inputTokens"], QJsonValue(200));
    QCOMPARE(saved["outputTokens"], QJsonValue(20));
    QCOMPARE(saved["cachedInputTokens"], QJsonValue(100));
    QCOMPARE(saved["state"], QJsonValue("partial"));
  }
  void notificationUsageTurnIdentityAndDuplicates() {
    agent->ensureRpc();
    auto notify = [&](QString method, Object params) {
      params["threadId"] = "thread-test";
      emit agent->rpc->notification(method, params);
    };
    agent->rawThreads["thread-test"] = usageState("new", true, {});
    notify("turn/started", {{"turn", Object{{"id", "new"}}}});
    const Object first{{"total", counts(1500, 130, 900)}, {"last", counts(500, 30, 400)}};
    notify("thread/tokenUsage/updated", {{"turnId", "new"}, {"tokenUsage", first}});
    notify("turn/started", {{"turn", Object{{"id", "new"}}}}); // Duplicate start.
    notify("thread/tokenUsage/updated", {{"turnId", "new"}, {"tokenUsage", first}});
    notify("thread/tokenUsage/updated", {{"turnId", "other"}, {"tokenUsage", Object{{"total", counts(1600, 140, 950)}}}});
    notify("thread/tokenUsage/updated", {{"turnId", "new"}, {"tokenUsage", Object{{"total", counts(1900, 150, 1200)}}}});
    notify("turn/completed", {{"turn", Object{{"id", "other"}}}});
    QCOMPARE(agent->usageRecord("thread-test", "new")["state"], QJsonValue("running"));
    notify("turn/completed", {{"turn", Object{{"id", "new"}}}});
    const auto saved = agent->usageRecord("thread-test", "new");
    QCOMPARE(saved["inputTokens"], QJsonValue(900));
    QCOMPARE(saved["outputTokens"], QJsonValue(50));
    QCOMPARE(saved["state"], QJsonValue("complete"));
    notify("thread/tokenUsage/updated", {{"turnId", "new"}, {"tokenUsage", Object{{"total", counts(1900, 150, 1200)}}}});
    QCOMPARE(agent->usageRecord("thread-test", "new"), saved);
    QVERIFY(agent->usageRecord("thread-test", "other").isEmpty());
  }
  void projectUsageIncludesArchivedUnloadedAndIsReadOnly() {
    QTemporaryDir index;
    QVERIFY(index.isValid());
    agent->settings["codexHome"] = index.path();
    auto writeIndex = [&](const QString &name, double current) {
      const auto connection = uuid();
      {
        auto db = QSqlDatabase::addDatabase("QSQLITE", connection);
        db.setDatabaseName(index.filePath(name));
        if (!db.open()) throw Error("fixture-index-open");
        sql(db, "CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,tokens_used INTEGER)");
        for (const auto &row : Array{Array{"current", current}, Array{"archived", 4000},
              Array{"other", 700}, Array{"unassigned", 50}, Array{"not-in-catalog", 9999}}) {
          const auto values = row.toArray();
          sql(db, "INSERT OR REPLACE INTO threads VALUES(?,?)",
              {values[0].toVariant(), values[1].toVariant()});
        }
        db.close();
      }
      QSqlDatabase::removeDatabase(connection);
    };
    writeIndex("state_2.sqlite", 1);
    writeIndex("state_10.sqlite", 1000);
    const auto before = read(index.filePath("state_10.sqlite"));
    agent->catalog = {{"projects", Array{Object{{"id", "p"}}, Object{{"id", "q"}}, Object{{"id", "empty"}}}},
        {"threads", Array{Object{{"id", "current"}, {"projectId", "p"}},
          Object{{"id", "archived"}, {"projectId", "p"}, {"archived", true}},
          Object{{"id", "other"}, {"projectId", "q"}},
          Object{{"id", "unassigned"}, {"projectId", QJsonValue::Null}}}}};
    auto record = counts(500, 100, 400);
    record["state"] = "complete";
    record["model"] = "gpt-5.3-codex";
    QVERIFY(agent->saveUsage("current", "a", record));
    record = merged(record, counts(600, 200, 450));
    QVERIFY(agent->saveUsage("current", "a", record)); // Upsert, never add twice.
    record = merged(record, counts(100, 100, 50));
    record["model"] = "gpt-5.4";
    QVERIFY(agent->saveUsage("current", "b", record));
    record = merged(record, counts(80, 20, 30));
    record.remove("model");
    QVERIFY(agent->saveUsage("archived", "c", record));
    QVERIFY(agent->saveUsage("not-in-catalog", "d", record));
    agent->snapshot["threads"] = Object{{"current", Object{{"id", "current"}, {"tokenUsage", Object{{"total", counts(1500, 200, 1000)}}}}}};
    agent->refreshProjectUsage(false);
    auto value = agent->catalog["projects"].toArray()[0].toObject()["usage"].toObject();
    QCOMPARE(value["totalTokens"], QJsonValue(5700));
    QCOMPARE(value["totalThreads"], QJsonValue(2));
    QCOMPARE(value["knownThreads"], QJsonValue(2));
    QCOMPARE(value["recordedTokens"], QJsonValue(1100));
    QCOMPARE(value["models"].toArray().size(), 3);
    QCOMPARE(value["models"].toArray()[0].toObject()["model"], QJsonValue(QJsonValue::Null));
    QCOMPARE(value["models"].toArray()[1].toObject()["inputTokens"], QJsonValue(600));
    const auto currentUsage = agent->snapshot["threads"].toObject()["current"].toObject()["usage"].toObject();
    QCOMPARE(currentUsage["totalTokens"], QJsonValue(1700));
    QCOMPARE(currentUsage["recordedTokens"], QJsonValue(1000));
    QCOMPARE(currentUsage["totalKnown"], QJsonValue(true));
    QCOMPARE(currentUsage["models"].toArray().size(), 2);
    QCOMPARE(currentUsage["models"].toArray()[0].toObject()["inputTokens"], QJsonValue(600));
    QVERIFY(!agent->snapshot["threads"].toObject().contains("archived"));
    agent->rawThreads["current"] = {{"id", "current"}, {"title", "Current"},
        {"threadRuntimeStatus", Object{{"type", "idle"}}}, {"turns", Array{}},
        {"latestTokenUsageInfo", Object{{"total", counts(1500, 200, 1000)}}}};
    agent->updateThread("current");
    QCOMPARE(agent->snapshot["threads"].toObject()["current"].toObject()["usage"].toObject(), currentUsage);
    QCOMPARE(agent->catalog["projects"].toArray()[1].toObject()["usage"].toObject()["totalTokens"], QJsonValue(700));
    QCOMPARE(agent->catalog["projects"].toArray()[2].toObject()["usage"].toObject()["totalTokens"], QJsonValue(0));
    QCOMPARE(agent->catalog["unassignedUsage"].toObject()["totalTokens"], QJsonValue(50));
    QCOMPARE(read(index.filePath("state_10.sqlite")), before);
    const auto first = agent->catalog;
    agent->refreshProjectUsage(false);
    QCOMPARE(agent->catalog, first);
    QVERIFY(!agent->rpc); // No model request or thread ownership acquisition.
    writeIndex("state_10.sqlite", 2000);
    agent->refreshProjectUsage(false);
    QCOMPARE(agent->catalog["projects"].toArray()[0].toObject()["usage"].toObject()["totalTokens"], QJsonValue(6000));
    QCOMPARE(agent->snapshot["threads"].toObject()["current"].toObject()["usage"].toObject()["totalTokens"], QJsonValue(2000));
  }
  void projectUsageFallsBackWithoutPretendingHistoryIsComplete() {
    QTemporaryDir index;
    agent->settings["codexHome"] = index.path();
    agent->catalog = {{"projects", Array{Object{{"id", "p"}}}},
        {"threads", Array{Object{{"id", "live"}, {"projectId", "p"}},
          Object{{"id", "journal-only"}, {"projectId", "p"}},
          Object{{"id", "missing"}, {"projectId", "p"}}}}};
    agent->snapshot["threads"] = Object{{"live", Object{{"id", "live"}, {"tokenUsage", Object{{"total", counts(1000, 100, 500)}}}}}};
    auto record = counts(200, 50, 100);
    record["state"] = "partial";
    QVERIFY(agent->saveUsage("journal-only", "a", record));
    agent->refreshProjectUsage(false);
    const auto value = agent->catalog["projects"].toArray()[0].toObject()["usage"].toObject();
    QCOMPARE(value["totalTokens"], QJsonValue(1350));
    QCOMPARE(value["recordedTokens"], QJsonValue(250));
    QCOMPARE(value["knownThreads"], QJsonValue(1));
    QCOMPARE(value["totalThreads"], QJsonValue(3));
    QCOMPARE(value["partial"], QJsonValue(true));
    QVERIFY(!agent->rpc);
  }
  void usageInvalidCounters_data() {
    QTest::addColumn<QJsonValue>("invalid");
    QTest::newRow("negative") << QJsonValue(-1);
    QTest::newRow("fraction") << QJsonValue(1.5);
    QTest::newRow("unsafe") << QJsonValue(9007199254740992.0);
    QTest::newRow("string") << QJsonValue("100");
    QTest::newRow("missing") << QJsonValue(QJsonValue::Undefined);
  }
  void usageInvalidCounters() {
    QFETCH(QJsonValue, invalid);
    agent->startUsage("thread-test", "new");
    auto total = counts(100, 10, 50);
    if (invalid.isUndefined()) total.remove("inputTokens");
    else total["inputTokens"] = invalid;
    agent->observeUsage("thread-test", "new", {{"total", total}, {"last", total}}, true);
    QVERIFY(agent->usageRecord("thread-test", "new").isEmpty());
    total = counts(100, 10, 101); // Cached input must be a subset.
    agent->observeUsage("thread-test", "new", {{"total", total}, {"last", total}}, true);
    QVERIFY(agent->usageRecord("thread-test", "new").isEmpty());
  }
  void usageInconsistentDeltasArePartial() {
    desktopUsage(usageState("old", false, counts(1000, 100, 500)));
    desktopUsage(usageState("new", true, counts(1000, 100, 600)));
    desktopUsage(usageState("new", false, counts(1500, 130, 900)));
    const auto saved = agent->usageRecord("thread-test", "new");
    QCOMPARE(saved["inputTokens"], QJsonValue(500));
    QCOMPARE(saved["cachedInputTokens"], QJsonValue(300));
    QCOMPARE(saved["state"], QJsonValue("partial"));
  }
  void usagePersistenceAndLegacyRecords() {
    agent->startUsage("thread-test", "done");
    agent->observeUsage("thread-test", "done", {{"total", counts(100, 10, 50)}, {"last", counts(100, 10, 50)}}, true);
    agent->finishUsage("thread-test", "done");
    agent->startUsage("thread-test", "running");
    agent->observeUsage("thread-test", "running", {{"total", counts(300, 30, 100)}}, true);
    const auto done = agent->usageRecord("thread-test", "done");
    agent->closeAgent();
    agent->openJournal();
    QCOMPARE(agent->usageRecord("thread-test", "done"), done);
    QCOMPARE(agent->usageRecord("thread-test", "running")["state"], QJsonValue("partial"));
    desktopUsage(usageState("done", false, counts(100, 10, 50)));
    desktopUsage(usageState("done", false, counts(100, 10, 50)));
    QCOMPARE(agent->usageRecord("thread-test", "done"), done);
    sql(agent->usage, "INSERT INTO turn_usage VALUES(?,?,?)", {"thread-test", "bad", "{bad-json"});
    Object turn{{"id", "bad"}};
    agent->enrichUsage("thread-test", turn);
    QVERIFY(!turn.contains("tokenUsage"));
  }
  void usageStorageFailureKeepsEventProcessingAlive() {
    desktopUsage(usageState("old", false, counts(1000, 100, 500)));
    desktopUsage(usageState("new", true, counts(1000, 100, 500)));
    sql(agent->usage, "DROP TABLE turn_usage");
    desktopUsage(usageState("new", true, counts(1500, 130, 900)));
    QVERIFY(agent->dirtyThreads.contains("thread-test"));
    QVERIFY(!agent->usageObservations.contains("thread-test"));
    agent->ensureRpc();
    agent->startUsage("rpc-thread", "turn");
    emit agent->rpc->notification("turn/completed", {{"threadId", "rpc-thread"},
        {"turn", Object{{"id", "turn"}}}});
    QVERIFY(agent->dirtyThreads.contains("rpc-thread"));
    QCOMPARE(agent->view["logs"].toArray().last().toObject()["code"], QJsonValue("token-usage-observation-failed"));
  }
  void usageEnrichmentRespectsLiveAndHistoryBudgets() {
    agent->startUsage("thread-test", "new", "model-a");
    agent->observeUsage("thread-test", "new", {{"total", counts(100, 10, 50)}, {"last", counts(100, 10, 50)}}, true);
    agent->finishUsage("thread-test", "new");
    auto source = usageState("new", false, counts(100, 10, 50));
    auto turn = source["turns"].toArray().last().toObject();
    Array items;
    for (int i = 0; i < 20; ++i)
      items.append(Object{{"id", QString::number(i)}, {"type", "commandExecution"},
                          {"text", QString(4096, 'x')}, {"aggregatedOutput", QString(8192, 'x')}});
    turn["items"] = items;
    source["turns"] = Array{turn};
    auto normalized = normalizeThread(source, 0);
    auto turns = normalized["turns"].toArray();
    auto padded = turns[0].toObject();
    padded["diff"] = QString(256 * 1024 - json(normalized).size(), 'x');
    turns[0] = padded;
    normalized["turns"] = turns;
    QCOMPARE(json(normalized).size(), 256 * 1024);
    source["_normalized"] = normalized;
    agent->rawThreads["thread-test"] = source;
    agent->updateThread("thread-test");
    const auto live = agent->snapshot["threads"].toObject()["thread-test"].toObject();
    QVERIFY(json(live).size() <= 256 * 1024);
    const auto liveTurn = live["turns"].toArray()[0].toObject();
    QCOMPARE(liveTurn["tokenUsage"].toObject()["state"], QJsonValue("complete"));
    QVERIFY(liveTurn["items"].toArray().size() < 20);
    Array historyTurns;
    for (int t = 0; t < 3; ++t) {
      Array largeItems;
      for (int i = 0; i < 40; ++i)
        largeItems.append(Object{{"id", QString::number(i)}, {"type", "agentMessage"},
            {"text", QString(32000, 'x')}, {"aggregatedOutput", QString(32000, 'x')}});
      historyTurns.append(Object{{"id", t == 0 ? "new" : QString::number(t)},
          {"status", "completed"}, {"items", largeItems}});
    }
    setFixture({{"turns", historyTurns}});
    const auto page = agent->history("thread-test", QJsonValue::Null);
    QVERIFY(json(page).size() <= 6 * 1024 * 1024);
    const auto historyTurn = page["turns"].toArray()[0].toObject();
    QCOMPARE(historyTurn["tokenUsage"].toObject()["state"], QJsonValue("complete"));
    QVERIFY(historyTurn["items"].toArray().size() < 40);
  }
  void desktopContinueRequiresLatestInterruptedTurn_data() {
    QTest::addColumn<QString>("status");
    QTest::addColumn<QString>("expectedId");
    QTest::newRow("interrupted") << QString("interrupted") << QString("stopped");
    QTest::newRow("completed") << QString("completed") << QString("stopped");
    QTest::newRow("stale") << QString("interrupted") << QString("other");
  }
  void desktopContinueRequiresLatestInterruptedTurn() {
    QFETCH(QString, status);
    QFETCH(QString, expectedId);
    try {
      auto state = raw();
      state["turns"] = Array{Object{{"turnId", "stopped"}, {"status", status},
                                    {"items", Array{}}}};
      DesktopFixture fixture(state);
      qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
      agent->settings["runtime"] = "auto";
      agent->desktop->open(agent->settings);
      QVERIFY(agent->desktop->follow("thread-test"));
      QVERIFY(waitFor([&] { return agent->desktop->watched["thread-test"].compatible; }, 1000));
      agent->refreshCatalog();
      auto cmd = command("turn.continue");
      cmd["payload"] = Object{{"type", "turn.continue"},
                              {"threadId", "thread-test"}, {"turnId", expectedId}};
      const bool valid = status == "interrupted" && expectedId == "stopped";
      if (valid)
        QCOMPARE(agent->execute(cmd)["turnId"], QJsonValue("desktop-turn"));
      else
        QVERIFY_EXCEPTION_THROWN(agent->execute(cmd), Error);
      int starts = 0;
      for (const auto &req : fixture.requests) {
        if (req["method"] != "thread-follower-start-turn") continue;
        ++starts;
        const auto input = req["params"].toObject()["turnStart"].toObject()["request"].toObject()["input"];
        QCOMPARE(input, QJsonValue(Array{}));
      }
      QCOMPARE(starts, valid ? 1 : 0);
    } catch (const Error &error) {
      QFAIL(qPrintable(error.code));
    }
  }
  void desktopSettingsRemainAvailableDuringExecution() {
    auto state = raw();
    state["threadRuntimeStatus"] = Object{{"type", "active"}};
    state["turns"] = Array{Object{{"turnId", "turn"}, {"status", "inProgress"}, {"items", Array{}}}};
    state["latestModel"] = "synthetic-model";
    state["latestReasoningEffort"] = "medium";
    state["latestThreadSettings"] = Object{{"model", "synthetic-model"}, {"effort", "medium"},
        {"approvalPolicy", "on-request"}, {"approvalsReviewer", "user"},
        {"sandboxPolicy", Object{{"type", "readOnly"}}}};
    DesktopFixture fixture(state);
    qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
    agent->settings["runtime"] = "auto";
    agent->desktop->open(agent->settings);
    QVERIFY(agent->desktop->follow("thread-test"));
    QVERIFY(waitFor([&] { return agent->desktop->watched["thread-test"].compatible; }, 1000));
    agent->refreshCatalog();
    auto cmd = command("thread.effort.update");
    cmd["payload"] = Object{{"type", "thread.effort.update"},
        {"threadId", "thread-test"}, {"expectedModel", "synthetic-model"},
        {"expectedEffort", "medium"}, {"effort", "high"}};
    QVERIFY(agent->execute(cmd)["acknowledgedByDesktop"].toBool());
    QCOMPARE(agent->snapshot["threads"].toObject()["thread-test"].toObject()["status"], QJsonValue("active"));
    for (const auto &req : fixture.requests) {
      QVERIFY(req["method"] != "thread-follower-interrupt-turn");
      QVERIFY(req["method"] != "thread-follower-start-turn");
    }
    QVERIFY(!read(temp.path() + "/requests.jsonl").contains("thread/resume"));
  }
  void desktopFramingAndStart() {
    DesktopFixture fixture(raw());
    qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
    agent->settings["runtime"] = "auto";
    agent->desktop->open(agent->settings);
    QVERIFY(agent->desktop->follow("thread-test"));
    QVERIFY(waitFor(
        [&] { return agent->desktop->watched["thread-test"].compatible; },
        1000));
    agent->refreshCatalog();
    auto result = agent->execute(command());
    QCOMPARE(result["turnId"], QJsonValue("desktop-turn"));
    QVERIFY(result["acknowledgedByDesktop"].toBool());
    int starts = 0;
    for (auto req : fixture.requests)
      if (req["method"] == "thread-follower-start-turn") {
        ++starts;
        QCOMPARE(req["version"], QJsonValue(2));
        QCOMPARE(req["targetClientId"], QJsonValue("synthetic-owner"));
      }
    QCOMPARE(starts, 1);
    QVERIFY(!read(temp.path() + "/requests.jsonl").contains("turn/start"));
  }
  void writerRejectionHandsOffOnlyBeforeSend() {
    setFixture({{"rejectWriter", true}});
    DesktopFixture fixture(raw());
    fixture.hideFirstOwner = true;
    qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
    agent->settings["runtime"] = "auto";
    agent->desktop->open(agent->settings);
    agent->refreshCatalog();
    auto result = agent->execute(command());
    QVERIFY(result["acknowledgedByDesktop"].toBool());
    QCOMPARE(fixture.ownerLookups, 2);
    QVERIFY(!read(temp.path() + "/requests.jsonl").contains("turn/start"));
  }
  void desktopOwnerRediscovery_data() {
    QTest::addColumn<QString>("scenario");
    for (const auto &scenario : {"owner-changed", "owner-disappeared",
                                 "rejected-again", "expired", "revoked",
                                 "new-owner-busy"})
      QTest::newRow(scenario) << QString(scenario);
  }
  void desktopOwnerRediscovery() {
    QFETCH(QString, scenario);
    DesktopFixture fixture(raw());
    qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
    agent->settings["runtime"] = "auto";
    agent->desktop->open(agent->settings);
    QVERIFY(agent->desktop->follow("thread-test"));
    QVERIFY(waitFor(
        [&] { return agent->desktop->watched["thread-test"].compatible; },
        1000));
    agent->refreshCatalog();
    auto cmd = command();
    fixture.owner = "replacement-owner";
    fixture.rejectStarts = scenario == "rejected-again";
    fixture.onOwnerLookup = [&] {
      if (scenario == "owner-disappeared")
        fixture.hideOwner = true;
      if (scenario == "revoked")
        agent->remoteGeneration++;
      if (scenario == "new-owner-busy")
        fixture.raw["threadRuntimeStatus"] = Object{{"type", "active"}};
    };
    // Expire the original command while waiting for the new owner's snapshot.
    if (scenario == "expired") {
      cmd["expiresAt"] = double(now() + 100);
      fixture.onOwnerLookup = [] { QTest::qWait(120); };
    }
    QString error;
    try {
      auto result = agent->execute(cmd);
      QVERIFY(result["acknowledgedByDesktop"].toBool());
      QCOMPARE(scenario, QString("owner-changed"));
    } catch (const Error &e) {
      error = e.code;
      QVERIFY(!e.uncertain);
    }
    const auto expected = scenario == "owner-changed" ? QString{}
        : scenario == "expired" ? QString("command-expired")
        : scenario == "revoked" ? QString("remote-disconnected")
        : scenario == "new-owner-busy" ? QString("thread-not-idle")
        : QString("desktop-owner-unavailable");
    QCOMPARE(error, expected);
    QCOMPARE(fixture.ownerLookups, 2);
    QCOMPARE(fixture.acceptedStarts, scenario == "owner-changed" ? 1 : 0);
    int starts = 0;
    for (const auto &request : fixture.requests)
      starts += request["method"] == "thread-follower-start-turn";
    QCOMPARE(starts, scenario == "owner-changed" || scenario == "rejected-again" ? 2 : 1);
    QVERIFY(!read(temp.path() + "/requests.jsonl").contains("turn/start"));
    if (scenario == "owner-disappeared") {
      const auto state = agent->snapshot["threads"].toObject()["thread-test"].toObject();
      QCOMPARE(state["status"], QJsonValue("unavailable"));
      QVERIFY(!state["ownerAvailable"].toBool());
    }
  }
  void unknownDesktopStartIsNotRetried() {
    DesktopFixture fixture(raw());
    fixture.disconnectStart = true;
    qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
    agent->settings["runtime"] = "auto";
    agent->desktop->open(agent->settings);
    QVERIFY(agent->desktop->follow("thread-test"));
    QVERIFY(waitFor(
        [&] { return agent->desktop->watched["thread-test"].compatible; },
        1000));
    agent->refreshCatalog();
    try {
      agent->execute(command());
      QFAIL("unknown start must not succeed");
    } catch (const Error &e) {
      QVERIFY(e.uncertain);
    }
    QVERIFY(!read(temp.path() + "/requests.jsonl").contains("turn/start"));
    int starts = 0;
    for (auto req : fixture.requests)
      starts += req["method"] == "thread-follower-start-turn";
    QCOMPARE(starts, 1);
  }
  void undeliveredApprovalCanMoveToNewOwner() {
    auto state = raw();
    state["threadRuntimeStatus"] = Object{{"type", "active"}};
    state["turns"] = Array{Object{{"id", "turn"}, {"status", "inProgress"},
                                   {"items", Array{}}}};
    state["requests"] = Array{Object{
        {"id", "approval"}, {"method", "item/commandExecution/requestApproval"},
        {"params", Object{{"threadId", "thread-test"}, {"turnId", "turn"},
                            {"command", "synthetic-command"}}}}};
    DesktopFixture fixture(state);
    qputenv("CODEX_REMOTE_DESKTOP_ENDPOINT", fixture.endpoint.toUtf8());
    agent->settings["runtime"] = "auto";
    agent->desktop->open(agent->settings);
    QVERIFY(agent->desktop->follow("thread-test"));
    QVERIFY(waitFor(
        [&] { return agent->desktop->watched["thread-test"].compatible; },
        1000));
    agent->refreshCatalog();
    fixture.owner = "replacement-owner";
    auto cmd = command("approval.respond");
    cmd["payload"] = Object{{"type", "approval.respond"},
                            {"threadId", "thread-test"}, {"turnId", "turn"},
                            {"requestId", "approval"}, {"decision", "accept"}};
    QVERIFY(agent->execute(cmd)["acknowledgedByDesktop"].toBool());
    QCOMPARE(fixture.ownerLookups, 2);
    int delivered = 0;
    for (const auto &request : fixture.requests)
      if (request["method"] == "thread-follower-command-approval-decision" &&
          request["targetClientId"] == fixture.owner)
        ++delivered;
    QCOMPARE(delivered, 1);
    QVERIFY_EXCEPTION_THROWN(agent->execute(cmd), Error);
    int after = 0;
    for (const auto &request : fixture.requests)
      after += request["method"] == "thread-follower-command-approval-decision" &&
               request["targetClientId"] == fixture.owner;
    QCOMPARE(after, 1);
  }
  void imageAndFileNamesWithSpacesAndParentheses() {
    auto path = temp.path() + QString::fromUtf8("/中文 image (1).png");
    save(path, QByteArray::fromHex(
                   "89504e470d0a1a0a00000000000000000000000000000000"));
    auto refs = agent->registerImages(
        "thread-test",
        {{"type", "agentMessage"}, {"text", "![Image](<" + path + ">)"}});
    QCOMPARE(refs.size(), 1);
    QVERIFY(
        !agent->readImage("thread-test", refs[0].toObject()["id"].toString())
             .isEmpty());
    auto url = QString::fromUtf8(QUrl::toPercentEncoding(path, "/:()"));
    auto inlineRefs = agent->registerImages(
        "thread-test",
        {{"type", "agentMessage"}, {"text", "![Image](" + url + ")"}});
    QCOMPARE(inlineRefs.size(), 1);
    QCOMPARE(inlineRefs[0].toObject()["id"], refs[0].toObject()["id"]);
    agent->observeFiles(
        "thread-test",
        {{"items", Array{Object{{"type", "agentMessage"},
                                {"text", "[File](<" + path + ">)"}}}}});
    QVERIFY(!agent->readFile({{"threadId", "thread-test"}, {"path", path}})
                 .isEmpty());
  }
  void previewOnlyStreamsObservedLoopback() {
    QWebSocketServer relay("Synthetic", QWebSocketServer::NonSecureMode);
    QVERIFY(relay.listen(QHostAddress::LocalHost, 0));
    QList<Object> messages;
    connect(&relay, &QWebSocketServer::newConnection, &relay, [&] {
      auto peer = relay.nextPendingConnection();
      connect(peer, &QWebSocket::textMessageReceived, &relay,
              [&](QString value) {
                messages.append(parse(value.toUtf8()).toObject());
              });
    });
    agent->credentials["relayUrl"] =
        "http://127.0.0.1:" + QString::number(relay.serverPort());
    agent->connectRelay();
    QVERIFY(waitFor([&] { return !messages.isEmpty(); }, 1000));
    QTcpServer local;
    QVERIFY(local.listen(QHostAddress::LocalHost, 0));
    int requests = 0;
    connect(&local, &QTcpServer::newConnection, &local, [&] {
      auto peer = local.nextPendingConnection();
      connect(peer, &QTcpSocket::readyRead, peer, [&, peer] {
        peer->readAll();
        ++requests;
        peer->write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: "
                    "close\r\n\r\nhello");
        peer->disconnectFromHost();
      });
      connect(peer, &QTcpSocket::disconnected, peer, &QObject::deleteLater);
    });
    auto origin = "http://127.0.0.1:" + QString::number(local.serverPort());
    agent->catalog["threads"] =
        Array{Object{{"id", "thread-test"}, {"archived", false}}};
    Object request{{"type", "preview.request"},
                   {"requestId", uuid()},
                   {"threadId", "thread-test"},
                   {"origin", origin},
                   {"path", "/"},
                   {"method", "GET"},
                   {"headers", Object{}}};
    agent->preview(request);
    QCOMPARE(requests, 0);
    agent->observeFiles("thread-test",
                        {{"items", Array{Object{{"type", "commandExecution"},
                                                {"output", origin}}}}});
    request["requestId"] = uuid();
    agent->preview(request);
    QVERIFY(waitFor([&] { return agent->previewOperations.isEmpty(); }, 3000));
    QCOMPARE(requests, 1);
    QVERIFY(waitFor(
        [&] {
          for (auto m : messages)
            if (m["requestId"] == request["requestId"] &&
                m["event"].toObject()["type"] == "end")
              return true;
          return false;
        },
        1000));
    QByteArray content;
    for (auto m : messages)
      if (m["requestId"] == request["requestId"] &&
          m["event"].toObject()["type"] == "data")
        content += QByteArray::fromBase64(
            m["event"].toObject()["data"].toString().toLatin1());
    QCOMPARE(content, QByteArray("hello"));
    agent->pause();
  }

  void previewWebSocketUsesValidHandshake_data() {
    QTest::addColumn<QString>("host");
    QTest::newRow("ipv4") << "127.0.0.1";
    QTest::newRow("localhost") << "localhost";
    QTest::newRow("ipv6") << "[::1]";
  }
  void previewWebSocketUsesValidHandshake() {
    QFETCH(QString, host);
    QWebSocketServer relay("Synthetic", QWebSocketServer::NonSecureMode);
    QVERIFY(relay.listen(QHostAddress::LocalHost, 0));
    QList<Object> events;
    connect(&relay, &QWebSocketServer::newConnection, &relay, [&] {
      auto peer = relay.nextPendingConnection();
      connect(peer, &QWebSocket::textMessageReceived, &relay, [&](QString text) {
        events.append(parse(text.toUtf8()).toObject());
      });
    });
    agent->credentials["relayUrl"] =
        "http://127.0.0.1:" + QString::number(relay.serverPort());
    agent->connectRelay();
    QVERIFY(waitFor([&] { return !events.isEmpty(); }, 1000));

    QTcpServer listener;
    if (!listener.listen(host == "[::1]" ? QHostAddress::LocalHostIPv6
                                         : QHostAddress::LocalHost, 0))
      QSKIP("Loopback family unavailable");
    QWebSocketServer upstream("Strict local service",
                             QWebSocketServer::NonSecureMode);
    upstream.setSupportedSubprotocols({"island.v1"});
    QByteArray handshake;
    connect(&listener, &QTcpServer::newConnection, &listener, [&] {
      auto peer = listener.nextPendingConnection();
      connect(peer, &QTcpSocket::readyRead, &listener, [&, peer] {
        auto bytes = peer->peek(16384);
        if (!bytes.contains("\r\n\r\n"))
          return;
        handshake = bytes;
        peer->disconnect(&listener);
        QList<QByteArray> hosts, origins;
        for (auto line : bytes.split('\n')) {
          if (line.toLower().startsWith("host:"))
            hosts.append(line.mid(5).trimmed());
          if (line.toLower().startsWith("origin:"))
            origins.append(line.mid(7).trimmed());
        }
        // Go net/http rejects duplicate Host headers. The game's origin
        // policy also requires the Origin authority to match Host.
        if (hosts.size() != 1 || origins.size() != 1 ||
            QUrl(QString::fromLatin1(origins[0])).authority().toLatin1() !=
                hosts[0]) {
          peer->readAll();
          peer->write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
          peer->disconnectFromHost();
          return;
        }
        upstream.handleConnection(peer);
      });
    });
    QWebSocket *local = nullptr;
    connect(&upstream, &QWebSocketServer::newConnection, &upstream, [&] {
      local = upstream.nextPendingConnection();
      connect(local, &QWebSocket::textMessageReceived, &upstream,
              [&](QString text) { local->sendTextMessage(text); });
      connect(local, &QWebSocket::binaryMessageReceived, &upstream,
              [&](QByteArray bytes) { local->sendBinaryMessage(bytes); });
    });
    const auto origin = "http://" + host + ":" +
                        QString::number(listener.serverPort());
    agent->catalog["threads"] =
        Array{Object{{"id", "thread-test"}, {"archived", false}}};
    agent->observeFiles("thread-test",
                        {{"items", Array{Object{{"type", "commandExecution"},
                                                {"output", origin}}}}});
    const auto id = uuid();
    auto eventOf = [&](const QString &type) {
      for (auto message : events)
        if (message["requestId"] == id &&
            message["event"].toObject()["type"] == type)
          return message["event"].toObject();
      return Object{};
    };
    agent->preview({{"type", "preview.ws.open"}, {"requestId", id},
                    {"threadId", "thread-test"}, {"origin", origin},
                    {"path", "/ws?game=island"},
                    {"protocols", Array{"island.v1"}}});
    QVERIFY(waitFor([&] { return !eventOf("ws.open").isEmpty() ||
                                !eventOf("error").isEmpty(); }, 3000));
    QVERIFY2(!eventOf("ws.open").isEmpty(), handshake.constData());
    QCOMPARE(eventOf("ws.open")["protocol"], QJsonValue("island.v1"));
    QVERIFY(handshake.startsWith("GET /ws?game=island HTTP/1.1\r\n"));
    QVERIFY(local);
    QVERIFY(local->peerAddress().isLoopback());
    for (bool binary : {false, true}) {
      events.clear();
      const auto bytes = binary ? QByteArray::fromHex("00ff8010")
                                : QString::fromUtf8("登录小岛").toUtf8();
      agent->preview({{"type", "preview.ws.data"}, {"requestId", id},
                      {"data", QString::fromLatin1(bytes.toBase64())},
                      {"binary", binary}});
      QVERIFY(waitFor([&] { return !eventOf("ws.data").isEmpty(); }, 1000));
      QCOMPARE(eventOf("ws.data")["binary"], QJsonValue(binary));
      QCOMPARE(QByteArray::fromBase64(eventOf("ws.data")["data"]
                                         .toString().toLatin1()), bytes);
    }
    events.clear();
    local->close();
    QVERIFY(waitFor([&] { return !eventOf("ws.close").isEmpty(); }, 1000));
    QVERIFY(waitFor([&] { return agent->previewOperations.isEmpty(); }, 1000));
    agent->pause();
  }

  void previewWebSocketFailureReleasesOperation() {
    QTcpServer upstream;
    QVERIFY(upstream.listen(QHostAddress::LocalHost, 0));
    int requests = 0;
    connect(&upstream, &QTcpServer::newConnection, &upstream, [&] {
      auto peer = upstream.nextPendingConnection();
      connect(peer, &QTcpSocket::readyRead, peer, [&, peer] {
        if (!peer->peek(16384).contains("\r\n\r\n"))
          return;
        peer->readAll();
        ++requests;
        peer->write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        peer->disconnectFromHost();
      });
      connect(peer, &QTcpSocket::disconnected, peer, &QObject::deleteLater);
    });
    const auto origin = "http://localhost:" + QString::number(upstream.serverPort());
    agent->catalog["threads"] =
        Array{Object{{"id", "thread-test"}, {"archived", false}}};
    Object request{{"type", "preview.ws.open"}, {"requestId", uuid()},
                   {"threadId", "thread-test"}, {"origin", origin},
                   {"path", "/ws"}};
    agent->preview(request);
    QVERIFY(agent->previewOperations.isEmpty());
    QCOMPARE(requests, 0);
    agent->observeFiles("thread-test",
                        {{"items", Array{Object{{"type", "commandExecution"},
                                                {"output", origin}}}}});
    request["requestId"] = uuid();
    agent->preview(request);
    QVERIFY(waitFor([&] { return requests == 1 &&
                                agent->previewOperations.isEmpty(); }, 3000));
    request["requestId"] = uuid();
    agent->preview(request);
    agent->preview({{"type", "preview.cancel"},
                    {"requestId", request["requestId"]}});
    QVERIFY(agent->previewOperations.isEmpty());
  }

  void realIsolatedWriterRelease() {
    if (!qEnvironmentVariableIsSet("CODEXER_NATIVE_REAL_WRITER"))
      QSKIP("Enable explicit isolated Codex probe");
    agent->settings["codexBinary"] = QString{};
    auto binary = executable(agent->settings);
    agent->settings["codexBinary"] = binary;
    agent->ensureRpc();
    auto started =
        agent->rpc->call("thread/start", {{"cwd", temp.path()},
                                          {"sandbox", "read-only"},
                                          {"approvalPolicy", "on-request"}});
    auto id = started["thread"].toObject()["id"].toString();
    QVERIFY(!id.isEmpty());
    agent->rpc->call(
        "thread/inject_items",
        {{"threadId", id},
         {"items",
          Array{Object{
              {"type", "message"},
              {"role", "user"},
              {"content",
               Array{Object{
                   {"type", "input_text"},
                   {"text", "isolated history, no model request"}}}}}}}});
    Rpc other;
    other.start(agent->settings);
    bool blocked = false;
    try {
      other.call("thread/resume", {{"threadId", id}});
    } catch (const Error &e) {
      blocked = e.code == "thread-writer-busy";
    }
    QVERIFY(blocked);
    agent->owned.insert(id);
    agent->acquired[id] = now() - 10000;
    auto released = agent->release(true);
    QCOMPARE(released["released"], QJsonValue(1));
    auto resumed = other.call("thread/resume", {{"threadId", id}});
    QCOMPARE(resumed["thread"].toObject()["id"], QJsonValue(id));
    save(temp.path() + "/real-writer-result.json",
         json(Object{{"binary", binary},
                     {"sameThread", true},
                     {"released", released},
                     {"threadId", id}}));
  }
};
} // namespace Native
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  if (app.arguments().contains("app-server"))
    return Native::fixtureServer();
  if (app.arguments().size() == 4 &&
      app.arguments()[1] == "--protocol-fixtures") {
    Native::Array results;
    for (auto value :
         Native::parse(Native::read(app.arguments()[2])).toArray()) {
      auto job = value.toObject();
      if (job["kind"] == "command")
        results.append(Native::validCommand(job["value"].toObject()));
      else if (job["kind"] == "thread")
        results.append(Native::normalizeThread(job["value"].toObject(), 0));
      else if (job["kind"] == "history")
        results.append(Native::normalizeTurn(job["value"].toObject(), true,
                                             "thread-test"));
      else if (job["kind"] == "approval")
        results.append(Native::approval(job["value"].toObject()));
      else if (job["kind"] == "localFilePath") {
        auto value = job["value"].toObject();
        auto path = Native::localFilePath(value["value"].toString(),
                                          value["encoded"].toBool(true));
        results.append(path.isEmpty() ? QJsonValue(QJsonValue::Null)
                                       : QJsonValue(path));
      }
      else if (job["kind"] == "htmlPreviewPaths") {
        Native::Array paths;
        for (const auto &path : Native::htmlPreviewPaths(
                 job["value"].toObject()["source"].toString()))
          paths.append(path);
        results.append(paths);
      }
    }
    Native::save(app.arguments()[3], Native::json(results));
    return 0;
  }
  Native::NativeTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "native_tests.moc"
