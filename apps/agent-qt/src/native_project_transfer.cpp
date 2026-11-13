#include "native_project_transfer.h"
#include <QtEndian>
#include <algorithm>
namespace Native {
static const QByteArray snapshotMagic("CODEXER-PROJECT-1\n");
static bool transferWithin(QString root, QString path) {
#ifdef Q_OS_WIN
  root.replace('\\', '/'); path.replace('\\', '/');
  const QRegularExpression extendedDrive("^//\\?/[a-zA-Z]:/");
  if (extendedDrive.match(root).hasMatch()) root.remove(0, 4);
  if (extendedDrive.match(path).hasMatch()) path.remove(0, 4);
#endif
  return within(root, path);
}
static void interrupted() {
  if (QThread::currentThread()->isInterruptionRequested())
    throw Error("project-transfer-interrupted");
}
static bool portablePart(const QString &part) {
  return !part.isEmpty() && part != "." && part != ".." && part.size() <= 255 &&
    !part.endsWith(' ') && !part.endsWith('.') &&
    !QRegularExpression("[\\x00-\\x1f<>:\"|?*/\\\\]").match(part).hasMatch() &&
    !QRegularExpression("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)",
      QRegularExpression::CaseInsensitiveOption).match(part).hasMatch();
}
static void portablePath(const QString &path) {
  if (path.size() > 4096) throw Error("project-transfer-path-unsupported");
  for (const auto &part : path.split('/'))
    if (!portablePart(part)) throw Error("project-transfer-path-unsupported");
}
Array transferDirectoryChain(const QString &path) {
  QFileInfo root(path);
  if (!root.isAbsolute()) throw Error("project-path-not-allowed");
  Array result;
  auto current = QDir::cleanPath(root.absoluteFilePath());
  while (true) {
    QFileInfo info(current);
    if (!info.isDir() || info.isSymLink() || info.isJunction() ||
        canonical(current) != canonical(info.canonicalFilePath()))
      throw Error("project-directory-changed");
    result.append(Object{{"path", current}, {"identity", fileIdentity(current)}});
    auto parent = info.absolutePath();
    if (canonical(parent) == canonical(current)) break;
    current = parent;
  }
  return result;
}
void verifyTransferDirectoryChain(const Array &pins) {
  for (const auto &pin : pins) {
    auto p = pin.toObject(); QFileInfo info(p["path"].toString());
    if (!info.isDir() || info.isSymLink() || info.isJunction() ||
        canonical(info.filePath()) != canonical(info.canonicalFilePath()) ||
        fileIdentity(info.filePath()) != p["identity"].toString())
      throw Error("project-directory-changed");
  }
}
static QByteArray digestFile(const QString &path, const std::function<void()> &check) {
  QFile f(path); if (!f.open(QIODevice::ReadOnly)) throw Error("project-file-unavailable");
  QCryptographicHash digest(QCryptographicHash::Sha256);
  while (!f.atEnd()) {
    check(); auto bytes = f.read(256 * 1024);
    if (bytes.isEmpty() && f.error() != QFileDevice::NoError) throw Error("project-file-unavailable");
    digest.addData(bytes);
  }
  return digest.result().toHex();
}
static void writeBytes(QIODevice &file, const QByteArray &bytes) {
  if (file.write(bytes) != bytes.size()) throw Error("project-transfer-disk-full");
}
static void writeRecord(QIODevice &file, const Object &value) {
  auto bytes = json(value);
  quint32 length = qToBigEndian(quint32(bytes.size()));
  writeBytes(file, QByteArray(reinterpret_cast<const char *>(&length), 4));
  writeBytes(file, bytes);
}
static QByteArray readExact(QIODevice &file, qint64 length) {
  auto bytes = file.read(length);
  if (bytes.size() != length) throw Error("project-transfer-invalid-snapshot");
  return bytes;
}
static Object readRecord(QIODevice &file) {
  auto bytes = readExact(file, 4);
  quint32 length = qFromBigEndian<quint32>(bytes.constData());
  if (length > 64 * 1024) throw Error("project-transfer-invalid-snapshot");
  if (!length) return {};
  auto value = parse(readExact(file, length));
  if (!value.isObject()) throw Error("project-transfer-invalid-snapshot");
  return value.toObject();
}
struct SnapshotEntry {
  QString source, path, identity, fingerprint, digest;
  bool directory = false, executable = false;
  qint64 size = 0;
};
Object snapshotProject(const Array &roots, const Object &options, const QString &archive,
                       const std::function<void()> &check, const std::function<void(Object)> &progress) {
  if (roots.isEmpty() || roots.size() > 20) throw Error("project-root-unavailable");
  Array chains, outputRoots; QList<SnapshotEntry> entries;
  QHash<QString, QString> rootFingerprints;
  QSet<QString> paths, excludedNames;
  for (const auto &v : options["excludedDirectories"].toArray()) excludedNames.insert(v.toString().toCaseFolded());
  int excluded = 0; Array excludedSamples;
  Object preparation{{"phase", "scanning"}, {"reason", ""}, {"blockers", Array{}},
    {"files", 0}, {"directories", 0}, {"processedFiles", 0}, {"processedBytes", 0}, {"totalBytes", 0}};
  qint64 discoveredBytes = 0;
  progress(preparation);
  auto localFile = [](const QString &name) {
    auto n = name.toLower();
    if ((n == ".env" || n.startsWith(".env.")) && !n.endsWith(".example") && !n.endsWith(".sample") && !n.endsWith(".template")) return true;
    return QRegularExpression("\\.(db|sqlite|sqlite3)(-wal|-shm)?$", QRegularExpression::CaseInsensitiveOption).match(n).hasMatch();
  };
  auto skip = [&](const QFileInfo &info, const QString &path) {
    if (path.split('/').contains(".git")) return !options["includeGit"].toBool();
    return (info.isDir() && excludedNames.contains(info.fileName().toCaseFolded())) ||
      (!options["includeGit"].toBool() && info.fileName() == ".git") ||
      (!options["includeLocalFiles"].toBool() && !info.isDir() && localFile(info.fileName()));
  };
  std::function<void(QString, QString)> scan = [&](QString source, QString path) {
    check(); QFileInfo info(source);
    if (skip(info, path)) {
      ++excluded; if (excludedSamples.size() < 30) excludedSamples.append(path); return;
    }
    portablePath(path);
    if (info.isSymLink() || info.isJunction()) throw Error("project-transfer-link-unsupported");
    if (!info.isReadable()) throw Error("project-file-unavailable");
    if (info.fileName() == ".git" && !info.isDir()) throw Error("project-transfer-external-git-unsupported");
    if (!info.isFile() && !info.isDir()) throw Error("project-transfer-file-unsupported");
    if (paths.contains(path.toCaseFolded())) throw Error("project-transfer-case-collision");
    paths.insert(path.toCaseFolded());
    if (entries.size() >= 100000) throw Error("project-transfer-too-many-files");
    entries.append({source, path, fileIdentity(source), fingerprint(source), {}, info.isDir(),
                    bool(info.permissions() & QFileDevice::ExeOwner), info.isDir() ? 0 : info.size()});
    auto key = info.isDir() ? "directories" : "files";
    preparation[key] = preparation[key].toInt() + 1;
    discoveredBytes += info.isDir() ? 0 : info.size();
    if (discoveredBytes > MaxProjectTransferBytes) throw Error("project-transfer-too-large");
    preparation["totalBytes"] = double(discoveredBytes); progress(preparation);
    if (info.isDir()) for (const auto &child : QDir(source).entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Name))
      scan(child.absoluteFilePath(), path + '/' + child.fileName());
  };
  for (int i = 0; i < roots.size(); ++i) {
    auto root = roots[i].toString();
    rootFingerprints[root] = fingerprint(root);
    auto chain = transferDirectoryChain(root); chains.append(chain);
    if (within(root, archive)) throw Error("project-transfer-cache-in-project");
    if (options["includeGit"].toBool()) {
      if (QFileInfo(root + "/.git").isFile() || QFileInfo::exists(root + "/.git/commondir") || QFileInfo::exists(root + "/.git/objects/info/alternates"))
        throw Error("project-transfer-external-git-unsupported");
      if (QFileInfo::exists(root + "/.git/index.lock")) throw Error("project-transfer-source-busy");
      if (QFileInfo::exists(root + "/.git/config") && QRegularExpression("(?im)^\\s*worktree\\s*=").match(QString::fromUtf8(read(root + "/.git/config", 1024 * 1024))).hasMatch())
        throw Error("project-transfer-external-git-unsupported");
    }
    QString prefix = roots.size() == 1 ? QString() : "root-" + QString::number(i + 1);
    outputRoots.append(prefix);
    if (!prefix.isEmpty()) scan(root, prefix);
    else for (const auto &child : QDir(root).entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Name))
      scan(child.absoluteFilePath(), child.fileName());
  }
  qint64 size = 0;
  for (const auto &e : entries) { size += e.size; if (size > MaxProjectTransferBytes) throw Error("project-transfer-too-large"); }
  QSaveFile output(archive);
  if (!output.open(QIODevice::WriteOnly)) throw Error("project-transfer-disk-full");
  writeBytes(output, snapshotMagic);
  writeRecord(output, {{"roots", outputRoots}, {"note", options["note"]}});
  preparation["phase"] = "packing"; progress(preparation);
  int files = 0, directories = 0;
  for (auto &e : entries) {
    check();
    if (fileIdentity(e.source) != e.identity || fingerprint(e.source) != e.fingerprint) throw Error("project-transfer-source-changed");
    writeRecord(output, {{"path", e.path}, {"kind", e.directory ? "directory" : "file"}, {"size", double(e.size)}, {"executable", e.executable}});
    if (e.directory) {++directories; continue;}
    ++files; QFile input(e.source);
    if (!input.open(QIODevice::ReadOnly)) throw Error("project-file-unavailable");
    QCryptographicHash digest(QCryptographicHash::Sha256); qint64 copied = 0;
    while (!input.atEnd()) {
      check(); auto bytes = input.read(256 * 1024);
      if (bytes.isEmpty() && input.error() != QFileDevice::NoError) throw Error("project-file-unavailable");
      copied += bytes.size(); if (copied > e.size) throw Error("project-transfer-source-changed");
      digest.addData(bytes); writeBytes(output, bytes);
      preparation["processedBytes"] = preparation["processedBytes"].toDouble() + bytes.size(); progress(preparation);
    }
    if (copied != e.size) throw Error("project-transfer-source-changed");
    e.digest = QString::fromLatin1(digest.result().toHex()); writeBytes(output, e.digest.toLatin1());
    preparation["processedFiles"] = files; progress(preparation);
  }
  // Recheck source contents and directory listings before publishing the snapshot.
  // This also detects new/deleted files during packing, including empty folders.
  preparation["phase"] = "verifying"; preparation["processedFiles"] = 0; progress(preparation);
  for (const auto &chain : chains) verifyTransferDirectoryChain(chain.toArray());
  QSet<QString> verifiedPaths;
  std::function<void(QString, QString)> inventory = [&](QString source, QString path) {
    check(); QFileInfo info(source); if (skip(info, path)) return;
    if (info.isSymLink() || info.isJunction() || (!info.isFile() && !info.isDir())) throw Error("project-transfer-source-changed");
    verifiedPaths.insert(path.toCaseFolded());
    if (verifiedPaths.size() > 100000) throw Error("project-transfer-source-changed");
    if (info.isDir()) for (const auto &child : QDir(source).entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Name))
      inventory(child.absoluteFilePath(), path + '/' + child.fileName());
  };
  for (int i = 0; i < roots.size(); ++i) {
    auto root = roots[i].toString();
    if (roots.size() > 1) inventory(root, outputRoots[i].toString());
    else for (const auto &child : QDir(root).entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Name)) inventory(child.absoluteFilePath(), child.fileName());
  }
  if (verifiedPaths != paths) throw Error("project-transfer-source-changed");
  for (auto it = rootFingerprints.cbegin(); it != rootFingerprints.cend(); ++it)
    if (fingerprint(it.key()) != it.value()) throw Error("project-transfer-source-changed");
  for (const auto &e : entries) {
    check();
    if (fileIdentity(e.source) != e.identity || fingerprint(e.source) != e.fingerprint ||
        (!e.directory && QString::fromLatin1(digestFile(e.source, check)) != e.digest))
      throw Error("project-transfer-source-changed");
    if (!e.directory) {preparation["processedFiles"] = preparation["processedFiles"].toInt() + 1; progress(preparation);}
  }
  writeBytes(output, QByteArray(4, '\0'));
  if (output.size() > MaxProjectTransferBytes) throw Error("project-transfer-too-large");
  if (!output.commit()) throw Error("project-transfer-disk-full");
  preparation["phase"] = "checksumming"; progress(preparation);
  return {{"size", double(QFileInfo(archive).size())}, {"sha256", QString::fromLatin1(digestFile(archive, check))},
          {"files", files}, {"directories", directories}, {"excluded", excluded}, {"excludedSamples", excludedSamples}, {"roots", outputRoots}};
}
Array extractProjectSnapshot(const QString &archive, const QString &staging, const std::function<void()> &check) {
  auto chain = transferDirectoryChain(staging);
  QFile input(archive); if (!input.open(QIODevice::ReadOnly)) throw Error("project-file-unavailable");
  if (readExact(input, snapshotMagic.size()) != snapshotMagic) throw Error("project-transfer-invalid-snapshot");
  auto metadata = readRecord(input); auto roots = metadata["roots"].toArray();
  if (roots.isEmpty() || roots.size() > 20 || !metadata["note"].isString() || metadata["note"].toString().size() > 20000) throw Error("project-transfer-invalid-snapshot");
  QSet<QString> rootNames;
  for (const auto &root : roots) {
    if (!root.isString() || (!root.toString().isEmpty() && !portablePart(root.toString())) || rootNames.contains(root.toString().toCaseFolded())) throw Error("project-transfer-invalid-snapshot");
    rootNames.insert(root.toString().toCaseFolded());
  }
  if (roots.size() > 1 && rootNames.contains("")) throw Error("project-transfer-invalid-snapshot");
  QSet<QString> paths; qint64 total = 0;
  while (true) {
    check(); auto record = readRecord(input); if (record.isEmpty()) break;
    auto path = record["path"].toString(), kind = record["kind"].toString(); portablePath(path);
    if (paths.size() >= 100000 || paths.contains(path.toCaseFolded()) || (!rootNames.contains("") && !rootNames.contains(path.section('/', 0, 0).toCaseFolded()))) throw Error("project-transfer-invalid-snapshot");
    paths.insert(path.toCaseFolded());
    auto size = record["size"].toDouble(-1);
    if (size < 0 || size != qint64(size) || size > MaxProjectTransferBytes || (kind != "file" && kind != "directory") || (kind == "directory" && size != 0)) throw Error("project-transfer-invalid-snapshot");
    total += qint64(size); if (total > MaxProjectTransferBytes) throw Error("project-transfer-too-large");
    auto destination = staging + '/' + path;
    verifyTransferDirectoryChain(chain);
    transferDirectoryChain(QFileInfo(destination).absolutePath());
    if (QFileInfo::exists(destination) || QFileInfo(destination).isSymLink()) throw Error("project-folder-exists");
    if (kind == "directory") {
      if (!QDir().mkdir(destination)) throw Error("project-transfer-disk-full"); continue;
    }
    QFile file(destination); if (!file.open(QIODevice::WriteOnly | QIODevice::NewOnly)) throw Error("project-transfer-disk-full");
    QCryptographicHash digest(QCryptographicHash::Sha256);
    for (qint64 remaining = qint64(size); remaining > 0;) {
      check(); auto bytes = readExact(input, qMin<qint64>(remaining, 256 * 1024));
      digest.addData(bytes); writeBytes(file, bytes); remaining -= bytes.size();
    }
    if (readExact(input, 64) != digest.result().toHex()) throw Error("project-transfer-checksum-mismatch");
    if (!file.flush()) throw Error("project-transfer-disk-full"); file.close();
    auto permissions = QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ReadGroup | QFileDevice::ReadOther;
    if (record["executable"].toBool()) permissions |= QFileDevice::ExeOwner | QFileDevice::ExeGroup | QFileDevice::ExeOther;
    if (!QFile::setPermissions(destination, permissions)) throw Error("project-transfer-permissions-failed");
  }
  if (!input.atEnd()) throw Error("project-transfer-invalid-snapshot");
  for (const auto &root : roots) transferDirectoryChain(root.toString().isEmpty() ? staging : staging + '/' + root.toString());
  if (!metadata["note"].toString().isEmpty()) {
    // An unpredictable filename keeps user files intact; NewOnly enforces it.
    QFile handoff(staging + "/CODEXER-HANDOFF-" + uuid() + ".md");
    if (!handoff.open(QIODevice::WriteOnly | QIODevice::NewOnly)) throw Error("project-transfer-disk-full");
    writeBytes(handoff, metadata["note"].toString().toUtf8());
    if (!handoff.flush()) throw Error("project-transfer-disk-full");
  }
  return roots;
}
ProjectTransferTask::ProjectTransferTask(Object auth, Object transfer, QString directory, Array roots, QObject *parent)
  : QThread(parent), credentials(std::move(auth)), job(std::move(transfer)), cache(std::move(directory)), sourceRoots(std::move(roots)) {}
QByteArray ProjectTransferTask::request(const QString &method, const QString &suffix, const QByteArray &body, bool binary) {
  interrupted();
  auto path = "/v1/agent/" + credentials["deviceId"].toString() + "/project-transfers/" + job["id"].toString() + suffix;
  QUrl root(credentials["relayUrl"].toString()); QUrl url = root.resolved(QUrl(path));
  if (url.authority() != root.authority() || url.scheme() != root.scheme()) throw Error("project-transfer-invalid-url");
  QNetworkRequest request(url); request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
  request.setTransferTimeout(30000); request.setRawHeader("Authorization", "Bearer " + credentials["session"].toString().toUtf8());
  request.setRawHeader("x-device-id", credentials["deviceId"].toString().toUtf8());
  request.setHeader(QNetworkRequest::ContentTypeHeader, binary ? "application/octet-stream" : "application/json");
  auto reply = network->sendCustomRequest(request, method.toUtf8(), body);
  QEventLoop loop; QTimer timer; timer.setInterval(100); QElapsedTimer elapsed; elapsed.start(); QByteArray result;
  QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
  QObject::connect(reply, &QIODevice::readyRead, &loop, [&] {result += reply->readAll(); if (result.size() > 8 * 1024 * 1024) reply->abort();});
  QObject::connect(&timer, &QTimer::timeout, &loop, [&] {if (isInterruptionRequested() || elapsed.elapsed() > 30500) {reply->abort(); loop.quit();}});
  timer.start(); if (!reply->isFinished()) loop.exec(); result += reply->readAll();
  auto status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(); auto error = reply->error(); delete reply; interrupted();
  if (status < 200 || status >= 300 || error != QNetworkReply::NoError) {
    if (!status || status >= 500 || status == 429) throw Error("project-transfer-network-unavailable");
    auto code = parse(result).toObject()["error"].toString("project-transfer-unavailable"); throw Error(code);
  }
  if (result.size() > 8 * 1024 * 1024) throw Error("project-transfer-invalid-response");
  return result;
}
Object ProjectTransferTask::current() { return parse(request("GET", "")).toObject(); }
Object ProjectTransferTask::status(Object value) { return parse(request("POST", "/status", json(value))).toObject(); }
void ProjectTransferTask::receive() {
  auto parent = job["parentPath"].toString(), leaf = job["relativePath"].toString();
  if (!portablePart(leaf) || leaf.size() > 100) throw Error("project-path-invalid");
  auto pins = transferDirectoryChain(parent); auto destination = QDir::cleanPath(parent + '/' + leaf);
  auto staging = parent + "/.codexer-incoming-" + job["id"].toString();
  auto receiptPath = cache + "/receipt.json"; Object receipt;
  if (QFileInfo::exists(receiptPath)) receipt = parse(read(receiptPath, 65536)).toObject();
  if (!receipt.isEmpty() && (receipt["sha256"] != job["sha256"] || receipt["savedPath"] != destination)) throw Error("project-transfer-receipt-mismatch");
  auto state = job["state"].toString();
  if ((state == "installing" || state == "received") && !receipt.isEmpty() && QFileInfo::exists(destination)) {
    transferDirectoryChain(destination);
    if (fileIdentity(destination) != receipt["identity"].toString()) throw Error("project-directory-changed");
    if (state == "installing") status({{"state", "received"}, {"savedPath", destination}});
    outcome = {{"id", job["id"]}, {"savedPath", destination}, {"roots", receipt["roots"]}}; return;
  }
  if (state == "received") throw Error("project-directory-changed");
  if (QFileInfo::exists(destination) || QFileInfo(destination).isSymLink()) throw Error("project-folder-exists");
  auto archive = cache + "/in.snapshot";
  if (state == "downloading") {
    QFile file(archive); if (!file.open(QIODevice::ReadWrite)) throw Error("project-transfer-disk-full");
    auto size = qint64(job["size"].toDouble());
    if (file.size() > size || !file.seek(file.size())) throw Error("project-transfer-invalid-snapshot");
    qint64 offset = file.size(), reported = offset; QElapsedTimer progressTimer; progressTimer.start();
    while (offset < size) {
      interrupted(); auto bytes = request("GET", "/chunk?offset=" + QString::number(offset));
      if (bytes.size() != qMin<qint64>(ProjectTransferChunk, size - offset)) throw Error("project-transfer-invalid-response");
      writeBytes(file, bytes); if (!file.flush()) throw Error("project-transfer-disk-full"); offset += bytes.size();
      if ((offset - reported >= 8 * 1024 * 1024 && progressTimer.elapsed() >= 2000) || offset == size) {status({{"state", "downloaded"}, {"downloaded", double(offset)}}); reported = offset; progressTimer.restart();}
    }
    file.close();
    auto check = [&] {interrupted();};
    if (QString::fromLatin1(digestFile(archive, check)) != job["sha256"].toString()) throw Error("project-transfer-checksum-mismatch");
    verifyTransferDirectoryChain(pins);
    if (QFileInfo::exists(staging)) {
      if (receipt.isEmpty() || fileIdentity(staging) != receipt["identity"].toString()) throw Error("project-directory-changed");
      transferDirectoryChain(staging);
      if (!QDir(staging).removeRecursively()) throw Error("project-transfer-staging-unavailable");
    }
    if (!QDir().mkdir(staging)) throw Error("project-transfer-disk-full");
    receipt = {{"sha256", job["sha256"]}, {"savedPath", destination}, {"identity", fileIdentity(staging)}, {"parentPins", pins}};
    save(receiptPath, json(receipt));
    QElapsedTimer elapsed; elapsed.start();
    auto roots = extractProjectSnapshot(archive, staging, [&] {
      interrupted(); if (elapsed.elapsed() > 3000) {elapsed.restart(); if (current()["state"] != "downloading") throw Error("project-transfer-state-changed");}
    });
    if (roots != job["roots"].toArray()) throw Error("project-transfer-invalid-snapshot");
    receipt["roots"] = roots; save(receiptPath, json(receipt));
    auto next = status({{"state", "installing"}}); if (next["state"] != "installing") throw Error("project-transfer-state-changed");
  }
  verifyTransferDirectoryChain(receipt["parentPins"].toArray());
  transferDirectoryChain(staging);
  if (fileIdentity(staging) != receipt["identity"].toString() || !receipt["roots"].isArray()) throw Error("project-directory-changed");
  if (!QDir(parent).rename(QFileInfo(staging).fileName(), leaf)) throw Error("project-folder-exists");
  auto next = status({{"state", "received"}, {"savedPath", destination}});
  if (next["state"] != "received" && next["state"] != "completed") throw Error("project-transfer-state-changed");
  outcome = {{"id", job["id"]}, {"savedPath", destination}, {"roots", receipt["roots"]}};
}
void ProjectTransferTask::perform() {
  if (!QDir().mkpath(cache)) throw Error("project-transfer-disk-full");
  job = current(); auto state = job["state"].toString();
  save(cache + "/job.json", json(job));
  if (credentials["deviceId"] == job["sourceDeviceId"]) {
    auto archive = cache + "/out.snapshot";
    if (state == "preparing") {
      Object summary;
      if (QFileInfo::exists(cache + "/out.json") && QFileInfo::exists(archive)) {
        summary = parse(read(cache + "/out.json", 65536)).toObject();
        if (summary["size"].toDouble() != QFileInfo(archive).size() || summary["sha256"].toString() != QString::fromLatin1(digestFile(archive, interrupted))) throw Error("project-transfer-checksum-mismatch");
      } else {
        QElapsedTimer elapsed; elapsed.start();
        QElapsedTimer reporting; reporting.start(); QString reportedPhase; Object latestPreparation;
        auto report = [&](Object preparation) {
          if (preparation.isEmpty()) return;
          latestPreparation = preparation;
          if (preparation["phase"] == reportedPhase && reporting.elapsed() < 3000) return;
          reportedPhase = preparation["phase"].toString(); reporting.restart();
          // Progress is optional on older Relays and never decides snapshot validity.
          try {status({{"state", "preparing"}, {"preparation", preparation}});} catch (const Error &) {}
        };
        summary = snapshotProject(sourceRoots, job["options"].toObject(), archive, [&] {
          interrupted(); report(latestPreparation);
          if (elapsed.elapsed() > 3000) {elapsed.restart(); if (current()["state"] != "preparing") throw Error("project-transfer-state-changed");}
        }, report);
        save(cache + "/out.json", json(summary));
      }
      summary["state"] = "ready"; status(summary);
    } else if (state == "uploading") {
      QFile file(archive); if (!file.open(QIODevice::ReadOnly) || file.size() != qint64(job["size"].toDouble())) throw Error("project-transfer-source-snapshot-missing");
      auto offset = qint64(job["uploaded"].toDouble()); if (!file.seek(offset)) throw Error("project-transfer-invalid-snapshot");
      while (offset < file.size()) {
        auto bytes = file.read(ProjectTransferChunk); if (bytes.isEmpty()) throw Error("project-file-unavailable");
        auto next = parse(request("PUT", "/chunk?offset=" + QString::number(offset), bytes, true)).toObject();
        offset += bytes.size(); if (next["uploaded"].toDouble() != offset || next["state"] != "uploading") throw Error("project-transfer-state-changed");
      }
      request("POST", "/uploaded", "{}");
    }
  } else if (state == "downloading" || state == "installing" || state == "received") receive();
}
void ProjectTransferTask::run() {
  QNetworkAccessManager manager; network = &manager;
  try {perform();}
  catch (const Error &e) {
    if (e.code != "project-transfer-network-unavailable" && e.code != "project-transfer-interrupted" && e.code != "project-transfer-offset-mismatch" && e.code != "project-transfer-state-changed" && e.code != "project-transfer-unavailable") {
      try {status({{"state", "failed"}, {"code", e.code}});} catch (...) {}
    }
    outcome = {{"id", job["id"]}, {"code", e.code}};
  } catch (...) {
    try {status({{"state", "failed"}, {"code", "project-transfer-failed"}});} catch (...) {}
    outcome = {{"id", job["id"]}, {"code", "project-transfer-failed"}};
  }
  network = nullptr;
}
void Service::stopProjectTransfers() {
  if (projectTransferTask) {
    auto task = projectTransferTask; projectTransferTask = nullptr;
    task->disconnect(this); task->requestInterruption(); task->wait(); delete task;
  }
  snapshottingProject.clear(); projectTransferOutcome = {};
}
bool Service::transferTouchesProject(const QString &id, const QString &project, const Array &roots) const {
  Object thread = snapshot["threads"].toObject()[id].toObject();
  auto raw = rawThreads.value(id);
  QString linked = thread["projectId"].toString(raw["projectId"].toString());
  QString cwd = thread["cwd"].toString(raw["cwd"].toString());
  for (const auto &v : catalog["threads"].toArray()) {
    auto listed = v.toObject(); if (listed["id"] != id) continue;
    if (linked.isEmpty()) linked = listed["projectId"].toString();
    if (cwd.isEmpty()) cwd = listed["cwd"].toString();
    break;
  }
  if (linked == project) return true;
  for (const auto &r : roots) {
    auto root = r.toString();
    if (!cwd.isEmpty() && transferWithin(root, cwd)) return true;
    for (const auto &p : catalog["projects"].toArray()) {
      auto other = p.toObject(); if (other["id"] != linked) continue;
      for (const auto &v : other["roots"].toArray())
        if (transferWithin(root, v.toString()) || transferWithin(v.toString(), root)) return true;
    }
  }
  return false;
}
Object Service::projectTransferWait(const QString &project, const Array &roots) const {
  Object preparation{{"phase", "waiting"}, {"reason", ""}, {"blockers", Array{}},
    {"files", 0}, {"directories", 0}, {"processedFiles", 0}, {"processedBytes", 0}, {"totalBytes", 0}};
  if (refreshing) {preparation["reason"] = "runtime-refresh"; return preparation;}
  auto threads = snapshot["threads"].toObject(); QSet<QString> ids;
  for (const auto &id : threads.keys()) ids.insert(id);
  for (const auto &id : rawThreads.keys()) ids.insert(id);
  for (const auto &id : usageObservations.keys()) ids.insert(id);
  for (const auto &v : pendingRequests) ids.insert(v["params"].toObject()["threadId"].toString());
  auto sorted = ids.values(); std::sort(sorted.begin(), sorted.end()); Array blockers;
  for (const auto &id : sorted) {
    if (id.isEmpty() || !transferTouchesProject(id, project, roots)) continue;
    auto thread = threads[id].toObject(); QString reason;
    if (thread["status"] == "active" || !thread["activeTurnId"].toString().isEmpty() ||
        busyTurns.contains(usageObservations.value(id)["turnId"].toString())) reason = "running";
    for (const auto &v : rawThreads.value(id)["turns"].toArray())
      if (busyTurns.contains(v.toObject()["id"].toString())) reason = "running";
    for (const auto &v : thread["subAgents"].toArray())
      if (QStringList{"running", "pendingInit"}.contains(v.toObject()["status"].toString())) reason = "subagent";
    if (!thread["requests"].toArray().isEmpty()) reason = "approval";
    for (const auto &v : pendingRequests)
      if (v["params"].toObject()["threadId"] == id) reason = "approval";
    if (reason.isEmpty()) continue;
    auto title = thread["title"].toString(rawThreads.value(id)["title"].toString());
    if (title.isEmpty()) for (const auto &v : catalog["threads"].toArray())
      if (v.toObject()["id"] == id) {title = v.toObject()["title"].toString(); break;}
    if (blockers.size() < 5) blockers.append(Object{{"id", id}, {"title", title.left(200)}, {"reason", reason}});
  }
  if (blockers.isEmpty()) return {};
  preparation["reason"] = "project-active"; preparation["blockers"] = blockers; return preparation;
}
void Service::pollProjectTransfers() {
  if (paused || !allowed || stopping || credentials.isEmpty()) return;
  auto cleanup = [&](const QString &cache, const QString &id, bool expired) {
    try {
      auto cachePins = transferDirectoryChain(cache);
      if (!within(dataDirectory + "/project-transfers", cache) || QFileInfo(cache).fileName() != id || QUuid(id).isNull()) return;
      if (QFileInfo::exists(cache + "/receipt.json")) {
        auto receipt = parse(read(cache + "/receipt.json", 65536)).toObject();
        auto pins = receipt["parentPins"].toArray();
        if (!pins.isEmpty()) {
          verifyTransferDirectoryChain(pins);
          auto parent = pins.first().toObject()["path"].toString();
          auto staging = parent + "/.codexer-incoming-" + id;
          if (QFileInfo::exists(staging) && fileIdentity(staging) == receipt["identity"].toString()) {
            transferDirectoryChain(staging); QDir(staging).removeRecursively();
          }
        }
      }
      verifyTransferDirectoryChain(cachePins);
      for (const auto &name : {"out.snapshot", "in.snapshot"}) QFile::remove(cache + '/' + name);
      if (expired) QDir(cache).removeRecursively();
    } catch (...) { /* A changed directory is retained for local inspection. */ }
  };
  if (now() - lastProjectTransferCleanup > 60000) {
    lastProjectTransferCleanup = now();
    for (const auto &info : QDir(dataDirectory + "/project-transfers").entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot)) {
      if (info.isSymLink() || info.isJunction() || QUuid(info.fileName()).isNull()) continue;
      try {
        auto record = parse(read(info.filePath() + "/job.json", 256 * 1024)).toObject();
        if (record["id"] == info.fileName() && record["expiresAt"].toDouble() > 0 && record["expiresAt"].toDouble() <= now()) cleanup(info.filePath(), info.fileName(), true);
      } catch (...) {}
    }
  }
  const auto generation = remoteGeneration;
  auto base = "/v1/agent/" + credentials["deviceId"].toString() + "/project-transfers";
  auto values = parse(http("GET", base, {}, 8 * 1024 * 1024, 10000)).toObject()["transfers"].toArray();
  QList<Object> jobs; for (const auto &v : values) jobs.append(v.toObject());
  if (generation != remoteGeneration || paused || !allowed || stopping) return;
  // Favor finishing an already received project over preparing another transfer.
  std::stable_sort(jobs.begin(), jobs.end(), [](const Object &a, const Object &b) {
    return (a["state"] == "received") > (b["state"] == "received");
  });
  for (const auto &value : jobs) {
    auto job = value; auto state = job["state"].toString(), id = job["id"].toString();
    if (QUuid(id).isNull()) continue;
    auto cache = dataDirectory + "/project-transfers/" + id;
    if (state == "completed" || state == "failed" || state == "cancelled") {
      // Only remove files in the Agent-owned cache, never the saved project.
      if (QFileInfo::exists(cache)) cleanup(cache, id, false);
      continue;
    }
    const bool source = credentials["deviceId"] == job["sourceDeviceId"];
    if (projectTransferTask) {
      if (source && state == "preparing" && projectTransferTask->transferId() != id) {
        Object waiting{{"phase", "waiting"}, {"reason", "agent-busy"}, {"blockers", Array{}},
          {"files", 0}, {"directories", 0}, {"processedFiles", 0}, {"processedBytes", 0}, {"totalBytes", 0}};
        try {http("POST", base + '/' + id + "/status", json(Object{{"state", "preparing"}, {"preparation", waiting}}));} catch (const Error &) {}
      }
      continue;
    }
    if (!source) {
      bool authorized = false;
      for (const auto &p : settings["projectParents"].toArray()) {
        auto path = QFileInfo(p.toString()).filePath();
        authorized |= path == job["parentPath"].toString() && hash(path.toUtf8()) == job["parentId"].toString();
      }
      if (!authorized) {
        if (state != "received") http("POST", base + '/' + id + "/status", json(Object{{"state", "failed"}, {"code", "project-parent-not-authorized"}}));
        continue;
      }
    }
    if (!source && state == "received" && projectTransferOutcome["id"] == id && projectTransferOutcome["code"].toString().isEmpty()) {
      auto outcome = projectTransferOutcome;
      auto receipt = parse(read(cache + "/receipt.json", 65536)).toObject();
      auto path = outcome["savedPath"].toString();
      verifyTransferDirectoryChain(receipt["parentPins"].toArray()); transferDirectoryChain(path);
      if (fileIdentity(path) != receipt["identity"].toString()) throw Error("project-directory-changed");
      Array roots;
      for (const auto &root : outcome["roots"].toArray()) {
        auto p = root.toString().isEmpty() ? path : path + '/' + root.toString();
        transferDirectoryChain(p); roots.append(Object{{"path", p}});
      }
      ensureRpc(); auto projects = pages("project/list"); Object created;
      for (const auto &v : projects) {
        auto listed = v.toObject(); auto listedRoots = listed["roots"].toArray();
        if (listedRoots.size() != roots.size()) continue;
        bool matches = true;
        for (int i = 0; i < roots.size(); ++i) matches &= canonical(listedRoots[i].toObject()["path"].toString()) == canonical(roots[i].toObject()["path"].toString());
        if (matches) {created = listed; break;}
      }
      if (generation != remoteGeneration || paused || !allowed) return;
      if (created.isEmpty()) created = rpc->call("project/create", {{"name", job["name"]}, {"roots", roots}, {"idempotencyKey", "codexer-transfer:" + id}})["project"].toObject();
      if (created["id"].toString().isEmpty()) throw Error("project-registration-unconfirmed", true);
      http("POST", base + '/' + id + "/status", json(Object{{"state", "completed"}, {"targetProjectId", created["id"]}}));
      projectTransferOutcome = {}; refreshCatalog(); return;
    }
    Array roots;
    if (source && state == "preparing") {
      // Snapshot capture runs on its own native thread. New remote writes to
      // this project and automatic queue starts wait until capture finishes.
      for (const auto &p : catalog["projects"].toArray()) if (p.toObject()["id"] == job["projectId"]) roots = p.toObject()["roots"].toArray();
      if (roots.isEmpty()) {http("POST", base + '/' + id + "/status", json(Object{{"state", "failed"}, {"code", "project-not-in-catalog"}})); continue;}
      auto waiting = projectTransferWait(job["projectId"].toString(), roots);
      if (!waiting.isEmpty()) {
        try {http("POST", base + '/' + id + "/status", json(Object{{"state", "preparing"}, {"preparation", waiting}}));} catch (const Error &) {}
        continue;
      }
      snapshottingProject = job["projectId"].toString();
    } else if (!(source && state == "uploading") && !(!source && (state == "downloading" || state == "installing" || state == "received"))) continue;
    projectTransferOutcome = {};
    auto task = new ProjectTransferTask(credentials, job, cache, roots, this); projectTransferTask = task;
    connect(task, &QThread::finished, this, [this, task, generation] {
      if (projectTransferTask != task) return;
      projectTransferTask = nullptr; snapshottingProject.clear();
      if (generation == remoteGeneration) projectTransferOutcome = task->outcome;
      task->deleteLater();
    });
    task->start(); return;
  }
}
}
