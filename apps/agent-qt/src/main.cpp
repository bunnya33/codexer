#include <QtWidgets>
#include <QtNetwork>
#include <functional>
#ifdef Q_OS_WIN
#include <windows.h>
#include <wincrypt.h>
#include <tlhelp32.h>
#endif

#ifdef Q_OS_MACOS
#include <signal.h>
QByteArray platformVault(const QByteArray &, bool, QString &);
bool platformLoginItem(bool, QString &);
#endif

static QString profilePath() {
  const auto override = qEnvironmentVariable("CODEXER_USER_DATA_DIR");
  if (!override.isEmpty()) return override;
#ifdef Q_OS_MACOS
  return QDir::homePath() + "/Library/Application Support/@codexer/desktop";
#else
  const auto base = qEnvironmentVariable("APPDATA");
  const auto stable = base + "/Codexer", legacy = base + "/@codexer/desktop";
  return QFile::exists(stable + "/settings.json") || !QFile::exists(legacy + "/settings.json") ? stable : legacy;
#endif
}
static QString launchPath() {
  const auto portable = qEnvironmentVariable("PORTABLE_EXECUTABLE_FILE");
  return portable.isEmpty() ? QCoreApplication::applicationFilePath() : portable;
}
static QByteArray vault(const QByteArray &data, bool encrypt, QString &error) {
  if (data.size() > 65636) {error = "invalid-vault-input"; return {};}
#ifdef Q_OS_WIN
  DATA_BLOB input{static_cast<DWORD>(data.size()), reinterpret_cast<BYTE *>(const_cast<char *>(data.constData()))}, output{};
  const bool ok = encrypt ? CryptProtectData(&input, L"Codexer Agent", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)
    : CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output);
  if (!ok) {error = "secure-storage-unavailable"; return {};}
  QByteArray result(reinterpret_cast<char *>(output.pbData), output.cbData); SecureZeroMemory(output.pbData, output.cbData); LocalFree(output.pbData); return result;
#elif defined(Q_OS_MACOS)
  return platformVault(data, encrypt, error);
#else
  error = "unsupported-platform"; return {};
#endif
}
static bool loginItem(bool enabled, QString &error) {
  if (qEnvironmentVariableIsSet("CODEXER_USER_DATA_DIR")) return true;
#ifdef Q_OS_WIN
  QSettings run("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", QSettings::NativeFormat);
  for (const auto &name : {"Codexer", "@codexer/desktop", "com.codexer.connector"}) run.remove(name);
  if (enabled) run.setValue("Codexer Agent", '"' + QDir::toNativeSeparators(launchPath()) + "\" --background");
  else run.remove("Codexer Agent");
  run.sync(); if (run.status() != QSettings::NoError) {error = "login-item-save-failed"; return false;} return true;
#elif defined(Q_OS_MACOS)
  return platformLoginItem(enabled, error);
#else
  error = "unsupported-platform"; return false;
#endif
}
static bool oldAgentRunning() {
  if (qEnvironmentVariableIsSet("CODEXER_USER_DATA_DIR")) return false;
#ifdef Q_OS_WIN
  const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0); if (snapshot == INVALID_HANDLE_VALUE) return true;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); bool found = false;
  if (Process32FirstW(snapshot, &entry)) do {
    if (entry.th32ProcessID != GetCurrentProcessId() && QString::fromWCharArray(entry.szExeFile).compare("Codexer Agent.exe", Qt::CaseInsensitive) == 0) {found = true; break;}
  } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot); return found;
#else
  QProcess check; check.start("/usr/bin/pgrep", {"-x", "Codexer Agent"}); check.waitForFinished(3000);
  for (const auto &pid : check.readAllStandardOutput().split('\n')) if (!pid.trimmed().isEmpty() && pid.toLongLong() != QCoreApplication::applicationPid()) return true;
  return false;
#endif
}
using Reply = std::function<void(QJsonValue, QString)>;

class AgentWindow : public QMainWindow {
  QProcess service;
  QByteArray buffer;
  QHash<int, Reply> replies;
  int sequence = 0;
  bool quitting = false, restart = false, reconnectAfterRestart = false, initialized = false, smoke = false, ready = false, startupProcessed = false;
  QJsonObject state, settings, update;
  QString profile, smokePath;
  QSystemTrayIcon *tray;
  QLabel *summary, *detail, *errorLabel, *version, *sessionResult, *updateInfo;
  QLineEdit *url, *username, *password, *device, *home, *binary;
  QPlainTextEdit *parents, *diagnostics;
  QCheckBox *autoConnect, *atLogin, *toTray, *allowHttp;
  QComboBox *runtime;
  QTabWidget *tabs;
  QList<QPushButton *> actions;
  QJsonObject smokeResults;
public:
  AgentWindow(bool smokeMode, QString report) : profile(profilePath()), smokePath(report) {
    smoke = smokeMode;
    setWindowTitle("Codexer Agent"); resize(850, 740); setMinimumSize(700, 640);
    const auto icon = QIcon(QCoreApplication::applicationDirPath() + "/icon.ico"); setWindowIcon(icon);
    auto central = new QWidget; auto layout = new QVBoxLayout(central); layout->setContentsMargins(28, 22, 28, 22); layout->setSpacing(15);
    auto title = new QLabel("Codexer Agent"); title->setStyleSheet("font-size:26px;font-weight:600;color:#173e68"); layout->addWidget(title);
    summary = new QLabel("正在启动连接器…"); summary->setStyleSheet("font-size:18px;font-weight:600"); layout->addWidget(summary);
    detail = new QLabel("登录并连接后，即可从控制端访问这台电脑。"); detail->setWordWrap(true); layout->addWidget(detail);
    errorLabel = new QLabel; errorLabel->setWordWrap(true); errorLabel->setStyleSheet("color:#b42318"); errorLabel->hide(); layout->addWidget(errorLabel);
    tabs = new QTabWidget; layout->addWidget(tabs, 1);
    auto account = new QWidget; auto accountLayout = new QVBoxLayout(account); auto form = new QFormLayout;
    url = new QLineEdit; url->setPlaceholderText("https://你的服务器地址"); form->addRow("服务器", url);
    username = new QLineEdit; form->addRow("账号", username);
    password = new QLineEdit; password->setEchoMode(QLineEdit::Password); form->addRow("密码", password); accountLayout->addLayout(form);
    auto loginButton = button("登录并连接", accountLayout, [this] {
      save([this] {const auto value = password->text(); password->clear(); request("login", {{"username", username->text()}, {"password", value}});});
    });
    connect(password, &QLineEdit::returnPressed, loginButton, &QPushButton::click);
    auto connection = new QHBoxLayout; accountLayout->addLayout(connection);
    button("连接", connection, [this] {request("connect");});
    button("暂停远程连接", connection, [this] {request("disconnect");});
    button("重新连接", connection, [this] {request("reconnect");});
    button("退出登录", accountLayout, [this] {
      if (QMessageBox::question(this, "退出登录", "退出账号后，控制端将不能访问这台电脑。继续吗？", QMessageBox::Yes | QMessageBox::No, QMessageBox::No) == QMessageBox::Yes) request("logout");
    });
    accountLayout->addStretch(); auto help = new QLabel("关闭窗口默认保留后台连接。可从系统托盘重新打开。\n密码仅用于登录，登录状态由系统加密保存。"); help->setWordWrap(true); accountLayout->addWidget(help); tabs->addTab(account, "账号与连接");
    auto config = new QWidget; auto configLayout = new QVBoxLayout(config); auto configForm = new QFormLayout;
    device = new QLineEdit; configForm->addRow("电脑名称", device);
    home = new QLineEdit; binary = new QLineEdit;
    configForm->addRow("Codex 数据目录", pickRow(home, false)); configForm->addRow("Codex 程序（可留空）", pickRow(binary, true));
    runtime = new QComboBox; runtime->addItem("自动选择", "auto"); runtime->addItem("官方桌面连接", "desktop"); runtime->addItem("独立后台服务", "headless"); configForm->addRow("运行方式", runtime);
    parents = new QPlainTextEdit; parents->setMaximumHeight(95); parents->setPlaceholderText("每行一个允许创建项目的父目录"); configForm->addRow("项目父目录", parents); configLayout->addLayout(configForm);
    autoConnect = new QCheckBox("启动后自动连接"); atLogin = new QCheckBox("登录系统后启动"); toTray = new QCheckBox("关闭窗口时保留在托盘"); allowHttp = new QCheckBox("允许 HTTP 服务器");
    for (auto check : {autoConnect, atLogin, toTray, allowHttp}) configLayout->addWidget(check);
    button("保存设置", configLayout, [this] {save();}); configLayout->addStretch(); tabs->addTab(config, "设置");
    auto sessions = new QWidget; auto sessionLayout = new QVBoxLayout(sessions);
    auto explanation = new QLabel("连接器会自动释放自己持有的空闲会话，方便你回到官方 Codex 继续。\n\n正在执行任务、等待审批或回复、有运行中子任务的会话会保留占用。刚创建且尚未发送消息的会话也会保留。"); explanation->setWordWrap(true); sessionLayout->addWidget(explanation);
    button("释放空闲会话", sessionLayout, [this] {releaseSessions();});
    button("刷新 Codex 运行时", sessionLayout, [this] {request("refreshRuntime", {}, [this](QJsonValue, QString error) {if (error.isEmpty()) sessionResult->setText("已请求刷新；有任务时会等待空闲再处理。");});});
    sessionResult = new QLabel; sessionResult->setWordWrap(true); sessionLayout->addWidget(sessionResult);
    auto limitation = new QLabel("如果控制端提示“会话已在其他应用中打开”，需先让持有会话的应用完成任务并释放会话。释放操作会保留历史、文件和当前会话，不会抢占其他程序。"); limitation->setWordWrap(true); sessionLayout->addWidget(limitation); sessionLayout->addStretch(); tabs->addTab(sessions, "会话与运行时");
    auto logs = new QWidget; auto logLayout = new QVBoxLayout(logs); diagnostics = new QPlainTextEdit; diagnostics->setReadOnly(true); logLayout->addWidget(diagnostics);
    button("导出诊断", logLayout, [this] {request("exportLogs");}); tabs->addTab(logs, "诊断");
    auto upgrades = new QWidget; auto upgradeLayout = new QVBoxLayout(upgrades); updateInfo = new QLabel("可检查服务器发布的连接器更新。"); updateInfo->setWordWrap(true); upgradeLayout->addWidget(updateInfo);
    button("检查更新", upgradeLayout, [this] {request("updates.check");});
    button("下载更新", upgradeLayout, [this] {request("updates.download");});
    button("取消下载", upgradeLayout, [this] {request("updates.cancel");});
    button("打开已下载的安装包", upgradeLayout, [this] {
      if (QMessageBox::question(this, "安装更新", "请先结束本机任务。安装程序打开后，可从托盘退出旧版连接器再完成安装。", QMessageBox::Ok | QMessageBox::Cancel) == QMessageBox::Ok) request("updates.open");
    }); upgradeLayout->addStretch(); tabs->addTab(upgrades, "版本与更新");
    auto footer = new QHBoxLayout; version = new QLabel; footer->addWidget(version); footer->addStretch();
    button("打开网页控制端", footer, [this] {request("openControl");}); layout->addLayout(footer); setCentralWidget(central);
    setStyleSheet("QWidget{font-family:'Microsoft YaHei UI','PingFang SC';font-size:13px;} QMainWindow{background:#f7f9fc;} QLineEdit,QPlainTextEdit,QComboBox{padding:7px;border:1px solid #ccd5df;border-radius:5px;background:white;} QPushButton{padding:8px 15px;border:1px solid #b9cce0;border-radius:5px;background:#f5f9ff;} QPushButton:hover{background:#e6f0fc;} QPushButton:disabled{color:#8894a2;background:#f1f3f5;} QTabWidget::pane{border:1px solid #d6dfe9;background:#fff;} QTabBar::tab{padding:10px 13px;} QCheckBox{padding:4px;}");
    tray = new QSystemTrayIcon(icon, this); auto menu = new QMenu(this);
    menu->addAction("显示连接器", this, [this] {restore();});
    menu->addAction("释放空闲会话", this, [this] {releaseSessions();});
    menu->addAction("刷新 Codex 运行时", this, [this] {request("refreshRuntime");});
    menu->addAction("版本与更新", this, [this] {restore(); tabs->setCurrentIndex(4); request("updates.check");}); menu->addSeparator();
    menu->addAction("重启 Codexer Agent", this, [this] {exitAgent(true);});
    menu->addAction("退出 Codexer Agent", this, [this] {exitAgent(false);}); tray->setContextMenu(menu); tray->setToolTip("Codexer Agent");
    connect(tray, &QSystemTrayIcon::activated, this, [this](auto reason) {if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) restore();});
    if (!smoke) tray->show();
    connect(&service, &QProcess::readyReadStandardOutput, this, [this] {receive();});
    connect(&service, &QProcess::readyReadStandardError, this, [this] {service.readAllStandardError();});
    connect(&service, &QProcess::errorOccurred, this, [this](auto) {showError("无法启动本机后台服务，请重新安装完整连接器。");});
    connect(&service, &QProcess::finished, this, [this](int, auto) {
      if (quitting) qApp->quit();
      else {summary->setText("后台服务已退出"); showError("后台服务已停止，请从托盘重启连接器。");}
    });
    auto environment = QProcessEnvironment::systemEnvironment();
    environment.insert("CODEXER_USER_DATA_DIR", profile); // loginItem suppression depends on the original test flag, supplied separately.
    if (!qEnvironmentVariableIsSet("CODEXER_USER_DATA_DIR")) environment.insert("CODEXER_QT_REAL_PROFILE", "1");
    service.setProcessEnvironment(environment);
    auto root = QCoreApplication::applicationDirPath();
    service.start(root + "/runtime/" +
#ifdef Q_OS_WIN
      "node.exe",
#else
      "node",
#endif
      {root + "/service/agent.cjs"});
    if (smoke) QTimer::singleShot(20000, this, [this] {if (!ready) {writeSmoke(false); qApp->exit(2);}});
  }
  void restore() {showNormal(); raise(); activateWindow();}
  bool restartRequested() const {return restart;}
  bool reconnectRequested() const {return reconnectAfterRestart;}
  void releaseSessions() {
    request("releaseSessions", {}, [this](QJsonValue value, QString error) {if (error.isEmpty()) {const auto result = value.toObject(); const auto message = QString("已释放 %1 个空闲会话；%2 个会话仍需等待任务或首次消息完成。").arg(result["released"].toInt()).arg(result["deferred"].toInt()); sessionResult->setText(message); if (!isVisible()) tray->showMessage("会话占用", message);}});
  }
  void exitAgent(bool reboot) {
    if (quitting) return;
    const bool active = state["status"].toObject()["activeTasks"].toInt() > 0;
    const auto message = active ? "仍有任务运行，退出或重启可能停止后台任务。继续吗？" : reboot ? "确认重启连接器？远程连接会短暂断开。" : "退出后，这台电脑将无法远程控制。确认退出？";
    if (!smoke && QMessageBox::question(this, reboot ? "重启连接器" : "退出连接器", message, QMessageBox::Yes | QMessageBox::No, QMessageBox::No) != QMessageBox::Yes) return;
    const auto phase = state["phase"].toString(); reconnectAfterRestart = phase == "connected" || phase == "connecting" || phase == "reconnecting";
    quitting = true; restart = reboot; tray->hide();
    request("shutdown", {}, [this](QJsonValue, QString) {service.closeWriteChannel();});
    QTimer::singleShot(12000, this, [this] {if (service.state() != QProcess::NotRunning) service.kill(); else qApp->quit();});
  }
protected:
  void closeEvent(QCloseEvent *event) override {
    if (quitting) {event->accept(); return;} event->ignore();
    if (settings["minimizeToTray"].toBool(true) && QSystemTrayIcon::isSystemTrayAvailable()) hide(); else exitAgent(false);
  }
private:
  template<typename Layout, typename Callback> QPushButton *button(QString text, Layout *layout, Callback callback) {
    auto control = new QPushButton(text); layout->addWidget(control); connect(control, &QPushButton::clicked, this, callback); actions.append(control); return control;
  }
  QWidget *pickRow(QLineEdit *edit, bool file) {
    auto row = new QWidget; auto layout = new QHBoxLayout(row); layout->setContentsMargins(0,0,0,0); layout->addWidget(edit);
    button("浏览", layout, [this, edit, file] {const auto value = file ? QFileDialog::getOpenFileName(this, "选择 Codex 程序") : QFileDialog::getExistingDirectory(this, "选择目录"); if (!value.isEmpty()) edit->setText(QDir::toNativeSeparators(value));}); return row;
  }
  void showError(QString text) {errorLabel->setText(text); errorLabel->setVisible(!text.isEmpty());}
  void request(QString method, QJsonObject value = {}, Reply callback = {}) {
    if (service.state() != QProcess::Running) {if (callback) callback({}, "service-unavailable"); return;}
    const int id = ++sequence; replies.insert(id, [this, callback](QJsonValue result, QString error) {if (!error.isEmpty()) showError(error); if (callback) callback(result, error);});
    service.write(QJsonDocument(QJsonObject{{"id", id}, {"method", method}, {"value", value}}).toJson(QJsonDocument::Compact) + '\n');
    QTimer::singleShot(45000, this, [this, id] {if (replies.contains(id)) {auto callback = replies.take(id); callback({}, "操作未及时完成，请查看连接与诊断。");}});
  }
  void save(std::function<void()> next = {}) {
    auto value = settings;
    value["relayUrl"] = url->text().trimmed(); value["username"] = username->text().trimmed(); value["deviceName"] = device->text().trimmed();
    value["codexHome"] = home->text(); value["codexBinary"] = binary->text(); value["runtime"] = runtime->currentData().toString();
    value["autoConnect"] = autoConnect->isChecked(); value["openAtLogin"] = atLogin->isChecked(); value["minimizeToTray"] = toTray->isChecked(); value["allowHttp"] = allowHttp->isChecked();
    QJsonArray paths; for (const auto &path : parents->toPlainText().split('\n')) if (!path.trimmed().isEmpty()) paths.append(path.trimmed()); value["projectParents"] = paths;
    request("save", value, [this, next](QJsonValue, QString error) {if (error.isEmpty()) {initialized = false; request("state", {}, [this, next](QJsonValue value, QString error) {if (error.isEmpty()) {apply(value.toObject()); if (next) next();}});}});
  }
  void apply(QJsonObject value) {
    state = value; settings = value["settings"].toObject();
    const auto phase = value["phase"].toString();
    const QMap<QString, QString> labels{{"signed-out", "尚未登录"}, {"disconnected", "远程连接已暂停"}, {"connecting", "正在连接…"}, {"connected", "已连接"}, {"reconnecting", "正在重新连接…"}};
    summary->setText(labels.value(phase, "正在启动…"));
    const auto status = value["status"].toObject();
    detail->setText(QString("%1 · %2 个会话 · %3 个运行任务").arg(settings["deviceName"].toString()).arg(status["threads"].toInt()).arg(status["activeTasks"].toInt()));
    version->setText("版本 " + value["version"].toString() + " · Qt");
    showError(value["error"].toString()); for (auto control : actions) control->setEnabled(!value["busy"].toBool());
    if (!initialized) {
      url->setText(settings["relayUrl"].toString()); username->setText(settings["username"].toString()); device->setText(settings["deviceName"].toString()); home->setText(settings["codexHome"].toString()); binary->setText(settings["codexBinary"].toString());
      runtime->setCurrentIndex(qMax(0, runtime->findData(settings["runtime"].toString())));
      QStringList paths; for (const auto &path : settings["projectParents"].toArray()) paths.append(path.toString()); parents->setPlainText(paths.join('\n'));
      autoConnect->setChecked(settings["autoConnect"].toBool()); atLogin->setChecked(settings["openAtLogin"].toBool()); toTray->setChecked(settings["minimizeToTray"].toBool(true)); allowHttp->setChecked(settings["allowHttp"].toBool()); initialized = true;
    }
    QStringList logs; for (const auto &entry : value["logs"].toArray()) {const auto item = entry.toObject(); logs.append(QDateTime::fromMSecsSinceEpoch(item["at"].toDouble()).toString("MM-dd HH:mm:ss") + "  " + item["code"].toString());}
    diagnostics->setPlainText(logs.join('\n')); diagnostics->verticalScrollBar()->setValue(diagnostics->verticalScrollBar()->maximum());
    if (!startupProcessed && logs.join('\n').contains("console-ready")) {
      startupProcessed = true;
      if (QCoreApplication::arguments().contains("--reconnect") && state["loggedIn"].toBool() && phase == "disconnected") request("connect");
      if (smoke && !ready) {ready = true; QTimer::singleShot(500, this, [this] {smokeTest();});}
    }
  }
  void receive() {
    buffer += service.readAllStandardOutput(); if (buffer.size() > 2 * 1024 * 1024) {service.kill(); return;}
    for (int index; (index = buffer.indexOf('\n')) >= 0;) {
      const auto line = buffer.left(index); buffer.remove(0, index + 1); const auto message = QJsonDocument::fromJson(line).object();
      if (message.contains("nativeId")) {platform(message); continue;}
      if (message.contains("id")) {const int id = message["id"].toInt(); if (replies.contains(id)) {auto callback = replies.take(id); callback(message["value"], message["error"].toString());} continue;}
      const auto event = message["event"].toString();
      if (event == "state") apply(message["value"].toObject());
      if (event == "fatal") showError(message["value"].toString());
      if (event == "updates") {
        update = message["value"].toObject(); auto release = update["release"].toObject(); const bool available = update["available"].toBool();
        updateInfo->setText(available ? "可更新至 " + release["version"].toString() + "\n" + release["notes"].toString() : "当前没有可用更新。");
        if (update["downloading"].toBool()) updateInfo->setText(QString("正在下载更新… %1%").arg(qRound(update["progress"].toDouble() * 100)));
        if (update["downloaded"].toBool()) updateInfo->setText("更新已下载并校验，可以打开安装包。");
        if (!update["error"].toString().isEmpty()) updateInfo->setText(update["error"].toString());
        tray->setToolTip(available ? "Codexer Agent · 有新版本" : "Codexer Agent"); tabs->setTabText(4, available ? "版本与更新 •" : "版本与更新");
        auto badge = windowIcon().pixmap(32, 32);
        if (available) {QPainter painter(&badge); painter.setRenderHint(QPainter::Antialiasing); painter.setPen(QPen(Qt::white, 2)); painter.setBrush(QColor("#e53e3e")); painter.drawEllipse(QPointF(25, 7), 5, 5);}
        tray->setIcon(QIcon(badge));
      }
    }
  }
  void platform(QJsonObject message) {
    const auto method = message["method"].toString(); const auto value = message["value"].toObject(); QString error; QJsonValue result;
    if (method == "protect" || method == "unprotect") {auto bytes = vault(QByteArray::fromBase64(value["value"].toString().toLatin1()), method == "protect", error); result = QString::fromLatin1(bytes.toBase64());}
    else if (method == "vault.available") {auto bytes = vault("probe", true, error); result = error.isEmpty() && !bytes.isEmpty();}
    else if (method == "loginItem") result = loginItem(value["enabled"].toBool(), error);
    else if (method == "saveDialog") result = QFileDialog::getSaveFileName(this, "保存诊断", QDir::homePath() + '/' + value["name"].toString());
    else if (method == "openUrl") {const QUrl target(value["url"].toString()); if (target.scheme() != "http" && target.scheme() != "https") error = "invalid-url"; else result = QDesktopServices::openUrl(target);}
    else if (method == "openPackage") result = QDesktopServices::openUrl(QUrl::fromLocalFile(value["path"].toString()));
    else if (method == "showPackage") result = QDesktopServices::openUrl(QUrl::fromLocalFile(QFileInfo(value["path"].toString()).absolutePath()));
    else error = "unknown-platform-operation";
    QJsonObject reply{{"nativeId", message["nativeId"]}, {"value", result}}; if (!error.isEmpty()) reply["error"] = error;
    service.write(QJsonDocument(reply).toJson(QJsonDocument::Compact) + '\n');
  }
  void writeSmoke(bool success) {
    smokeResults["ok"] = success; smokeResults["ui"] = "Qt Widgets"; smokeResults["qtVersion"] = qVersion(); smokeResults["version"] = state["version"]; smokeResults["secureStorage"] = state["secureStorage"]; smokeResults["tabs"] = tabs->count();
    smokeResults["processId"] = QCoreApplication::applicationPid(); smokeResults["backendPid"] = service.processId();
    smokeResults["loggedIn"] = state["loggedIn"]; smokeResults["installationId"] = settings["installationId"]; smokeResults["phase"] = state["phase"];
    QFile report(smokePath); if (report.open(QIODevice::WriteOnly)) report.write(QJsonDocument(smokeResults).toJson());
  }
  void smokeTest() {
    QString error; const auto encrypted = vault("isolated-credential-probe", true, error); const auto plain = vault(encrypted, false, error);
    smokeResults["vaultRoundTrip"] = error.isEmpty() && plain == "isolated-credential-probe";
    request("releaseSessions", {}, [this](QJsonValue value, QString error) {
      smokeResults["releaseReply"] = value; smokeResults["releaseError"] = error;
      auto checks = smokeResults["vaultRoundTrip"].toBool() && state["secureStorage"].toBool() && error.isEmpty();
      grab().save(smokePath + ".png"); writeSmoke(checks);
      const int hold = qEnvironmentVariableIntValue("CODEXER_QT_SMOKE_HOLD_MS");
      QTimer::singleShot(hold > 0 ? hold : 30000, this, [this] {exitAgent(false);});
    });
  }
};
int main(int argc, char **argv) {
  QApplication app(argc, argv); app.setApplicationName("Codexer Agent"); app.setOrganizationName("Codexer"); app.setQuitOnLastWindowClosed(false);
  const auto arguments = app.arguments(); const bool smoke = arguments.contains("--smoke-test");
#ifdef Q_OS_WIN
  const int parentIndex = arguments.indexOf("--restart-parent");
  if (parentIndex >= 0 && parentIndex + 1 < arguments.size()) {
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, arguments[parentIndex + 1].toUInt());
    if (parent) {const auto result = WaitForSingleObject(parent, 15000); CloseHandle(parent); if (result != WAIT_OBJECT_0) return 1;}
  }
#elif defined(Q_OS_MACOS)
  const int parentIndex = arguments.indexOf("--restart-parent");
  if (parentIndex >= 0 && parentIndex + 1 < arguments.size()) {
    const auto parent = arguments[parentIndex + 1].toInt(); QElapsedTimer wait; wait.start();
    while (parent > 0 && kill(parent, 0) == 0 && wait.elapsed() < 15000) QThread::msleep(50);
  }
#endif
  if (smoke && !qEnvironmentVariableIsSet("CODEXER_USER_DATA_DIR")) return 2;
  const auto key = "codexer-agent-" + QCryptographicHash::hash(profilePath().toUtf8(), QCryptographicHash::Sha256).toHex().left(24);
  QDir().mkpath(profilePath()); QLockFile lock(profilePath() + "/agent-qt.lock"); lock.setStaleLockTime(0);
  if (!lock.tryLock()) {QLocalSocket socket; socket.connectToServer(key); if (socket.waitForConnected(1000)) {socket.write("show"); socket.waitForBytesWritten(1000);} return 0;}
  if (oldAgentRunning()) {QMessageBox::information(nullptr, "旧版连接器仍在运行", "请先在旧版 Codexer Agent 托盘中退出，再启动 Qt 版。原配置与登录会保留。"); return 1;}
  QLocalServer::removeServer(key); QLocalServer server; server.listen(key);
  AgentWindow window(smoke, qEnvironmentVariable("CODEXER_QT_SMOKE_REPORT"));
  QObject::connect(&server, &QLocalServer::newConnection, &window, [&] {auto socket = server.nextPendingConnection(); socket->deleteLater(); window.restore();});
  if (!arguments.contains("--background")) window.show();
  const int result = app.exec();
  if (window.restartRequested()) {QStringList flags{"--restart-parent", QString::number(QCoreApplication::applicationPid())}; if (window.reconnectRequested()) flags.append("--reconnect"); lock.unlock(); QProcess::startDetached(launchPath(), flags);}
  return result;
}
