#pragma once
#include <QtWidgets>
#include <functional>

// Native rendering of the Electron connector's three pages; no web renderer.
class ConnectorUi : public QWidget {
public:
  using Done = std::function<void(QJsonValue, QString)>;
  std::function<void(QString, QJsonObject, Done)> command;
  std::function<QString(QString)> pick;
  explicit ConnectorUi(QWidget *parent = nullptr);
  void applyState(const QJsonObject &value);
  void applyUpdate(const QJsonObject &value);
  void selectPage(int page);
  void showNote(const QString &value);
  void showError(const QString &value);
  int pageCount() const { return 3; }

private:
  QJsonObject state, draft, saved, updates;
  bool syncing = false, pending = false;
  int selected = 0;
  QFrame *sidebar, *notice, *connectionCard, *metrics, *loginCard, *accountCard;
  QScrollArea *scroll;
  QStackedWidget *pages;
  QLabel *heading, *subtitle, *badge, *noticeText, *version, *footerDevice,
      *footerTime, *diagramDevice, *diagramServer, *linkStatus,
      *connectionTitle, *connectionHelp, *runtimeValue, *runtimeKind,
      *taskValue, *threadValue, *accountName, *expiry, *saveStatus,
      *updateSummary, *updateNotes, *updateError, *securityNotice, *logsEmpty;
  QList<QPushButton *> navigation;
  QPushButton *connectButton, *disconnectButton, *reconnectButton, *loginButton,
      *logoutButton, *saveButton, *addParentButton, *updateCheck,
      *updateDownload, *updateCancel, *updateOpen, *checkReconnect,
      *refreshButton, *releaseButton;
  QLineEdit *loginUrl, *loginDevice, *username, *password, *settingsUrl,
      *settingsDevice, *home, *binary;
  QComboBox *runtime;
  QMap<QString, QCheckBox *> toggles;
  QVBoxLayout *parentRows;
  QListWidget *logs;
  QJsonArray lastLogs;
  QList<QLabel *> checks;
  QWidget *connectionPage();
  QWidget *settingsPage();
  QWidget *logsPage();
  void edit(const QString &key, QJsonValue value);
  void syncDraft();
  void rebuildParents();
  void controls();
  void relayout();
  bool dirty() const { return draft != saved; }
  bool busy() const { return pending || state["busy"].toBool(); }
  void run(QString method, QJsonObject value = {}, Done done = {});
  void login();
  void confirm(const QString &action);
  bool eventFilter(QObject *object, QEvent *event) override;
};
