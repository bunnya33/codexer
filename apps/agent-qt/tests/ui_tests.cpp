#include "connector_ui.h"
#include <QtTest>

static QJsonObject fixture(bool logged = false) {
  return {{"settings", QJsonObject{{"relayUrl", "https://relay.example.test"},
                                   {"username", "test-user"},
                                   {"deviceName", "我的电脑"},
                                   {"installationId", "isolated"},
                                   {"codexHome", "C:/Test Codex"},
                                   {"codexBinary", ""},
                                   {"runtime", "auto"},
                                   {"projectParents", QJsonArray{}},
                                   {"autoConnect", false},
                                   {"openAtLogin", false},
                                   {"minimizeToTray", true},
                                   {"allowHttp", false}}},
          {"version", "0.2.18"},
          {"phase", logged ? "disconnected" : "signed-out"},
          {"loggedIn", logged},
          {"busy", false},
          {"secureStorage", true},
          {"status", QJsonValue::Null},
          {"error", ""},
          {"logs",
           QJsonArray{QJsonObject{{"at", 1000}, {"code", "console-ready"}}}}};
}
class UiTests : public QObject {
  Q_OBJECT
  std::unique_ptr<QMainWindow> host;
  ConnectorUi *ui;
  QJsonObject state;
  QList<QPair<QString, QJsonObject>> commands;
  template <class T> T *get(QString name) {
    auto item = ui->findChild<T *>(name);
    Q_ASSERT(item);
    return item;
  }
  QPushButton *button(QString name) { return get<QPushButton>(name); }
  void enter(QString name, QString value) {
    auto edit = get<QLineEdit>(name);
    edit->setFocus();
    edit->selectAll();
    QTest::keyClicks(edit, value);
  }
  void page(int n) {
    button("nav" + QString::number(n))->click();
    QCoreApplication::processEvents();
  }
  void connected() {
    state = fixture(true);
    state["phase"] = "connected";
    state["status"] = QJsonObject{{"runtimeConnected", true},
                                  {"runtime", "official-desktop-ipc"},
                                  {"activeTasks", 2},
                                  {"threads", 12},
                                  {"updatedAt", 1000}};
    ui->applyState(state);
  }
private slots:
  void init() {
    host = std::make_unique<QMainWindow>();
    host->resize(1180, 800);
    host->setWindowFlags(Qt::Window | Qt::FramelessWindowHint);
    ui = new ConnectorUi(host.get());
    host->setCentralWidget(ui);
    commands.clear();
    ui->command = [this](QString method, QJsonObject value,
                         ConnectorUi::Done done) {
      commands.append({method, value});
      if (done)
        done({}, {});
    };
    state = fixture();
    ui->applyState(state);
    ui->applyUpdate({{"version", "0.2.18"}});
    host->show();
    QTest::qWait(30);
  }
  void cleanup() {
    host.reset();
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
  }
  void loginRequiresPasswordStorageAndIdle() {
    QVERIFY(!button("login")->isEnabled());
    enter("password", "test-password");
    QVERIFY(button("login")->isEnabled());
    state["secureStorage"] = false;
    ui->applyState(state);
    QVERIFY(!button("login")->isEnabled());
    state["secureStorage"] = true;
    state["busy"] = true;
    ui->applyState(state);
    QVERIFY(!button("login")->isEnabled());
  }
  void enterSavesDirtySettingsBeforeLogin() {
    enter("loginDevice", "Desktop A");
    enter("password", "test-password");
    QTest::keyClick(get<QLineEdit>("password"), Qt::Key_Return);
    QCOMPARE(commands.size(), 2);
    QCOMPARE(commands[0].first, "save");
    QCOMPARE(commands[0].second["deviceName"].toString(), "Desktop A");
    QCOMPARE(commands[1].first, "login");
    QCOMPARE(commands[1].second["password"].toString(), "test-password");
    QVERIFY(get<QLineEdit>("password")->text().isEmpty());
  }
  void loginCannotDuplicateWhileWaiting() {
    ConnectorUi::Done reply;
    ui->command = [&](QString method, QJsonObject value,
                      ConnectorUi::Done done) {
      commands.append({method, value});
      reply = done;
    };
    enter("password", "test-password");
    button("login")->click();
    QTest::keyClick(get<QLineEdit>("password"), Qt::Key_Return);
    QCOMPARE(commands.size(), 1);
    reply({}, "login-failed");
    QVERIFY(get<QLineEdit>("password")->text().isEmpty());
    QCOMPARE(get<QLineEdit>("username")->text(), "test-user");
    enter("password", "retry");
    QVERIFY(button("login")->isEnabled());
  }
  void failedSaveDoesNotSendPassword() {
    ui->command = [&](QString method, QJsonObject value,
                      ConnectorUi::Done done) {
      commands.append({method, value});
      done({}, "save-failed");
    };
    enter("loginDevice", "changed");
    enter("password", "test-password");
    button("login")->click();
    QCOMPARE(commands.size(), 1);
    QCOMPARE(commands[0].first, "save");
    QVERIFY(!commands[0].second.contains("password"));
  }
  void draftsSurvivePageAndStatusChanges() {
    page(1);
    enter("settingsDevice", "Unsaved");
    page(0);
    QCOMPARE(get<QLineEdit>("loginDevice")->text(), "Unsaved");
    state["busy"] = true;
    ui->applyState(state);
    page(1);
    QCOMPARE(get<QLineEdit>("settingsDevice")->text(), "Unsaved");
    state["busy"] = false;
    ui->applyState(state);
    QVERIFY(button("save")->isEnabled());
    button("save")->click();
    QCOMPARE(commands.last().second["deviceName"].toString(), "Unsaved");
  }
  void authoritativeSavedSettingsRefreshDraft() {
    page(1);
    enter("settingsDevice", "Unsaved");
    auto settings = state["settings"].toObject();
    settings["deviceName"] = "Saved elsewhere";
    state["settings"] = settings;
    ui->applyState(state);
    QCOMPARE(get<QLineEdit>("settingsDevice")->text(), "Saved elsewhere");
    QVERIFY(!button("save")->isEnabled());
  }
  void connectDoesNotImplicitlySaveDraft() {
    state = fixture(true);
    ui->applyState(state);
    page(1);
    enter("settingsDevice", "Unsaved");
    page(0);
    button("connect")->click();
    QCOMPARE(commands.size(), 1);
    QCOMPARE(commands[0].first, "connect");
  }
  void disconnectRequiresConfirmationAndCancelIsSafe() {
    connected();
    button("disconnect")->click();
    QVERIFY(commands.isEmpty());
    auto dialog = ui->findChild<QDialog *>("confirmation");
    QVERIFY(dialog);
    dialog->findChild<QPushButton *>("cancelConfirmation")->click();
    QVERIFY(commands.isEmpty());
  }
  void logoutAndDisconnectConfirmCorrectCommand() {
    connected();
    button("logout")->click();
    auto dialog = ui->findChild<QDialog *>("confirmation");
    QVERIFY(dialog);
    dialog->findChild<QPushButton *>("confirmAction")->click();
    QCOMPARE(commands.last().first, "logout");
    QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
    button("disconnect")->click();
    dialog = ui->findChild<QDialog *>("confirmation");
    QVERIFY(dialog);
    dialog->findChild<QPushButton *>("confirmAction")->click();
    QCOMPARE(commands.last().first, "disconnect");
  }
  void folderPickerCancellationAndDedup() {
    page(1);
    ui->pick = [](QString) { return QString(); };
    button("addParent")->click();
    QVERIFY(!button("save")->isEnabled());
    ui->pick = [](QString) { return QString("C:/Projects"); };
    button("addParent")->click();
    button("addParent")->click();
    QCOMPARE(ui->findChildren<QPushButton *>("removeParent").size(), 1);
    button("save")->click();
    QCOMPARE(commands.last().second["projectParents"].toArray().size(), 1);
  }
  void folderCapAndRemovalAreDraftOnly() {
    auto settings = state["settings"].toObject();
    QJsonArray paths;
    for (int n = 0; n < 20; n++)
      paths.append("C:/Projects/" + QString::number(n));
    settings["projectParents"] = paths;
    state["settings"] = settings;
    ui->applyState(state);
    page(1);
    QVERIFY(!button("addParent")->isEnabled());
    ui->findChildren<QPushButton *>("removeParent")[0]->click();
    QVERIFY(button("addParent")->isEnabled());
    QVERIFY(commands.isEmpty());
    button("save")->click();
    QCOMPARE(commands.last().second["projectParents"].toArray().size(), 19);
  }
  void togglesAndPathsRequireExplicitSave() {
    page(1);
    QTest::mouseClick(get<QCheckBox>("autoConnect"), Qt::LeftButton);
    ui->pick = [](QString kind) {
      return kind == "home" ? QString("C:/中文 空格/Codex")
                            : QString("C:/Bin/codex.exe");
    };
    button("pickhome")->click();
    button("pickbinary")->click();
    QVERIFY(commands.isEmpty());
    button("save")->click();
    auto settings = commands.last().second;
    QVERIFY(settings["autoConnect"].toBool());
    QCOMPARE(settings["codexHome"].toString(),
             QString::fromUtf8("C:/中文 空格/Codex"));
  }
  void updateProgressCancellationAndVerifiedOpen() {
    page(1);
    QJsonObject update{
        {"version", "0.2.18"},
        {"available", true},
        {"downloading", true},
        {"progress", 0.42},
        {"release", QJsonObject{{"version", "0.2.19"},
                                {"notes", "Release notes"},
                                {"target", "agent-windows-x64-portable"}}}};
    ui->applyUpdate(update);
    QVERIFY(!button("updatesCheck")->isEnabled());
    QVERIFY(!button("updatesDownload")->isEnabled());
    QCOMPARE(button("updatesDownload")->text(), "下载中 42%");
    button("updatesCancel")->click();
    QCOMPARE(commands.last().first, "updates.cancel");
    update["downloading"] = false;
    update["downloaded"] = true;
    ui->applyUpdate(update);
    QCOMPARE(button("updatesOpen")->text(), "打开更新文件位置");
    button("updatesOpen")->click();
    QCOMPARE(commands.last().first, "updates.open");
  }
  void logsNewestFirstAndNoRebuildOnHeartbeat() {
    state["logs"] =
        QJsonArray{QJsonObject{{"at", 1000}, {"code", "console-ready"}},
                   QJsonObject{{"at", 2000}, {"code", "settings-saved"}}};
    ui->applyState(state);
    page(2);
    auto log = get<QListWidget>("diagnosticLogs");
    QVERIFY(log->item(0)->text().contains("settings-saved"));
    QVERIFY(log->item(1)->text().contains("console-ready"));
    QSignalSpy changed(log->model(), &QAbstractItemModel::modelReset);
    state["phase"] = "reconnecting";
    ui->applyState(state);
    QCOMPARE(changed.size(), 0);
  }
  void windowControlsAndNarrowLayout() {
    host->resize(940, 680);
    QTest::qWait(50);
    page(0);
    auto scroll = get<QScrollArea>("mainScroll");
    QCOMPARE(scroll->horizontalScrollBar()->maximum(), 0);
    QVERIFY(button("login")->width() > 100);
    button("maximize")->click();
    QTRY_VERIFY(host->isMaximized());
    QCOMPARE(button("maximize")->accessibleName(), "还原窗口");
    button("maximize")->click();
    QTRY_VERIFY(!host->isMaximized());
  }
  void statusWindowDoesNotActivateTextInputAndTitlebarDoubleClickWorks() {
    QVERIFY(!qobject_cast<QLineEdit *>(QApplication::focusWidget()));
    QTest::mouseDClick(ui->findChild<QWidget *>("titlebar"), Qt::LeftButton);
    QTRY_VERIFY(host->isMaximized());
    QCOMPARE(ui->layout()->contentsMargins().left(), 0);
  }
  void screenshots() {
    auto directory = qEnvironmentVariable("CODEXER_UI_SCREENSHOTS");
    if (directory.isEmpty())
      QSKIP("Set CODEXER_UI_SCREENSHOTS to capture native pages");
    QDir().mkpath(directory);
    for (int n = 0; n < 3; n++) {
      page(n);
      QTest::qWait(80);
      QVERIFY(host->grab().save(directory + "/page-" + QString::number(n) +
                                ".png"));
    }
    connected();
    page(0);
    QTest::qWait(80);
    host->grab().save(directory + "/connected.png");
    button("disconnect")->click();
    QTest::qWait(80);
    auto dialog = ui->findChild<QDialog *>("confirmation");
    QVERIFY(dialog);
    dialog->grab().save(directory + "/disconnect.png");
    dialog->reject();
    host->resize(940, 680);
    page(0);
    QTest::qWait(80);
    host->grab().save(directory + "/narrow.png");
  }
};
QTEST_MAIN(UiTests)
#include "ui_tests.moc"
