#pragma once
#include <QtCore>
#include <QtNetwork>
#include <QtSql>
#include <QtWebSockets/QWebSocket>
#include <QtWebSockets/QWebSocketHandshakeOptions>
#include <functional>
#include <memory>
#include <stdexcept>

namespace Native {
using Object = QJsonObject;
using Array = QJsonArray;
inline constexpr int DefaultSyncedThreads = 20;
inline constexpr int MaxSyncedThreads = 30;
inline constexpr int MaxInputImages = 20;
inline constexpr qint64 MaxVideoBytes = 512LL * 1024 * 1024;
struct Error : std::exception {
  QString code;
  bool uncertain;
  explicit Error(QString value, bool unknown = false)
      : code(std::move(value)), uncertain(unknown) {}
  const char *what() const noexcept override { return "native-agent-error"; }
};
qint64 now();
QString uuid();
QByteArray json(const QJsonValue &value);
QJsonValue parse(const QByteArray &value);
QByteArray read(const QString &path, qint64 limit = 64 * 1024 * 1024);
void save(const QString &path, const QByteArray &bytes);
QString hash(const QByteArray &bytes);
QString canonical(const QString &path);
QString localFilePath(QString value, bool encoded = true);
QStringList htmlPreviewPaths(const QString &source);
bool within(const QString &root, const QString &path);
bool waitFor(const std::function<bool()> &done, int timeout);
Object merged(Object left, const Object &right);
QString platform();
QString executable(const Object &settings);
QString fingerprint(const QString &path);
QString fileIdentity(const QString &path);
Object filePayload(const Object &request, const QString &path);
struct ProjectScan;
class ProjectTransferTask;
Object permissionSettings(const Object &settings);
Object permissionPreset(const QString &mode, const Array &roots);
Object approval(const Object &params);
Object approvalResponse(const Object &params, const QString &decision,
                        const QString &scope);
QString asyncAnswer(const Object &request, const Object &answers);
bool validCommand(const Object &command);
QSqlQuery sql(QSqlDatabase &db, const QString &query,
              const QVariantList &values = {});
Object normalizeSettings(const Object &raw);
Object normalizeThread(
    const Object &raw, qint64 revision,
    const std::function<Array(const QString &, const Object &)> &images = {});
Object normalizeTurn(
    const Object &raw, bool history, const QString &threadId,
    const std::function<Array(const QString &, const Object &)> &images = {});
Object usageMetadata(const Object &raw);
Object boundTurns(Object result, qint64 limit = 256 * 1024);
Object normalizeCatalog(const QString &device, const Array &projects,
                        const Array &threads, const Array &models);
Object applyPatch(Object source, const Array &patches);

class Rpc : public QObject {
  Q_OBJECT
  QProcess process;
  QByteArray buffer;
  int serial = 0;
  QHash<QString, Object> responses;
  QSet<QString> waiting;
  bool stopping = false;

public:
  QString binary, identity;
  explicit Rpc(QObject *parent = nullptr);
  ~Rpc() override;
  void start(const Object &settings);
  void stop();
  bool connected() const;
  Object call(const QString &method, Object params = {}, int timeout = 30000);
  void respond(const QJsonValue &id, const Object &result,
               const QString &error = {});
signals:
  void notification(QString method, Object params);
  void serverRequest(Object request);
  void disconnected();
};

class Desktop : public QObject {
  Q_OBJECT
  QLocalSocket socket;
  QByteArray buffer;
  QString client = "initializing-client";
  QHash<QString, Object> responses;
  QSet<QString> waiting;
  void send(const Object &value);
  void following(const QString &id, bool enabled);

public:
  struct Watch {
    QString owner;
    qint64 revision = -1;
    Object raw;
    bool compatible = false;
  };
  QHash<QString, Watch> watched;
  bool connected = false;
  explicit Desktop(QObject *parent = nullptr);
  void open(const Object &settings);
  void stop();
  bool follow(const QString &id, bool rediscover = false);
  void unfollow(const QString &id);
  Object call(const QString &method, Object params, const QString &owner = {},
              int timeout = 5000);
signals:
  void threadChanged(QString id);
};

// Read-only, incremental accounting. Retains counters and file offsets, never
// conversation bodies. Inherited fork history is not billed to the child.
class SubAgentUsageReader {
  struct Entry {
    QString path, identity, parent, model;
    qint64 offset = 0, size = 0, modified = 0, startOrdinal = 0;
    bool header = false, skipping = false, partial = false, seen = false,
         explicitRecords = false;
    Object previous;
    QHash<QString, Object> models;
  };
  QHash<QString, Entry> entries;

public:
  Object readUsage(const QString &home, const QString &id,
                   const QString &parent, const QString &path,
                   double indexedTotal, qint64 &budget);
  void retain(const QSet<QString> &ids);
};

// All network, process, SQL, filesystem and scheduling work is native Qt/C++.
// The object lives on one worker thread. Mutations remain serialized; bounded
// read-only file requests can run while a runtime transport wait pumps events.
class Service : public QObject {
  Q_OBJECT
  QString directory, dataDirectory;
  Object settings, credentials, view, snapshot, catalog, updateState;
  QNetworkAccessManager *network = nullptr;
  QWebSocket *relay = nullptr;
  Rpc *rpc = nullptr;
  Desktop *desktop = nullptr;
  QTimer *maintenance = nullptr;
  QSqlDatabase journal, usage;
  QHash<QString, Object> rawThreads, effectiveSettings, pendingRequests, plans,
      tokenUsage;
  QHash<QString, Object> usageObservations;
  QHash<QString, Object> agentDetails;
  QHash<QString, qint64> agentDetailsAt;
  SubAgentUsageReader subAgentUsage;
  int subAgentUsageCursor = 0;
  QSet<QString> answeredRequests;
  QSet<QString> owned, newThreads, busyTurns, completedTurns, dirtyThreads,
      desktopThreads, awaitingQueue;
  QHash<QString, qint64> acquired;
  QHash<QString, QPair<QString, QString>> imageSources;
  QHash<QString, QSet<QString>> fileSources;
  QHash<QString, QSet<QString>> previewOrigins;
  QHash<QString, QPointer<QObject>> previewOperations;
  QHash<QString, Object> deletionPlans;
  QHash<QString, std::shared_ptr<ProjectScan>> projectScans;
  QSet<QString> cancelledProjectRequests;
  ProjectTransferTask *projectTransferTask = nullptr;
  Object projectTransferOutcome;
  QString snapshottingProject;
  qint64 lastProjectTransferPoll = 0;
  qint64 lastProjectTransferCleanup = 0;
  QHash<int, Object> platformResponses;
  QList<Object> uiQueue, commandQueue;
  struct FileReadRequest { Object message; QElapsedTimer queued; int generation; };
  QList<FileReadRequest> fileReadQueue;
  bool fileReadScheduled = false, readingFiles = false;
  qint64 fileReadCount = 0, fileReadBytes = 0, fileQueueMs = 0,
         fileQueueMaxMs = 0, fileReadMs = 0, fileReadMaxMs = 0;
  int nativeSerial = 0, depth = 0, remoteGeneration = 0, reconnectAttempt = 0;
  int threadLimit = DefaultSyncedThreads;
  bool initialized = false, paused = true, allowed = true, stopping = false,
       refreshing = false, refreshRequested = false;
  qint64 lastProjectUsage = 0;
  qint64 lastScan = 0, lastCatalog = 0, lastRetry = 0, lastPong = 0,
         lastPing = 0, lastRelease = 0, lastStatus = 0;
  QNetworkReply *download = nullptr;
  QSaveFile *downloadFile = nullptr;
  QCryptographicHash downloadHash{QCryptographicHash::Sha256};
  QString downloadedPath;
  qint64 downloadedBytes = 0;
  std::function<void(Object)> output;
  void publish();
  void log(const QString &code);
  void status();
  void initialize();
  Object defaults() const;
  void persist(const Object &value);
  void restoreCredentials();
  void storeCredentials(const Object &value);
  void clearCredentials(bool revoke);
  QJsonValue native(const QString &method, Object value = {});
  QByteArray http(const QString &method, const QString &path,
                  const QByteArray &body = {}, qint64 limit = 8 * 1024 * 1024,
                  int timeout = 15000, bool authenticate = true);
  void connectAgent();
  void pause();
  void closeAgent();
  void openJournal();
  void connectRelay();
  void relayMessage(const Object &message);
  void preview(const Object &message);
  void send(const Object &message);
  void ensureThreadSlot(const QString &id = {});
  bool trimThreadPreviews(int target);
  void applyThreadLimit(const QJsonValue &value);
  void commit(const Object &change);
  void tick();
  void queueFileRead(const Object &message);
  void drainFileReads();
  void replyFileRead(const Object &message);
  void ensureRpc();
  void attachRpc(Rpc *value);
  void attachDesktop();
  Array pages(const QString &method, Object params = {});
  void refreshCatalog();
  void watch(const QString &id, bool forceHeadless = false);
  void updateThread(const QString &id);
  Object history(const QString &id, QJsonValue cursor);
  Object timedTurn(const QString &id, Object turn, bool recent);
  void enrichAgents(const QString &id, Object &raw);
  Object savedContext(const Object &thread);
  Object resume(const QString &id);
  Object release(bool force);
  QString refresh(bool force);
  bool active() const;
  void checkCommand(const Object &command, int generation) const;
  Object execute(Object command);
  Object executeTurn(Object command, const Array &inputs, bool onDesktop);
  Object manage(const Object &command);
  Object project(const Object &command);
  Object queue(const Object &command);
  void drainQueues();
  Array queued(const QString &id);
  void queueStatus(const QString &id, const QString &status);
  void removeQueued(const QString &id);
  Array inputs(const QString &id, const Array &images,
               const Array &attachments);
  Array registerImages(const QString &threadId, const Object &item);
  Object readImage(const QString &threadId, const QString &id);
  Object readFile(const Object &request);
  Object browseProject(const Object &request);
  void pollProjectTransfers();
  void stopProjectTransfers();
  bool transferTouchesProject(const QString &id, const QString &project,
                              const Array &roots) const;
  Object projectTransferWait(const QString &project, const Array &roots) const;
  void observeFiles(const QString &threadId, const Object &turn);
  void observeUsage(const QString &threadId, const QString &turnId,
                    const Object &value, bool notification);
  void observeDesktopUsage(const QString &threadId);
  void startUsage(const QString &threadId, const QString &turnId,
                  const QString &model = {});
  void finishUsage(const QString &threadId, const QString &turnId);
  void gapUsage(const QString &threadId);
  Object usageRecord(const QString &threadId, const QString &turnId);
  bool saveUsage(const QString &threadId, const QString &turnId,
                 const Object &value);
  void enrichUsage(const QString &threadId, Object &turn);
  void refreshProjectUsage(bool notify = true);
  void refreshSubAgentUsage(const QString &indexPath);
  void processCommand(const Object &command);
  Object dispatch(const QString &method, Object value);
  void checkUpdate();
  void downloadUpdate();
  void finishDownload();

public:
  friend class NativeTests;
  explicit Service(QString profile, QObject *parent = nullptr);
  ~Service() override;
  void start();
  void submit(const Object &message);
signals:
  void message(Object value);
  void finished();
};
} // namespace Native
