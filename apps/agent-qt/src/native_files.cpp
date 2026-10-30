#include "native.h"
namespace Native {
static QString imageMime(const QByteArray &bytes) {
  if (bytes.size() >= 24 &&
      bytes.startsWith(QByteArray::fromHex("89504e470d0a1a0a")))
    return "image/png";
  if (bytes.size() >= 12 && bytes.startsWith(QByteArray::fromHex("ffd8ff")))
    return "image/jpeg";
  if (bytes.size() >= 12 && bytes.startsWith("RIFF") &&
      bytes.mid(8, 4) == "WEBP")
    return "image/webp";
  if (bytes.size() >= 10 &&
      (bytes.startsWith("GIF87a") || bytes.startsWith("GIF89a")))
    return "image/gif";
  return {};
}
static QString localPath(QString path, bool encoded) {
  if (path.startsWith("file://"))
    return QUrl(path).toLocalFile();
  if (encoded)
    path = QUrl::fromPercentEncoding(path.toUtf8());
  return QFileInfo(path).isAbsolute() ? path : QString{};
}
// Parse local inline destinations, including angle brackets, escapes and
// balanced parentheses. URL authorization is applied separately; this never
// fetches Markdown resources.
static QStringList markdownDestinations(const QString &text, bool imagesOnly) {
  QStringList result;
  auto starts = QRegularExpression(imagesOnly ? "!\\[[^\\]\\n]*\\]\\("
                                              : "!?\\[[^\\]\\n]*\\]\\(")
                    .globalMatch(text);
  while (starts.hasNext() && result.size() < 10000) {
    auto start = starts.next();
    int i = start.capturedEnd();
    while (i < text.size() && text[i].isSpace())
      ++i;
    QString path;
    bool angle = i < text.size() && text[i] == '<';
    if (angle)
      ++i;
    int depth = 0;
    bool complete = false;
    for (; i < text.size() && path.size() <= 4096; ++i) {
      auto ch = text[i];
      if (ch == '\n' || ch == '\r')
        break;
      if (ch == '\\' && i + 1 < text.size() &&
          QString("()<> ").contains(text[i + 1])) {
        path += text[++i];
        continue;
      }
      if (angle) {
        if (ch == '>') {
          complete = true;
          break;
        }
        path += ch;
        continue;
      }
      if (ch == '(') {
        ++depth;
        path += ch;
        continue;
      }
      if (ch == ')') {
        if (depth == 0) {
          complete = true;
          break;
        }
        --depth;
        path += ch;
        continue;
      }
      if (ch.isSpace() && depth == 0) {
        complete = true;
        break;
      }
      path += ch;
    }
    if (complete && !path.isEmpty() && path.size() <= 4096)
      result << path;
  }
  return result;
}
static QString safeName(QString name) {
  name.replace(QRegularExpression("[/\\\\\\x00-\\x1f<>:\"|?*]"), "_");
  name.remove(QRegularExpression("[. ]+$"));
  if (name.isEmpty() || name == "." || name == "..")
    name = "file";
  if (QRegularExpression("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)",
                         QRegularExpression::CaseInsensitiveOption)
          .match(name)
          .hasMatch())
    name.prepend('_');
  while (name.toUtf8().size() > 240)
    name.chop(1);
  return name;
}
Array Service::registerImages(const QString &threadId, const Object &item) {
  QList<QPair<QString, bool>> candidates;
  auto parts = item["content"].isArray() ? item["content"].toArray()
                                         : item["input"].toArray();
  for (const auto &v : parts) {
    auto part = v.toObject();
    if (part["type"] == "localImage")
      candidates.append({part["path"].toString(), false});
    if (part["type"] == "image")
      candidates.append({part["url"].toString(), false});
  }
  if (item["type"] == "imageView")
    candidates.append({item["path"].toString(), false});
  if (item["type"] == "imageGeneration") {
    auto path = item["savedPath"].toString();
    if (path.isEmpty() && item["result"].isString()) {
      path = item["result"].toString();
      if (!path.startsWith("data:"))
        path.prepend("data:image/png;base64,");
    }
    candidates.append({path, false});
  }
  if (item["type"] == "agentMessage") {
    for (const auto &path :
         markdownDestinations(item["text"].toString(), true)) {
      if (!QRegularExpression("\\.(mp3|wav|m4a|ogg|flac|aac)(?:$|\\?)",
                              QRegularExpression::CaseInsensitiveOption)
               .match(path)
               .hasMatch())
        candidates.append({path, true});
    }
  }
  Array result;
  QSet<QString> seen;
  for (const auto &candidate : candidates) {
    auto original = candidate.first;
    bool data = QRegularExpression("^data:image/(png|jpeg|webp|gif);base64,")
                    .match(original)
                    .hasMatch();
    auto path = data ? original : localPath(original, candidate.second);
    if (path.isEmpty() || seen.contains(path) || result.size() >= 8 ||
        (data && path.size() > 5592450))
      continue;
    seen.insert(path);
    auto id = hash(threadId.toUtf8() + '\0' + path.toUtf8());
    auto name = data ? "image" : QFileInfo(path).fileName().left(255);
    // Data URLs can each hold several MiB; cap the registry by bytes as well as
    // count.
    qint64 registryBytes = path.size() * 2;
    for (auto it = imageSources.begin(); it != imageSources.end(); ++it)
      if (it.key() != id)
        registryBytes += it.value().second.size() * 2;
    while (!imageSources.isEmpty() &&
           (imageSources.size() >= 10000 || registryBytes > 64 * 1024 * 1024)) {
      registryBytes -= imageSources.begin().value().second.size() * 2;
      imageSources.erase(imageSources.begin());
    }
    imageSources[id] = {threadId, path};
    Object ref{{"id", id}, {"name", name}};
    if (candidate.second)
      ref["source"] = original.left(4096);
    result.append(ref);
  }
  return result;
}
Object Service::readImage(const QString &threadId, const QString &id) {
  if (!imageSources.contains(id) || imageSources[id].first != threadId)
    throw Error("image-not-in-thread");
  auto path = imageSources[id].second;
  QByteArray bytes;
  QString name;
  if (path.startsWith("data:")) {
    int comma = path.indexOf(',');
    auto encoded = path.mid(comma + 1).toLatin1();
    bytes = QByteArray::fromBase64(encoded,
                                   QByteArray::AbortOnBase64DecodingErrors);
    if (bytes.toBase64() != encoded)
      throw Error("invalid-image");
    name = "image";
  } else {
    QFileInfo f(path);
    if (!f.isFile() || f.size() > 4 * 1024 * 1024)
      throw Error("image-too-large");
    bytes = read(path, 4 * 1024 * 1024);
    name = f.fileName().left(255);
  }
  auto mime = imageMime(bytes);
  if (mime.isEmpty() || bytes.size() > 4 * 1024 * 1024)
    throw Error("invalid-image");
  return {{"name", name},
          {"mimeType", mime},
          {"base64", QString::fromLatin1(bytes.toBase64())}};
}
Array Service::inputs(const QString &id, const Array &images,
                      const Array &attachments) {
  if (images.size() > 4 || attachments.size() > 4)
    throw Error("invalid-attachment");
  QRegularExpression validId("^[a-f0-9]{64}$");
  Array result;
  for (const auto &v : images) {
    if (!validId.match(v.toString()).hasMatch())
      throw Error("invalid-image");
    auto image = parse(http("GET",
                            "/v1/agent/" + credentials["deviceId"].toString() +
                                "/threads/" + id + "/images/" + v.toString(),
                            {}, 6 * 1024 * 1024))
                     .toObject();
    auto encoded = image["base64"].toString().toLatin1();
    auto bytes = QByteArray::fromBase64(
        encoded, QByteArray::AbortOnBase64DecodingErrors);
    if (bytes.toBase64() != encoded || bytes.size() > 4 * 1024 * 1024 ||
        imageMime(bytes) != image["mimeType"].toString() ||
        imageMime(bytes).isEmpty())
      throw Error("images-not-ready");
    auto path = dataDirectory + "/images/" + v.toString() + '.' +
                image["mimeType"].toString().section('/', 1);
    save(path, bytes);
    result.append(Object{{"type", "localImage"}, {"path", path}});
  }
  for (const auto &v : attachments) {
    auto aid = v.toString();
    if (!validId.match(aid).hasMatch())
      throw Error("invalid-attachment");
    auto base = dataDirectory + "/attachments/" + hash(id.toUtf8()) + '/' + aid;
    auto metadata = base + "/reference.json";
    Object ref;
    QString path;
    try {
      ref = parse(read(metadata, 65536)).toObject();
      path = base + "/content/" + safeName(ref["name"].toString());
      QFileInfo f(path);
      if (ref["id"] != aid || !f.isFile() || f.isSymLink() ||
          f.size() != ref["size"].toDouble() ||
          hash(read(path, 20 * 1024 * 1024)) != ref["sha256"].toString())
        ref = {};
    } catch (...) {
      ref = {};
    }
    if (ref.isEmpty()) {
      auto endpoint = "/v1/agent/" + credentials["deviceId"].toString() +
                      "/threads/" + id + "/attachments/" + aid;
      ref = parse(http("GET", endpoint + "?info=1", {}, 65536)).toObject();
      if (ref["id"] != aid || ref["name"].toString().isEmpty() ||
          ref["name"].toString().size() > 255 || !ref["size"].isDouble() ||
          ref["size"].toDouble() < 0 ||
          ref["size"].toDouble() > 20 * 1024 * 1024 ||
          !validId.match(ref["sha256"].toString()).hasMatch())
        throw Error("attachments-not-ready");
      auto bytes = http("GET", endpoint, {}, 20 * 1024 * 1024, 60000);
      if (bytes.size() != ref["size"].toDouble() ||
          hash(bytes) != ref["sha256"].toString())
        throw Error("attachments-not-ready");
      path = base + "/content/" + safeName(ref["name"].toString());
      save(path, bytes);
      save(metadata, json(ref));
    }
    auto name = ref["name"].toString();
    name.replace('\\', "\\\\").replace('[', "\\[").replace(']', "\\]");
    auto local = path;
    local.replace('\\', '/').replace('>', "%3E");
    result.append(Object{{"type", "text"},
                         {"text", "附加文件：[" + name + "](<" + local + ">)"},
                         {"text_elements", Array{}}});
  }
  return result;
}
void Service::observeFiles(const QString &threadId, const Object &turn) {
  for (const auto &v : turn["items"].toArray())
    for (const auto &key : {"text", "output"}) {
      auto matches =
          QRegularExpression(
              "https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?(?:/"
              "[^\\s<>\\\"'\\)\\]]*)?")
              .globalMatch(v.toObject()[key].toString());
      while (matches.hasNext()) {
        QUrl url(matches.next().captured(0));
        if (url.userInfo().isEmpty() && url.isValid()) {
          auto origin = url.adjusted(QUrl::RemovePath | QUrl::RemoveQuery |
                                     QUrl::RemoveFragment)
                            .toString();
          if (previewOrigins[threadId].size() < 32)
            previewOrigins[threadId].insert(origin);
        }
      }
    }
  for (const auto &v : turn["items"].toArray()) {
    auto item = v.toObject();
    if (!QStringList{"agentMessage", "userMessage", "steeringUserMessage"}
             .contains(item["type"].toString()))
      continue;
    for (const auto &destination :
         markdownDestinations(item["text"].toString(), false)) {
      auto path = localPath(destination, true);
      if (!path.isEmpty() && path.size() <= 4096) {
        if (fileSources[threadId].size() >= 10000)
          fileSources[threadId].erase(fileSources[threadId].begin());
        fileSources[threadId].insert(path);
      }
    }
  }
}
Object Service::readFile(const Object &request) {
  auto id = request["threadId"].toString(),
       reference = request["path"].toString(),
       path = localPath(reference, false);
  if (path.isEmpty() || !fileSources[id].contains(path))
    throw Error("file-not-in-thread");
  QFileInfo before(path);
  if (!before.isFile())
    throw Error("file-unavailable");
  auto resolved = before.canonicalFilePath();
  if (resolved.isEmpty())
    throw Error("file-unavailable");
  if (before.size() > 512LL * 1024 * 1024)
    throw Error("file-too-large");
  auto identity = fileIdentity(resolved);
  auto version =
      hash(json(Array{resolved, identity, double(before.size()),
                      double(before.lastModified().toMSecsSinceEpoch()),
                      double(before.birthTime().toMSecsSinceEpoch())}));
  Object result{{"name", before.fileName().left(255)},
                {"size", double(before.size())},
                {"version", version}};
  if (!request.contains("offset"))
    return result;
  if (request["version"] != version)
    throw Error("file-changed");
  qint64 offset = request["offset"].toInteger(-1);
  if (offset < 0 || offset > before.size())
    throw Error("invalid-file-offset");
  QFile input(resolved);
  if (!input.open(QIODevice::ReadOnly) || !input.seek(offset))
    throw Error("file-unavailable");
  auto bytes = input.read(qMin<qint64>(256 * 1024, before.size() - offset));
  QFileInfo after(input);
  if (bytes.size() != qMin<qint64>(256 * 1024, before.size() - offset) ||
      before.size() != after.size() ||
      before.lastModified() != after.lastModified() ||
      fileIdentity(resolved) != identity)
    throw Error("file-changed");
  result["offset"] = double(offset);
  result["base64"] = QString::fromLatin1(bytes.toBase64());
  return result;
}
void Service::preview(const Object &message) {
  auto id = message["requestId"].toString(), type = message["type"].toString();
  if (QUuid(id).isNull())
    throw Error("invalid-preview-request");
  const auto generation = remoteGeneration;
  auto emitEvent = [this, id, generation](const Object &event) {
    if (generation != remoteGeneration || paused || !allowed)
      return;
    send({{"type", "device.preview"}, {"requestId", id}, {"event", event}});
  };
  if (type == "preview.cancel") {
    auto operation = previewOperations.take(id);
    if (operation)
      operation->deleteLater();
    return;
  }
  if (type == "preview.ws.data") {
    auto ws = qobject_cast<QWebSocket *>(previewOperations.value(id));
    if (!ws || ws->state() != QAbstractSocket::ConnectedState ||
        ws->bytesToWrite() > 2 * 1024 * 1024) {
      if (ws)
        ws->deleteLater();
      previewOperations.remove(id);
      return;
    }
    auto bytes = QByteArray::fromBase64(message["data"].toString().toLatin1());
    if (bytes.size() > 64 * 1024) {
      ws->close();
      return;
    }
    if (message["binary"].toBool())
      ws->sendBinaryMessage(bytes);
    else
      ws->sendTextMessage(QString::fromUtf8(bytes));
    return;
  }
  if (previewOperations.contains(id))
    throw Error("duplicate-preview-request");
  auto threadId = message["threadId"].toString(),
       origin = message["origin"].toString(), path = message["path"].toString();
  bool member = false;
  for (const auto &v : catalog["threads"].toArray())
    if (v.toObject()["id"] == threadId && !v.toObject()["archived"].toBool())
      member = true;
  QUrl base(origin);
  if (!member || !previewOrigins[threadId].contains(origin) ||
      !QStringList{"http", "https"}.contains(base.scheme()) ||
      !QStringList{"localhost", "127.0.0.1", "::1"}.contains(base.host()) ||
      !base.userInfo().isEmpty() || previewOperations.size() >= 32) {
    emitEvent({{"type", "error"}, {"code", "preview-not-in-thread"}});
    return;
  }
  if (!path.startsWith('/') || path.startsWith("//") || path.size() > 8192 ||
      QRegularExpression("[\\x00-\\x20\\\\]").match(path).hasMatch()) {
    emitEvent({{"type", "error"}, {"code", "invalid-preview-path"}});
    return;
  }
  auto target = base.resolved(QUrl(path));
  if (target.authority() != base.authority() ||
      target.scheme() != base.scheme()) {
    emitEvent({{"type", "error"}, {"code", "invalid-preview-path"}});
    return;
  }
  target.setHost(base.host() == "::1" ? "::1" : "127.0.0.1");
  if (type == "preview.ws.open") {
    target.setScheme(target.scheme() == "https" ? "wss" : "ws");
    auto ws = new QWebSocket(origin, QWebSocketProtocol::VersionLatest, this);
    ws->setMaxAllowedIncomingMessageSize(64 * 1024);
    QNetworkRequest request(target);
    request.setRawHeader("Host", base.authority().toUtf8());
    request.setRawHeader("Origin", origin.toUtf8());
    QWebSocketHandshakeOptions options;
    QStringList protocols;
    for (const auto &v : message["protocols"].toArray()) {
      if (v.toString().size() > 200 || protocols.size() >= 8)
        throw Error("invalid-preview-request");
      protocols.append(v.toString());
    }
    options.setSubprotocols(protocols);
    previewOperations[id] = ws;
    connect(ws, &QWebSocket::connected, this, [emitEvent, ws] {
      emitEvent({{"type", "ws.open"}, {"protocol", ws->subprotocol()}});
    });
    connect(ws, &QWebSocket::binaryMessageReceived, this,
            [emitEvent](QByteArray bytes) {
              emitEvent({{"type", "ws.data"},
                         {"data", QString::fromLatin1(bytes.toBase64())},
                         {"binary", true}});
            });
    connect(
        ws, &QWebSocket::textMessageReceived, this, [emitEvent](QString text) {
          emitEvent({{"type", "ws.data"},
                     {"data", QString::fromLatin1(text.toUtf8().toBase64())},
                     {"binary", false}});
        });
    connect(ws, &QWebSocket::disconnected, this, [this, id, emitEvent, ws] {
      previewOperations.remove(id);
      emitEvent({{"type", "ws.close"}});
      ws->deleteLater();
    });
    connect(ws, &QWebSocket::errorOccurred, this, [emitEvent](auto) {
      emitEvent({{"type", "error"}, {"code", "preview-websocket-failed"}});
    });
    ws->open(request, options);
    return;
  }
  if (type != "preview.request" ||
      !QStringList{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
           .contains(message["method"].toString()) ||
      message["body"].toString().size() > 2 * 1024 * 1024)
    throw Error("invalid-preview-request");
  QNetworkRequest request(target);
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                       QNetworkRequest::ManualRedirectPolicy);
  request.setTransferTimeout(20000);
  request.setRawHeader("Host", base.authority().toUtf8());
  request.setRawHeader("Origin", origin.toUtf8());
  request.setRawHeader("Accept-Encoding", "identity");
  auto headers = message["headers"].toObject();
  for (const auto &key : {"accept", "content-type", "cookie", "if-none-match",
                          "if-modified-since", "range"})
    if (headers[key].isString() && headers[key].toString().size() <= 8192)
      request.setRawHeader(key, headers[key].toString().toUtf8());
  auto body = QByteArray::fromBase64(message["body"].toString().toLatin1());
  auto reply = network->sendCustomRequest(
      request, message["method"].toString().toUtf8(), body);
  previewOperations[id] = reply;
  auto sent = std::make_shared<bool>(false);
  auto bytes = std::make_shared<qint64>(0);
  auto sendHeaders = [reply, emitEvent, sent] {
    if (*sent ||
        !reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).isValid())
      return;
    *sent = true;
    Object headers;
    for (const auto &h : reply->rawHeaderPairs())
      if (h.first.size() <= 100 && h.second.size() <= 16384)
        headers[QString::fromLatin1(h.first).toLower()] =
            QString::fromLatin1(h.second);
    emitEvent(
        {{"type", "headers"},
         {"status",
          reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()},
         {"headers", headers}});
  };
  connect(reply, &QNetworkReply::metaDataChanged, this, sendHeaders);
  connect(reply, &QIODevice::readyRead, this,
          [this, reply, sendHeaders, emitEvent, bytes] {
            sendHeaders();
            while (reply->bytesAvailable()) {
              auto data = reply->read(64 * 1024);
              *bytes += data.size();
              if (*bytes > 32 * 1024 * 1024 || !relay ||
                  relay->bytesToWrite() > 16 * 1024 * 1024) {
                reply->abort();
                return;
              }
              emitEvent({{"type", "data"},
                         {"data", QString::fromLatin1(data.toBase64())}});
            }
          });
  connect(reply, &QNetworkReply::finished, this,
          [this, reply, id, sendHeaders, emitEvent] {
            sendHeaders();
            previewOperations.remove(id);
            emitEvent(reply->error() == QNetworkReply::NoError
                          ? Object{{"type", "end"}}
                          : Object{{"type", "error"},
                                   {"code", "preview-unavailable"}});
            reply->deleteLater();
          });
}
} // namespace Native
