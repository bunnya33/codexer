#include "native.h"
namespace Native {
static bool overlaps(const QString &a, const QString &b) {
  return within(a, b) || within(b, a);
}
static Array pinChain(const QString &path) {
  QFileInfo target(path);
  auto canonicalPath = target.canonicalFilePath();
  if (!target.isAbsolute() || !target.isDir() || target.isSymLink() ||
      canonicalPath.isEmpty() || canonical(path) != canonical(canonicalPath))
    throw Error("project-directory-unsafe");
  Array chain;
  auto current = target.absoluteFilePath();
  while (true) {
    QFileInfo info(current);
    if (!info.isDir() || info.isSymLink() ||
        canonical(current) != canonical(info.canonicalFilePath()))
      throw Error("project-directory-unsafe");
    chain.prepend(
        Object{{"path", current}, {"identity", fileIdentity(current)}});
    auto parent = info.absolutePath();
    if (canonical(parent) == canonical(current))
      break;
    current = parent;
  }
  return chain;
}
static void verifyChain(const Array &chain) {
  for (const auto &v : chain) {
    auto p = v.toObject();
    QFileInfo f(p["path"].toString());
    if (!f.isDir() || f.isSymLink() ||
        canonical(f.filePath()) != canonical(f.canonicalFilePath()) ||
        fileIdentity(f.filePath()) != p["identity"].toString())
      throw Error("project-directory-changed");
  }
}
static Object projectFrom(const Object &catalog, const QString &id) {
  for (const auto &v : catalog["projects"].toArray())
    if (v.toObject()["id"] == id)
      return v.toObject();
  return {};
}
Object Service::project(const Object &command) {
  ensureRpc();
  auto p = command["payload"].toObject();
  auto type = p["type"].toString();
  const int generation = remoteGeneration;
  auto allowedNow = [&] {
    if (paused || !allowed || stopping || remoteGeneration != generation ||
        now() >= command["expiresAt"].toDouble())
      throw Error("remote-disconnected");
  };
  if (type == "project.create") {
    Object parent;
    for (const auto &v :
         catalog["projectCreation"].toObject()["parents"].toArray())
      if (v.toObject()["id"] == p["parentId"])
        parent = v.toObject();
    if (parent.isEmpty())
      throw Error("project-parent-not-authorized");
    auto base = parent["path"].toString(),
         relative = p["relativePath"].toString();
    auto parts = relative.split('/');
    if (relative.size() > 1024 || parts.isEmpty() || relative.contains('\\'))
      throw Error("project-path-invalid");
    for (const auto &part : parts)
      if (part.isEmpty() || part == "." || part == ".." || part.endsWith(' ') ||
          part.endsWith('.') ||
          QRegularExpression("[\\x00-\\x1f<>:\"|?*]").match(part).hasMatch() ||
          QRegularExpression("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)",
                             QRegularExpression::CaseInsensitiveOption)
              .match(part)
              .hasMatch())
        throw Error("project-path-invalid");
    auto parents = pinChain(base);
    auto path = base;
    for (int i = 0; i + 1 < parts.size(); ++i) {
      path += '/' + parts[i];
      pinChain(path);
    }
    auto containing = path;
    auto containingChain = pinChain(containing);
    path += '/' + parts.last();
    allowedNow();
    verifyChain(parents);
    verifyChain(containingChain);
    if (p["mode"] == "new" && !QDir(containing).mkdir(parts.last()))
      throw Error(QFileInfo::exists(path) ? "project-folder-exists"
                                          : "project-folder-unavailable");
    auto chain = pinChain(path);
    if (!within(base, QFileInfo(path).canonicalFilePath()) ||
        canonical(base) == canonical(path))
      throw Error("project-path-not-allowed");
    allowedNow();
    auto rawProjects = pages("project/list");
    Object created;
    for (const auto &v : rawProjects)
      for (const auto &r : v.toObject()["roots"].toArray())
        if (canonical(r.toObject()["path"].toString()) == canonical(path))
          created = v.toObject();
    verifyChain(chain);
    allowedNow();
    if (created.isEmpty())
      created =
          rpc->call("project/create",
                    {{"name", p["name"]},
                     {"roots", Array{Object{{"path", path}}}},
                     {"idempotencyKey",
                      "codexer:" + credentials["deviceId"].toString() + ':' +
                          command["commandId"].toString()}})["project"]
              .toObject();
    if (created["id"].toString().isEmpty())
      throw Error("project-registration-unconfirmed", true);
    refreshCatalog();
    return {{"projectId", created["id"]}, {"acknowledgedByAppServer", true}};
  }
  auto id = p["projectId"].toString();
  if (projectFrom(catalog, id).isEmpty())
    throw Error("project-not-in-catalog");
  auto deletionCatalog = [&] {
    auto projects = pages("project/list");
    Array threads;
    Array kinds{"cli",
                "vscode",
                "exec",
                "appServer",
                "subAgent",
                "subAgentReview",
                "subAgentCompact",
                "subAgentThreadSpawn",
                "subAgentOther",
                "unknown"};
    for (bool db : {true, false})
      for (bool archived : {false, true})
        for (const auto &v : pages("thread/list", {{"modelProviders", Array{}},
                                                   {"sourceKinds", kinds},
                                                   {"useStateDbOnly", db},
                                                   {"archived", archived}})) {
          auto t = v.toObject();
          t["archived"] = archived;
          threads.append(t);
        }
    for (const auto &v : projects) {
      auto proj = v.toObject();
      if (proj["id"].toString().isEmpty() ||
          proj["name"].toString().size() > 1000 || !proj["roots"].isArray() ||
          proj["roots"].toArray().size() > 20)
        throw Error("project-deletion-check-failed");
      for (const auto &rv : proj["roots"].toArray())
        if (!QFileInfo(rv.toObject()["path"].toString()).isAbsolute() ||
            rv.toObject()["path"].toString().size() > 4096)
          throw Error("project-deletion-check-failed");
    }
    for (const auto &v : threads) {
      auto t = v.toObject();
      if (t["id"].toString().isEmpty() ||
          (!t["cwd"].isNull() && t.contains("cwd") &&
           (!t["cwd"].isString() ||
            !QFileInfo(t["cwd"].toString()).isAbsolute() ||
            t["cwd"].toString().size() > 4096)))
        throw Error("project-deletion-check-failed");
    }
    return normalizeCatalog("project-delete", projects, threads, {});
  };
  auto fresh = deletionCatalog();
  auto selected = projectFrom(fresh, id);
  if (selected.isEmpty())
    throw Error("project-not-in-catalog");
  for (const auto &v : fresh["threads"].toArray())
    if (v.toObject()["projectId"] == id)
      throw Error("project-not-empty");
  for (const auto &tid : newThreads)
    if (rawThreads[tid]["projectId"] == id)
      throw Error("project-not-empty");
  allowedNow();
  auto prepareDirectories = [&](const Object &current) {
    Array pins;
    auto roots = selected["roots"].toArray();
    if (roots.isEmpty())
      throw Error("project-root-unavailable");
    QStringList protectedPaths{directory, settings["codexHome"].toString(),
                               QCoreApplication::applicationDirPath()};
    for (const auto &key : {"SystemRoot", "ProgramFiles", "ProgramFiles(x86)"})
      if (qEnvironmentVariableIsSet(key))
        protectedPaths << qEnvironmentVariable(key);
    if (platform() != "win32")
      protectedPaths << "/System" << "/Library" << "/Applications" << "/usr"
                     << "/bin" << "/sbin" << "/etc" << "/dev" << "/proc"
                     << "/sys" << "/boot" << "/lib";
    for (const auto &rv : roots) {
      auto root = rv.toString();
      if (QDir(root).isRoot() || within(root, QDir::homePath()))
        throw Error("project-directory-protected");
      for (const auto &protectedPath : protectedPaths)
        if (overlaps(root, protectedPath))
          throw Error("project-directory-protected");
      for (const auto &other : roots)
        if (other != rv && overlaps(root, other.toString()))
          throw Error("project-directory-shared");
      for (const auto &pv : current["projects"].toArray()) {
        auto project = pv.toObject();
        if (project["id"] == id)
          continue;
        for (const auto &r : project["roots"].toArray())
          if (overlaps(root, r.toString()))
            throw Error("project-directory-shared");
      }
      for (const auto &tv : current["threads"].toArray())
        if (tv.toObject()["cwd"].isString() &&
            within(root, tv.toObject()["cwd"].toString()))
          throw Error("project-directory-shared");
      pins.append(Object{{"root", root}, {"chain", pinChain(root)}});
    }
    return pins;
  };
  if (type == "project.delete.prepare") {
    Object plan{{"projectId", id},
                {"token", uuid()},
                {"expiresAt", double(now() + 300000)},
                {"name", selected["name"]},
                {"roots", selected["roots"]},
                {"directoryDeletion", false}};
    Array pins;
    try {
      pins = prepareDirectories(fresh);
      plan["directoryDeletion"] = true;
    } catch (const Error &e) {
      plan["directoryReason"] = e.code;
    }
    while (deletionPlans.size() >= 20)
      deletionPlans.erase(deletionPlans.begin());
    deletionPlans[plan["token"].toString()] = {
        {"plan", plan}, {"project", selected}, {"pins", pins}};
    return plan;
  }
  auto token = p["token"].toString();
  auto entry = deletionPlans.value(token);
  auto plan = entry["plan"].toObject();
  if (entry.isEmpty() || plan["projectId"] != id ||
      plan["expiresAt"].toDouble() <= now() || entry["project"] != selected)
    throw Error("project-deletion-stale");
  bool removeDirectory = p["deleteDirectory"].toBool();
  if (removeDirectory) {
    if (!plan["directoryDeletion"].toBool())
      throw Error(plan["directoryReason"].toString("project-directory-unsafe"));
    if (prepareDirectories(fresh) != entry["pins"].toArray())
      throw Error("project-directory-changed");
    for (const auto &pin : entry["pins"].toArray())
      verifyChain(pin.toObject()["chain"].toArray());
  }
  allowedNow();
  rpc->call("project/delete", {{"projectId", id}});
  deletionPlans.remove(token);
  auto projects = catalog["projects"].toArray();
  for (int i = projects.size() - 1; i >= 0; --i)
    if (projects[i].toObject()["id"] == id)
      projects.removeAt(i);
  catalog["projects"] = projects;
  catalog["generatedAt"] = double(now());
  send({{"type", "device.catalog"}, {"catalog", catalog}});
  if (removeDirectory) {
    Array remaining = selected["roots"].toArray();
    try {
      auto after = deletionCatalog();
      if (!projectFrom(after, id).isEmpty())
        throw Error("project-deletion-stale");
      auto ps = after["projects"].toArray();
      ps.append(selected);
      after["projects"] = ps;
      if (prepareDirectories(after) != entry["pins"].toArray())
        throw Error("project-directory-changed");
      for (const auto &pin : entry["pins"].toArray()) {
        allowedNow();
        auto o = pin.toObject();
        verifyChain(o["chain"].toArray());
        auto root = o["root"].toString();
        auto identity = fileIdentity(root),
             volume = identity.section(':', 0, 0);
        QDirIterator dirs(root,
                          QDir::Dirs | QDir::NoDotAndDotDot | QDir::Hidden |
                              QDir::System,
                          QDirIterator::Subdirectories);
        int visited = 0;
        while (dirs.hasNext()) {
          auto child = dirs.next();
          if (++visited > 200000)
            throw Error("project-directory-unsafe");
          auto f = dirs.fileInfo();
          if (!f.isSymLink() &&
              fileIdentity(child).section(':', 0, 0) != volume)
            throw Error("project-directory-unsafe");
        }
        allowedNow();
        verifyChain(o["chain"].toArray());
        auto staged =
            QFileInfo(root).absolutePath() + "/.codexer-delete-" + uuid();
        if (!QFileInfo(staged).isAbsolute() ||
            QFileInfo(staged).absolutePath() != QFileInfo(root).absolutePath())
          throw Error("project-directory-unsafe");
        if (!QDir().rename(root, staged))
          throw Error("project-directory-delete-failed");
        for (int i = 0; i < remaining.size(); ++i)
          if (remaining[i] == root)
            remaining[i] = staged;
        if (fileIdentity(staged) != identity ||
            !QDir(staged).removeRecursively())
          throw Error("project-directory-delete-failed");
        for (int i = remaining.size() - 1; i >= 0; --i)
          if (remaining[i] == staged)
            remaining.removeAt(i);
      }
    } catch (...) {
      return {{"projectId", id},
              {"acknowledgedByAppServer", true},
              {"directoryDeleted", false},
              {"directoryError", "project-directory-delete-failed"},
              {"remainingDirectories", remaining}};
    }
  }
  return {{"projectId", id},
          {"acknowledgedByAppServer", true},
          {"directoryDeleted", removeDirectory}};
}
} // namespace Native
