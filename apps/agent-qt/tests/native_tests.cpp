#include "native.h"
#include <QtEndian>
#include <QtTest>
#include <QtWebSockets/QWebSocketServer>
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
  bool hideFirstOwner = false, disconnectStart = false;
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
            if (message["params"].toObject()["following"].toBool())
              snapshot();
            continue;
          }
          if (message["type"] != "request")
            continue;
          requests.append(message);
          Object response{{"type", "response"},
                          {"requestId", message["requestId"]},
                          {"resultType", "success"},
                          {"handledByClientId", "synthetic-owner"}};
          if (method == "initialize")
            response["result"] = Object{{"clientId", "synthetic-follower"}};
          else if (method == "thread-owner-discovery") {
            ++ownerLookups;
            if (hideFirstOwner && ownerLookups == 1) {
              response["resultType"] = "error";
              response["error"] = "no-client-found";
            }
          } else if (method == "thread-follower-start-turn") {
            if (disconnectStart) {
              peer->abort();
              return;
            }
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
          {"sourceClientId", "synthetic-owner"},
          {"version", 11},
          {"params", Object{{"conversationId", "thread-test"},
                            {"hostId", "local"},
                            {"change", Object{{"type", "snapshot"},
                                              {"revision", 0},
                                              {"conversationState", raw}}}}}});
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
    }
    Native::save(app.arguments()[3], Native::json(results));
    return 0;
  }
  Native::NativeTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "native_tests.moc"
