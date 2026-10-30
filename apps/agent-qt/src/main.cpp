#include "connector_ui.h"
#include "native.h"
#include <QtNetwork>
#include <QtWidgets>
#include <functional>
#ifdef Q_OS_WIN
// clang-format off: Windows SDK types must be defined before bcrypt.h.
#include <windows.h>
#include <bcrypt.h>
#include <dwmapi.h>
#include <tlhelp32.h>
#include <wincrypt.h>
// clang-format on
#endif

#ifdef Q_OS_MACOS
#include <signal.h>
QByteArray platformVault(const QByteArray &, bool, QString &);
bool platformLoginItem(bool, QString &);
#endif

static QString profilePath() {
  const auto override = qEnvironmentVariable("CODEXER_USER_DATA_DIR");
  if (!override.isEmpty())
    return override;
#ifdef Q_OS_MACOS
  return QDir::homePath() + "/Library/Application Support/@codexer/desktop";
#else
  const auto base = qEnvironmentVariable("APPDATA");
  const auto stable = base + "/Codexer", legacy = base + "/@codexer/desktop";
  return QFile::exists(stable + "/settings.json") ||
                 !QFile::exists(legacy + "/settings.json")
             ? stable
             : legacy;
#endif
}
static QString launchPath() {
  const auto portable = qEnvironmentVariable("PORTABLE_EXECUTABLE_FILE");
  return portable.isEmpty() ? QCoreApplication::applicationFilePath()
                            : portable;
}
static QByteArray vault(const QByteArray &data, bool encrypt, QString &error) {
  if (data.size() > 65636) {
    error = "invalid-vault-input";
    return {};
  }
#ifdef Q_OS_WIN
  DATA_BLOB input{
      static_cast<DWORD>(data.size()),
      reinterpret_cast<BYTE *>(const_cast<char *>(data.constData()))},
      output{};
  const bool ok =
      encrypt ? CryptProtectData(&input, L"Codexer Agent", nullptr, nullptr,
                                 nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)
              : CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr,
                                   CRYPTPROTECT_UI_FORBIDDEN, &output);
  if (!ok) {
    error = "secure-storage-unavailable";
    return {};
  }
  QByteArray result(reinterpret_cast<char *>(output.pbData), output.cbData);
  SecureZeroMemory(output.pbData, output.cbData);
  LocalFree(output.pbData);
  return result;
#elif defined(Q_OS_MACOS)
  return platformVault(data, encrypt, error);
#else
  error = "unsupported-platform";
  return {};
#endif
}
static bool loginItem(bool enabled, QString &error) {
  if (qEnvironmentVariableIsSet("CODEXER_USER_DATA_DIR"))
    return true;
#ifdef Q_OS_WIN
  QSettings run(
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      QSettings::NativeFormat);
  for (const auto &name :
       {"Codexer", "@codexer/desktop", "com.codexer.connector"})
    run.remove(name);
  if (enabled)
    run.setValue("Codexer Agent", '"' + QDir::toNativeSeparators(launchPath()) +
                                      "\" --background");
  else
    run.remove("Codexer Agent");
  run.sync();
  if (run.status() != QSettings::NoError) {
    error = "login-item-save-failed";
    return false;
  }
  return true;
#elif defined(Q_OS_MACOS)
  return platformLoginItem(enabled, error);
#else
  error = "unsupported-platform";
  return false;
#endif
}
static bool oldAgentRunning() {
  if (qEnvironmentVariableIsSet("CODEXER_USER_DATA_DIR"))
    return false;
#ifdef Q_OS_WIN
  const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    return true;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool found = false;
  if (Process32FirstW(snapshot, &entry))
    do {
      if (entry.th32ProcessID != GetCurrentProcessId() &&
          QString::fromWCharArray(entry.szExeFile)
                  .compare("Codexer Agent.exe", Qt::CaseInsensitive) == 0) {
        found = true;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot);
  return found;
#else
  QProcess check;
  check.start("/usr/bin/pgrep", {"-x", "Codexer Agent"});
  check.waitForFinished(3000);
  for (const auto &pid : check.readAllStandardOutput().split('\n'))
    if (!pid.trimmed().isEmpty() &&
        pid.toLongLong() != QCoreApplication::applicationPid())
      return true;
  return false;
#endif
}
using Reply = std::function<void(QJsonValue, QString)>;
static QByteArray legacyUnprotect(const QByteArray &bytes,
                                  const QByteArray &wrapped, QString &error) {
#ifdef Q_OS_WIN
  if (!bytes.startsWith("v10") || bytes.size() < 31 ||
      !wrapped.startsWith("DPAPI")) {
    error = "unsupported-credential-key";
    return {};
  }
  auto key = vault(wrapped.mid(5), false, error);
  if (!error.isEmpty() || key.size() != 32)
    return {};
  BCRYPT_ALG_HANDLE algorithm{};
  BCRYPT_KEY_HANDLE handle{};
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_AES_ALGORITHM, nullptr,
                                  0) < 0) {
    error = "secure-storage-unavailable";
    return {};
  }
  BCryptSetProperty(
      algorithm, BCRYPT_CHAINING_MODE,
      reinterpret_cast<PUCHAR>(const_cast<wchar_t *>(BCRYPT_CHAIN_MODE_GCM)),
      sizeof(BCRYPT_CHAIN_MODE_GCM), 0);
  QByteArray plain(bytes.size() - 31, '\0');
  ULONG written = 0;
  BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
  BCRYPT_INIT_AUTH_MODE_INFO(info);
  info.pbNonce =
      reinterpret_cast<PUCHAR>(const_cast<char *>(bytes.constData() + 3));
  info.cbNonce = 12;
  info.pbTag = reinterpret_cast<PUCHAR>(
      const_cast<char *>(bytes.constData() + bytes.size() - 16));
  info.cbTag = 16;
  NTSTATUS status = BCryptGenerateSymmetricKey(
      algorithm, &handle, nullptr, 0, reinterpret_cast<PUCHAR>(key.data()),
      key.size(), 0);
  if (status >= 0)
    status = BCryptDecrypt(
        handle,
        reinterpret_cast<PUCHAR>(const_cast<char *>(bytes.constData() + 15)),
        bytes.size() - 31, &info, nullptr, 0,
        reinterpret_cast<PUCHAR>(plain.data()), plain.size(), &written, 0);
  SecureZeroMemory(key.data(), key.size());
  if (handle)
    BCryptDestroyKey(handle);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) {
    error = "credential-decryption-failed";
    return {};
  }
  plain.resize(written);
  return plain;
#else
  return vault(bytes, false, error);
#endif
}

class AgentWindow : public QMainWindow {
  Native::Service *service = nullptr;
  QThread worker;
  ConnectorUi *ui = nullptr;
  QHash<int, Reply> replies;
  int sequence = 0;
  bool quitting = false, restart = false, reconnectAfterRestart = false,
       smoke = false, ready = false, startupProcessed = false;
  QJsonObject state, update, smokeResults;
  QString profile, smokePath;
  QSystemTrayIcon *tray;
  QAction *trayConnect, *trayDisconnect, *trayReconnect, *trayRefresh,
      *trayRelease, *trayStatus;

public:
  AgentWindow(bool smokeMode, QString report)
      : profile(profilePath()), smokePath(report), smoke(smokeMode) {
    setWindowTitle("Codexer Agent · 桌面连接器");
    setWindowFlags(Qt::Window | Qt::FramelessWindowHint |
                   Qt::WindowMinMaxButtonsHint);
    resize(1180, 800);
    setMinimumSize(940, 680);
    const auto icon =
        QIcon(QCoreApplication::applicationDirPath() + "/icon.ico");
    setWindowIcon(icon);
    if (!QCoreApplication::arguments().contains("--background") || smoke)
      createUi();
    tray = new QSystemTrayIcon(icon, this);
    auto menu = new QMenu(this);
    trayStatus = menu->addAction("Codexer Agent · 未登录");
    trayStatus->setEnabled(false);
    menu->addAction("显示控制台", this, [this] { restore(); });
    menu->addAction("版本与更新", this, [this] {
      restore();
      ui->selectPage(1);
      request("updates.check");
    });
    menu->addSeparator();
    trayConnect = menu->addAction("连接", this, [this] { request("connect"); });
    trayDisconnect = menu->addAction("断开远程连接", this,
                                     [this] { request("disconnect"); });
    trayReconnect =
        menu->addAction("重连", this, [this] { request("reconnect"); });
    trayRefresh = menu->addAction("刷新 Codex 运行时", this,
                                  [this] { request("refreshRuntime"); });
    trayRelease =
        menu->addAction("释放空闲会话", this, [this] { releaseSessions(); });
    menu->addSeparator();
    menu->addAction("重启 Codexer Agent", this, [this] { exitAgent(true); });
    menu->addAction("退出 Codexer Agent", this, [this] { exitAgent(false); });
    tray->setContextMenu(menu);
    connect(tray, &QSystemTrayIcon::activated, this, [this](auto reason) {
      if (reason == QSystemTrayIcon::Trigger ||
          reason == QSystemTrayIcon::DoubleClick)
        restore();
    });
    if (!smoke)
      tray->show();
    service = new Native::Service(profile);
    service->moveToThread(&worker);
    connect(&worker, &QThread::started, service, &Native::Service::start);
    connect(&worker, &QThread::finished, service, &QObject::deleteLater);
    connect(service, &Native::Service::message, this,
            [this](QJsonObject value) { receive(value); });
    connect(service, &Native::Service::finished, this, [this] {
      worker.quit();
      qApp->quit();
    });
    worker.start();
    if (smoke)
      QTimer::singleShot(20000, this, [this] {
        if (!ready) {
          writeSmoke(false);
          qApp->exit(2);
        }
      });
  }
  ~AgentWindow() override {
    if (worker.isRunning()) {
      QMetaObject::invokeMethod(
          service,
          [this] { service->submit({{"id", -1}, {"method", "shutdown"}}); },
          Qt::QueuedConnection);
      worker.quit();
      worker.wait(15000);
    }
  }
  void restore() {
    createUi();
    if (isMinimized())
      showNormal();
    else
      show();
    raise();
    activateWindow();
  }
  bool restartRequested() const { return restart; }
  bool reconnectRequested() const { return reconnectAfterRestart; }
  void releaseSessions() {
    request("releaseSessions", {}, [this](QJsonValue value, QString error) {
      if (error.isEmpty()) {
        auto r = value.toObject();
        auto note = QString("已释放 %1 个空闲会话；%2 个会话仍需等待。")
                        .arg(r["released"].toInt())
                        .arg(r["deferred"].toInt());
        if (ui)
          ui->showNote(note);
        if (!isVisible())
          tray->showMessage("会话占用", note);
      }
    });
  }
  void exitAgent(bool reboot) {
    if (quitting)
      return;
    bool active = state["status"].toObject()["activeTasks"].toInt() > 0;
    if (!smoke) {
      QMessageBox box(active ? QMessageBox::Warning : QMessageBox::Question,
                      reboot ? "重启 Codexer Agent" : "退出 Codexer Agent",
                      active   ? "本机仍有任务运行"
                      : reboot ? "重启 Codexer Agent？"
                               : "退出 Codexer Agent？",
                      QMessageBox::NoButton, this);
      box.setInformativeText(
          reboot ? (active ? "重启会停止由连接器启动的本机任务。刷新 Codex "
                             "运行时可以等待任务结束后再切换。"
                           : "将重新打开 "
                             "Agent，保留配置和登录状态，并恢复当前远程连接。")
                 : (active ? "退出会停止由连接器启动的本机运行服务。仅想停止远"
                             "程控制时，请使用“断开”。"
                           : "退出后这台电脑将无法远程控制。关闭窗口可以继续在"
                             "后台运行。"));
      auto cancel = box.addButton("留在后台", QMessageBox::RejectRole);
      auto accept =
          box.addButton(reboot ? "重启" : "退出", QMessageBox::AcceptRole);
      box.setDefaultButton(cancel);
      box.exec();
      if (box.clickedButton() != accept)
        return;
    }
    const auto phase = state["phase"].toString();
    reconnectAfterRestart = phase == "connected" || phase == "connecting" ||
                            phase == "reconnecting";
    quitting = true;
    restart = reboot;
    tray->hide();
    request("shutdown");
  }

protected:
  void showEvent(QShowEvent *event) override {
    QMainWindow::showEvent(event);
#ifdef Q_OS_WIN
    // Keep the system resize frame for compositor shadows, while NCCALCSIZE
    // below makes its caption area part of our native custom title bar.
    const auto handle = reinterpret_cast<HWND>(winId());
    const auto style = GetWindowLongPtrW(handle, GWL_STYLE);
    const auto wanted = style | WS_THICKFRAME | WS_CAPTION | WS_SYSMENU |
                        WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
    if (style != wanted) {
      SetWindowLongPtrW(handle, GWL_STYLE, wanted);
      SetWindowPos(handle, nullptr, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE |
                       SWP_FRAMECHANGED);
    }
    DWMNCRENDERINGPOLICY policy = DWMNCRP_ENABLED;
    DwmSetWindowAttribute(handle, DWMWA_NCRENDERING_POLICY, &policy,
                          sizeof(policy));
    const MARGINS shadow{1, 1, 1, 1};
    DwmExtendFrameIntoClientArea(handle, &shadow);
    DWM_WINDOW_CORNER_PREFERENCE corners = DWMWCP_ROUND;
    DwmSetWindowAttribute(handle, DWMWA_WINDOW_CORNER_PREFERENCE, &corners,
                          sizeof(corners));
    const COLORREF border = RGB(190, 190, 190);
    DwmSetWindowAttribute(handle, DWMWA_BORDER_COLOR, &border, sizeof(border));
#endif
  }
  void closeEvent(QCloseEvent *event) override {
    if (quitting) {
      event->accept();
      return;
    }
    event->ignore();
    if (state["settings"].toObject()["minimizeToTray"].toBool(true) &&
        QSystemTrayIcon::isSystemTrayAvailable())
      hide();
    else
      exitAgent(false);
  }
  bool nativeEvent(const QByteArray &kind, void *data,
                   qintptr *result) override {
#ifdef Q_OS_WIN
    auto msg = static_cast<MSG *>(data);
    if (msg->message == WM_NCCALCSIZE && msg->wParam) {
      if (IsZoomed(msg->hwnd)) {
        MONITORINFO monitor{sizeof(MONITORINFO)};
        if (GetMonitorInfoW(
                MonitorFromWindow(msg->hwnd, MONITOR_DEFAULTTONEAREST),
                &monitor))
          reinterpret_cast<NCCALCSIZE_PARAMS *>(msg->lParam)->rgrc[0] =
              monitor.rcWork;
      }
      *result = 0;
      return true;
    }
    if (msg->message == WM_NCHITTEST && !isMaximized()) {
      RECT r;
      GetWindowRect(msg->hwnd, &r);
      const int x = short(LOWORD(msg->lParam)), y = short(HIWORD(msg->lParam)),
                border = qRound(6 * devicePixelRatioF());
      bool l = x < r.left + border, t = y < r.top + border,
           right = x >= r.right - border, b = y >= r.bottom - border;
      if (l || t || right || b) {
        *result = t   ? (l       ? HTTOPLEFT
                         : right ? HTTOPRIGHT
                                 : HTTOP)
                  : b ? (l       ? HTBOTTOMLEFT
                         : right ? HTBOTTOMRIGHT
                                 : HTBOTTOM)
                  : l ? HTLEFT
                      : HTRIGHT;
        return true;
      }
    }
#endif
    return QMainWindow::nativeEvent(kind, data, result);
  }

private:
  void createUi() {
    if (ui)
      return;
    ui = new ConnectorUi(this);
    setCentralWidget(ui);
    ui->command = [this](QString method, QJsonObject value,
                         ConnectorUi::Done done) {
      request(method, value, done);
    };
    ui->pick = [this](QString kind) {
      return kind == "binary"
                 ? QFileDialog::getOpenFileName(this, "选择 Codex 可执行文件")
                 : QFileDialog::getExistingDirectory(
                       this, kind == "project" ? "授权新建项目的父目录"
                                               : "选择 Codex 数据目录");
    };
    if (!state.isEmpty())
      ui->applyState(state);
    ui->applyUpdate(update);
  }
  void request(QString method, QJsonObject value = {}, Reply callback = {}) {
    if (!worker.isRunning()) {
      if (callback)
        callback({}, "service-unavailable");
      return;
    }
    int id = ++sequence;
    replies.insert(id, [this, callback](QJsonValue value, QString error) {
      if (ui && !error.isEmpty())
        ui->showError(error);
      if (callback)
        callback(value, error);
    });
    QMetaObject::invokeMethod(
        service,
        [this, id, method, value] {
          service->submit({{"id", id}, {"method", method}, {"value", value}});
        },
        Qt::QueuedConnection);
    QTimer::singleShot(45000, this, [this, id] {
      if (replies.contains(id)) {
        auto cb = replies.take(id);
        cb({}, "操作未及时完成，请查看诊断日志。");
      }
    });
  }
  void apply(QJsonObject value) {
    state = value;
    if (ui)
      ui->applyState(value);
    const auto phase = value["phase"].toString();
    const bool logged = value["loggedIn"].toBool(),
               busy = value["busy"].toBool();
    auto label = phase == "connected"      ? "已连接"
                 : phase == "signed-out"   ? "未登录"
                 : phase == "disconnected" ? "已断开"
                                           : "连接中";
    tray->setToolTip("Codexer Agent · " + QString(label));
    trayStatus->setText("Codexer Agent · " + QString(label));
    trayConnect->setEnabled(logged && !busy && phase == "disconnected");
    trayDisconnect->setEnabled(phase != "disconnected" &&
                               phase != "signed-out" && !busy);
    trayReconnect->setEnabled(logged && !busy);
    trayRefresh->setEnabled(logged && !busy && value["status"].isObject());
    trayRelease->setEnabled(trayRefresh->isEnabled());
    if (!startupProcessed) {
      for (const auto &log : value["logs"].toArray())
        if (log.toObject()["code"] == "console-ready") {
          startupProcessed = true;
          if (QCoreApplication::arguments().contains("--reconnect") && logged &&
              phase == "disconnected")
            request("connect");
          request("updates.state", {}, [this](QJsonValue value, QString) {
            update = value.toObject();
            if (ui)
              ui->applyUpdate(update);
          });
          if (smoke && !ready) {
            ready = true;
            QTimer::singleShot(500, this, [this] { smokeTest(); });
          }
          break;
        }
    }
  }
  void receive(QJsonObject message) {
    if (message.contains("nativeId")) {
      platform(message);
      return;
    }
    if (message.contains("id")) {
      int id = message["id"].toInt();
      if (replies.contains(id)) {
        auto cb = replies.take(id);
        cb(message["value"], message["error"].toString());
      }
      return;
    }
    auto event = message["event"].toString();
    if (event == "state")
      apply(message["value"].toObject());
    if (event == "fatal" && ui)
      ui->showError(message["value"].toString());
    if (event == "updates") {
      update = message["value"].toObject();
      if (ui)
        ui->applyUpdate(update);
      auto badge = windowIcon().pixmap(32, 32);
      if (update["available"].toBool()) {
        QPainter painter(&badge);
        painter.setPen(QPen(Qt::white, 2));
        painter.setBrush(QColor("#e53e3e"));
        painter.drawEllipse(QPointF(25, 7), 5, 5);
      }
      tray->setIcon(QIcon(badge));
    }
  }
  void platform(QJsonObject message) {
    auto method = message["method"].toString();
    const auto value = message["value"].toObject();
    QString error;
    QJsonValue result;
    if (method == "protect" || method == "unprotect") {
      auto bytes =
          vault(QByteArray::fromBase64(value["value"].toString().toLatin1()),
                method == "protect", error);
      result = QString::fromLatin1(bytes.toBase64());
    } else if (method == "legacyUnprotect") {
      auto bytes = legacyUnprotect(
          QByteArray::fromBase64(value["value"].toString().toLatin1()),
          QByteArray::fromBase64(value["key"].toString().toLatin1()), error);
      result = QString::fromLatin1(bytes.toBase64());
    } else if (method == "vault.available") {
      auto bytes = vault("probe", true, error);
      result = error.isEmpty() && !bytes.isEmpty();
    } else if (method == "loginItem")
      result = loginItem(value["enabled"].toBool(), error);
    else if (method == "saveDialog")
      result = QFileDialog::getSaveFileName(
          this, "导出脱敏诊断",
          QDir::homePath() + '/' + value["name"].toString(), "JSON (*.json)");
    else if (method == "openUrl") {
      QUrl target(value["url"].toString());
      if (target.scheme() != "http" && target.scheme() != "https")
        error = "invalid-url";
      else
        result = QDesktopServices::openUrl(target);
    } else if (method == "openPackage")
      result = QDesktopServices::openUrl(
          QUrl::fromLocalFile(value["path"].toString()));
    else if (method == "showPackage") {
#ifdef Q_OS_WIN
      result = QProcess::startDetached(
          "explorer.exe",
          {"/select," + QDir::toNativeSeparators(value["path"].toString())});
#else
      result = QDesktopServices::openUrl(QUrl::fromLocalFile(
          QFileInfo(value["path"].toString()).absolutePath()));
#endif
    } else
      error = "unknown-platform-operation";
    QJsonObject reply{{"nativeId", message["nativeId"]}, {"value", result}};
    if (!error.isEmpty())
      reply["error"] = error;
    QMetaObject::invokeMethod(
        service, [this, reply] { service->submit(reply); },
        Qt::QueuedConnection);
  }
  void writeSmoke(bool success) {
#ifdef Q_OS_WIN
    const auto handle = reinterpret_cast<HWND>(winId());
    BOOL composition = false, rendering = false;
    DWORD corner = 0;
    DwmIsCompositionEnabled(&composition);
    DwmGetWindowAttribute(handle, DWMWA_NCRENDERING_ENABLED, &rendering,
                          sizeof(rendering));
    const auto rounded = DwmGetWindowAttribute(
        handle, DWMWA_WINDOW_CORNER_PREFERENCE, &corner, sizeof(corner));
    smokeResults["windowChrome"] = QJsonObject{
        {"composition", bool(composition)},
        {"nonClientRendering", bool(rendering)},
        {"cornerPreference", int(corner)},
        {"roundingSupported", SUCCEEDED(rounded)},
        { "resizeFrame",
          bool(GetWindowLongPtrW(handle, GWL_STYLE) & WS_THICKFRAME) }};
#endif
    smokeResults["ok"] = success;
    smokeResults["ui"] = "Qt Widgets";
    smokeResults["qtVersion"] = qVersion();
    smokeResults["version"] = state["version"];
    smokeResults["secureStorage"] = state["secureStorage"];
    smokeResults["tabs"] = ui->pageCount();
    smokeResults["processId"] = QCoreApplication::applicationPid();
    smokeResults["backendPid"] = QCoreApplication::applicationPid();
    smokeResults["backend"] = "C++/Qt";
    smokeResults["nodeRuntime"] = false;
    smokeResults["loggedIn"] = state["loggedIn"];
    smokeResults["installationId"] =
        state["settings"].toObject()["installationId"];
    smokeResults["phase"] = state["phase"];
    smokeResults["status"] = state["status"];
    smokeResults["startupError"] = state["startupError"];
    QFile report(smokePath);
    if (report.open(QIODevice::WriteOnly))
      report.write(QJsonDocument(smokeResults).toJson());
  }
  void smokeTest() {
    QString error;
    auto encrypted = vault("isolated-credential-probe", true, error),
         plain = vault(encrypted, false, error);
    smokeResults["vaultRoundTrip"] =
        error.isEmpty() && plain == "isolated-credential-probe";
    request("releaseSessions", {}, [this](QJsonValue value, QString error) {
      smokeResults["releaseReply"] = value;
      smokeResults["releaseError"] = error;
      const bool capture =
          qEnvironmentVariableIsSet("CODEXER_QT_SMOKE_CAPTURE");
      smokeResults["screenshotCaptured"] = capture;
      if (capture)
        grab().save(smokePath + ".png");
      writeSmoke(smokeResults["vaultRoundTrip"].toBool() &&
                 state["secureStorage"].toBool() && error.isEmpty());
      int hold = qEnvironmentVariableIntValue("CODEXER_QT_SMOKE_HOLD_MS");
      QTimer::singleShot(hold > 0 ? hold : 30000, this,
                         [this] { exitAgent(false); });
    });
  }
};
int main(int argc, char **argv) {
  QApplication app(argc, argv);
  app.setApplicationName("Codexer Agent");
  app.setOrganizationName("Codexer");
  app.setQuitOnLastWindowClosed(false);
  const auto arguments = app.arguments();
  const bool smoke = arguments.contains("--smoke-test");
#ifdef Q_OS_WIN
  const int parentIndex = arguments.indexOf("--restart-parent");
  if (parentIndex >= 0 && parentIndex + 1 < arguments.size()) {
    HANDLE parent =
        OpenProcess(SYNCHRONIZE, FALSE, arguments[parentIndex + 1].toUInt());
    if (parent) {
      const auto result = WaitForSingleObject(parent, 15000);
      CloseHandle(parent);
      if (result != WAIT_OBJECT_0)
        return 1;
    }
  }
#elif defined(Q_OS_MACOS)
  const int parentIndex = arguments.indexOf("--restart-parent");
  if (parentIndex >= 0 && parentIndex + 1 < arguments.size()) {
    const auto parent = arguments[parentIndex + 1].toInt();
    QElapsedTimer wait;
    wait.start();
    while (parent > 0 && kill(parent, 0) == 0 && wait.elapsed() < 15000)
      QThread::msleep(50);
  }
#endif
  if (smoke && !qEnvironmentVariableIsSet("CODEXER_USER_DATA_DIR"))
    return 2;
  const auto key =
      "codexer-agent-" + QCryptographicHash::hash(profilePath().toUtf8(),
                                                  QCryptographicHash::Sha256)
                             .toHex()
                             .left(24);
  QDir().mkpath(profilePath());
  QLockFile lock(profilePath() + "/agent-qt.lock");
  lock.setStaleLockTime(0);
  if (!lock.tryLock()) {
    QLocalSocket socket;
    socket.connectToServer(key);
    if (socket.waitForConnected(1000)) {
      socket.write("show");
      socket.waitForBytesWritten(1000);
    }
    return 0;
  }
  if (oldAgentRunning()) {
    QMessageBox::information(nullptr, "旧版连接器仍在运行",
                             "请先在旧版 Codexer Agent 托盘中退出，再启动 Qt "
                             "版。原配置与登录会保留。");
    return 1;
  }
  QLocalServer::removeServer(key);
  QLocalServer server;
  server.listen(key);
  AgentWindow window(smoke, qEnvironmentVariable("CODEXER_QT_SMOKE_REPORT"));
  QObject::connect(&server, &QLocalServer::newConnection, &window, [&] {
    auto socket = server.nextPendingConnection();
    socket->deleteLater();
    window.restore();
  });
  if (!arguments.contains("--background"))
    window.show();
  const int result = app.exec();
  if (window.restartRequested()) {
    QStringList flags{"--restart-parent",
                      QString::number(QCoreApplication::applicationPid())};
    if (window.reconnectRequested())
      flags.append("--reconnect");
    lock.unlock();
    QProcess::startDetached(launchPath(), flags);
  }
  return result;
}
