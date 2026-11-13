#pragma once
#include "native.h"
namespace Native {
inline constexpr qint64 MaxProjectTransferBytes = 4LL * 1024 * 1024 * 1024;
inline constexpr int ProjectTransferChunk = 512 * 1024;
Object snapshotProject(const Array &roots, const Object &options,
                       const QString &archive,
                       const std::function<void()> &check = [] {},
                       const std::function<void(Object)> &progress = [](Object) {});
Array extractProjectSnapshot(const QString &archive, const QString &staging,
                             const std::function<void()> &check = [] {});
Array transferDirectoryChain(const QString &path);
void verifyTransferDirectoryChain(const Array &pins);
class ProjectTransferTask : public QThread {
  Object credentials, job;
  QString cache;
  Array sourceRoots;
  QNetworkAccessManager *network = nullptr;
  QByteArray request(const QString &method, const QString &suffix,
                     const QByteArray &body = {}, bool binary = false);
  Object current();
  Object status(Object value);
  void receive();
  void perform();
  void run() override;
public:
  Object outcome;
  QString transferId() const { return job["id"].toString(); }
  ProjectTransferTask(Object credentials, Object job, QString cache,
                      Array roots, QObject *parent);
};
}
