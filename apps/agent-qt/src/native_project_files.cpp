#include "native.h"
#include <algorithm>
namespace Native {
struct ProjectScan {
  QString binding, root, currentPath, text;
  QStringList directories;
  std::unique_ptr<QDirIterator> iterator;
  qsizetype textOffset = 0;
  int line = 0, skipped = 0, scanned = 0;
  qint64 expires = 0;
};
static bool excluded(const QFileInfo &f, bool hidden) {
  static const QSet<QString> ignored{".git","node_modules",".local",".cache",".gradle",".venv","venv","__pycache__","dist","build","Pods",".next"};
  return !hidden && (f.isHidden() || f.fileName().startsWith('.') || ignored.contains(f.fileName()));
}
static QString scopedPath(const QString &root, const QString &relative) {
  if (relative.size()>4096 || relative.contains(QRegularExpression("[\\\\:\\x00-\\x1f]")) || relative.startsWith('/')) throw Error("project-path-invalid");
  QString current=root;
  if (!relative.isEmpty()) for (const auto &part:relative.split('/')) {
    if (part.isEmpty() || part=="." || part=="..") throw Error("project-path-invalid");
    current += '/'+part;
    QFileInfo f(current);
    if (f.isSymLink() || f.isJunction() || f.canonicalFilePath().isEmpty() || !within(root,f.canonicalFilePath())) throw Error("project-path-not-allowed");
  }
  return current;
}
Object Service::browseProject(const Object &request) {
  auto query=request["query"].toObject();
  auto operation=query["operation"].toString(),requestId=request["requestId"].toString();
  const auto generation=remoteGeneration;
  auto check=[&] {
    QCoreApplication::processEvents(QEventLoop::ExcludeUserInputEvents,1);
    if (stopping || paused || !allowed || generation!=remoteGeneration || cancelledProjectRequests.contains(requestId)) throw Error("project-cancelled");
  };
  check();
  Object project;
  for (const auto &p:catalog["projects"].toArray()) if (p.toObject()["id"]==request["projectId"]) project=p.toObject();
  if (project.isEmpty()) throw Error("project-not-in-catalog");
  const auto roots=project["roots"].toArray();
  const auto rootIndex=query["rootIndex"].toInt(-1);
  if (rootIndex<0 || rootIndex>=roots.size()) throw Error("project-path-not-allowed");
  QFileInfo rootInfo(roots[rootIndex].toString());
  if (!rootInfo.isAbsolute() || !rootInfo.isDir() || rootInfo.isSymLink() || rootInfo.isJunction() || rootInfo.canonicalFilePath().isEmpty()) throw Error("project-directory-unavailable");
  const auto root=rootInfo.canonicalFilePath(),rootIdentity=fileIdentity(root);
  const auto relative=query["path"].toString(),path=scopedPath(root,relative);
  auto verify=[&] {
    check();
    if (QFileInfo(roots[rootIndex].toString()).canonicalFilePath()!=root || fileIdentity(root)!=rootIdentity || scopedPath(root,relative)!=path) throw Error("project-directory-changed");
    Object latest;
    for (const auto &p:catalog["projects"].toArray()) if (p.toObject()["id"]==request["projectId"]) latest=p.toObject();
    if (latest["roots"]!=project["roots"]) throw Error("project-not-in-catalog");
  };
  if (operation=="file") {
    auto result=filePayload(query,path); verify();
    return {{"kind","file"},{"file",result}};
  }
  if (!QFileInfo(path).isDir() || !QFileInfo(path).isReadable()) throw Error("project-directory-unavailable");
  auto bindingQuery=query; bindingQuery.remove("cursor");
  const auto binding=hash(json(Array{request["projectId"],project["roots"],rootIdentity,bindingQuery,generation}));
  const bool hidden=query["hidden"].toBool();
  if (operation=="list") {
    const auto directoryVersion=hash(json(Array{fileIdentity(path),double(QFileInfo(path).lastModified().toMSecsSinceEpoch()),binding}));
    int offset=0;
    const auto cursor=query["cursor"].toString();
    if (!cursor.isEmpty()) {
      if (!cursor.startsWith(directoryVersion+":")) throw Error("project-directory-changed");
      bool ok=false; offset=cursor.section(':',1).toInt(&ok); if (!ok || offset<0 || offset>10000) throw Error("project-path-invalid");
    }
    QList<QFileInfo> files;
    QDirIterator it(path,QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System);
    bool limited=false;
    while (it.hasNext()) {
      it.next(); auto f=it.fileInfo();
      if (excluded(f,hidden)) continue;
      if (files.size()>=10000) {limited=true;break;}
      files.append(f); if (files.size()%64==0) check();
    }
    std::sort(files.begin(),files.end(),[](const QFileInfo &a,const QFileInfo &b){if(a.isDir()!=b.isDir())return a.isDir();return a.fileName()<b.fileName();});
    Array entries;
    int end=offset;
    for(int i=offset;i<qMin(offset+200,int(files.size()));++i) {
      if(json(entries).size()>450*1024)break;
      end=i+1;
      const auto &f=files[i];const auto child=relative.isEmpty()?f.fileName():relative+'/'+f.fileName();
      if(child.size()>4096 || f.fileName().size()>255)continue;
      entries.append(Object{{"name",f.fileName()},{"path",child},{"kind",f.isDir()?"directory":"file"},{"size",double(qMax<qint64>(0,f.size()))},{"link",f.isSymLink() || f.isJunction()}});
    }
    verify();
    if(directoryVersion!=hash(json(Array{fileIdentity(path),double(QFileInfo(path).lastModified().toMSecsSinceEpoch()),binding})))throw Error("project-directory-changed");
    return {{"kind","list"},{"entries",entries},{"limited",limited},{"nextCursor",end<files.size()?QJsonValue(directoryVersion+':'+QString::number(end)):QJsonValue(QJsonValue::Null)}};
  }
  if(operation!="search" || query["query"].toString().isEmpty() || query["query"].toString().size()>256 || !QStringList{"path","content"}.contains(query["mode"].toString()))throw Error("project-path-invalid");
  for(const auto &key:projectScans.keys())if(projectScans[key]->expires<now())projectScans.remove(key);
  std::shared_ptr<ProjectScan> scan;
  auto cursor=query["cursor"].toString();
  if(!cursor.isEmpty()) {
    scan=projectScans.take(cursor);
    if(!scan || scan->binding!=binding || scan->expires<now())throw Error("project-search-expired");
  }else{
    scan=std::make_shared<ProjectScan>();scan->binding=binding;scan->root=root;scan->directories.append(path);
  }
  const auto sensitivity=query["caseSensitive"].toBool()?Qt::CaseSensitive:Qt::CaseInsensitive;
  const auto needle=query["query"].toString();
  QElapsedTimer timer;timer.start();qint64 bytes=0;int visited=0;Array matches;
  while(matches.size()<100 && json(matches).size()<450*1024 && timer.elapsed()<750 && bytes<16*1024*1024 && visited<3000) {
    check();
    if(!scan->text.isEmpty()) {
      while(scan->textOffset<scan->text.size() && matches.size()<100 && json(matches).size()<450*1024 && timer.elapsed()<750) {
        auto end=scan->text.indexOf('\n',scan->textOffset);if(end<0)end=scan->text.size();
        auto line=scan->text.mid(scan->textOffset,end-scan->textOffset);++scan->line;scan->textOffset=end+1;
        auto at=line.indexOf(needle,0,sensitivity);
        if(at>=0)matches.append(Object{{"path",scan->currentPath},{"line",scan->line},{"text",line.mid(qMax<qsizetype>(0,at-120),600)}});
      }
      if(scan->textOffset>=scan->text.size()){scan->text.clear();scan->textOffset=0;}
      continue;
    }
    if(!scan->iterator || !scan->iterator->hasNext()) {
      scan->iterator.reset();
      if(scan->directories.isEmpty())break;
      auto directory=scan->directories.takeLast();
      scopedPath(root,QDir(root).relativeFilePath(directory)=="."?QString{}:QDir(root).relativeFilePath(directory));
      scan->iterator=std::make_unique<QDirIterator>(directory,QDir::AllEntries|QDir::NoDotAndDotDot|QDir::Hidden|QDir::System);
      continue;
    }
    scan->iterator->next();auto f=scan->iterator->fileInfo();++visited;
    if(excluded(f,hidden))continue;
    if(f.isSymLink() || f.isJunction()){++scan->skipped;continue;}
    const auto child=QDir(root).relativeFilePath(f.filePath());
    if(child.size()>4096 || child.count('/')>64){++scan->skipped;continue;}
    scopedPath(root,child);
    if(f.isDir()) {
      if(scan->directories.size()<2048)scan->directories.append(f.filePath());else ++scan->skipped;
      continue;
    }
    if(!f.isFile())continue;
    ++scan->scanned;
    if(query["mode"]=="path") {
      if(child.contains(needle,sensitivity))matches.append(Object{{"path",child},{"line",0},{"text",child.right(600)}});
    }else{
      if(f.size()>2*1024*1024 || !f.isReadable()){++scan->skipped;continue;}
      QFile input(f.filePath());if(!input.open(QIODevice::ReadOnly)){++scan->skipped;continue;}
      auto data=input.read(2*1024*1024+1);bytes+=data.size();
      QStringDecoder decoder(QStringDecoder::Utf8);QString text=decoder.decode(data);
      if(data.size()>2*1024*1024 || data.contains('\0') || decoder.hasError() || QFileInfo(input).size()!=f.size() || QFileInfo(input).lastModified()!=f.lastModified()){++scan->skipped;continue;}
      scan->text=text;scan->textOffset=0;scan->currentPath=child;scan->line=0;
    }
  }
  verify();
  bool more=!scan->text.isEmpty() || (scan->iterator && scan->iterator->hasNext()) || !scan->directories.isEmpty();
  QJsonValue next=QJsonValue::Null;
  if(more){
    while(projectScans.size()>=4)projectScans.erase(projectScans.begin());
    auto token=uuid();scan->expires=now()+60000;projectScans[token]=scan;next=token;
    QTimer::singleShot(61000,this,[this,token]{projectScans.remove(token);});
  }
  return {{"kind","search"},{"matches",matches},{"nextCursor",next},{"limited",more || scan->skipped>0},{"skipped",scan->skipped},{"scanned",scan->scanned}};
}
} // namespace Native
