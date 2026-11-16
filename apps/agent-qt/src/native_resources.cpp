#include "native_resources.h"
#include <algorithm>
#include <cstddef>
#ifdef Q_OS_WIN
#include <windows.h>
#include <psapi.h>
#elif defined(Q_OS_MACOS)
#include <libproc.h>
#include <sys/proc_info.h>
#else
#include <unistd.h>
#endif

namespace Native {
static ProcessReading processReading(qint64 pid) {
  ProcessReading value;
  value.pid = pid;
#ifdef Q_OS_WIN
  const auto handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, DWORD(pid));
  if (!handle) return value;
  FILETIME created{}, exited{}, kernel{}, user{};
  const auto ticks = [](FILETIME time) { return (quint64(time.dwHighDateTime) << 32) | time.dwLowDateTime; };
  if (GetProcessTimes(handle, &created, &exited, &kernel, &user)) {
    value.startedAt = qint64((ticks(created) - 116444736000000000ULL) / 10000);
    value.identity = ticks(created);
    value.cpuNs = (ticks(kernel) + ticks(user)) * 100;
  }
  // PROCESS_MEMORY_COUNTERS_EX2 has this ABI, but some supported SDK versions
  // hide its declaration behind a newer NTDDI_VERSION. Keep the runtime fallback.
  struct MemoryCounters {
    PROCESS_MEMORY_COUNTERS_EX base{};
    SIZE_T privateWorkingSetSize = SIZE_T(-1);
    ULONG64 sharedCommitUsage = 0;
  } memory;
  static_assert(offsetof(MemoryCounters, privateWorkingSetSize) == sizeof(PROCESS_MEMORY_COUNTERS_EX));
  memory.base.cb = sizeof(memory);
  if (GetProcessMemoryInfo(handle, reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&memory), sizeof(memory))) {
    value.residentBytes = quint64(memory.base.WorkingSetSize);
    value.privateBytes = quint64(memory.base.PrivateUsage);
    if (memory.privateWorkingSetSize != SIZE_T(-1))
      value.privateWorkingSetBytes = quint64(memory.privateWorkingSetSize);
  } else if (GetProcessMemoryInfo(handle, reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&memory.base), sizeof(memory.base))) {
    value.residentBytes = quint64(memory.base.WorkingSetSize);
    value.privateBytes = quint64(memory.base.PrivateUsage);
  }
  CloseHandle(handle);
#elif defined(Q_OS_MACOS)
  proc_taskinfo task{};
  if (proc_pidinfo(int(pid), PROC_PIDTASKINFO, 0, &task, sizeof(task)) == sizeof(task)) {
    value.cpuNs = task.pti_total_user + task.pti_total_system;
    value.residentBytes = task.pti_resident_size;
  }
  proc_bsdinfo info{};
  if (proc_pidinfo(int(pid), PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info))
    value.startedAt = qint64(info.pbi_start_tvsec) * 1000 + info.pbi_start_tvusec / 1000;
  value.identity = quint64(value.startedAt);
#else
  QFile stat(QString("/proc/%1/stat").arg(pid));
  if (stat.open(QIODevice::ReadOnly)) {
    const auto line = stat.readAll();
    const auto fields = line.mid(line.lastIndexOf(')') + 2).simplified().split(' ');
    const qint64 ticks = sysconf(_SC_CLK_TCK), page = sysconf(_SC_PAGESIZE);
    if (fields.size() > 21 && ticks > 0 && page > 0) {
      value.cpuNs = (fields[11].toULongLong() + fields[12].toULongLong()) * 1000000000ULL / quint64(ticks);
      value.identity = fields[19].toULongLong();
      value.residentBytes = fields[21].toULongLong() * quint64(page);
      QFile uptime("/proc/uptime");
      if (uptime.open(QIODevice::ReadOnly))
        value.startedAt = QDateTime::currentMSecsSinceEpoch() - qint64(uptime.readAll().split(' ')[0].toDouble() * 1000) + qint64(fields[19].toULongLong() * 1000 / quint64(ticks));
    }
  }
#endif
  return value;
}
ResourceMonitor::ResourceMonitor(std::function<ProcessReading(qint64)> reader,
                                 std::function<qint64()> monotonic, int logicalCpus)
    : readProcess(reader ? std::move(reader) : processReading),
      clock(monotonic ? std::move(monotonic) : std::function<qint64()>([] {
        static const auto epoch = [] { QElapsedTimer timer; timer.start(); return timer; }();
        return epoch.elapsed();
      })), cpus(qMax(1, logicalCpus ? logicalCpus : QThread::idealThreadCount())) {}
QJsonObject ResourceMonitor::sample(qint64 childPid) {
  const auto at = clock(), elapsed = previousAt < 0 ? -1 : at - previousAt;
  if (!cached.isEmpty() && childPid == cachedChild && elapsed >= 0 && elapsed < 1000) return cached;
  const auto wall = QDateTime::currentMSecsSinceEpoch();
  const bool interval = elapsed >= 1000 && elapsed <= 30000;
  QHash<qint64, ProcessReading> next;
  const auto row = [&](qint64 pid, const QString &name) {
    const auto current = readProcess(pid), old = previous.value(pid);
    QJsonValue cpu(QJsonValue::Null);
    // Process start time also guards against PID reuse after a runtime restart.
    if (interval && current.identity > 0 && current.identity == old.identity && current.cpuNs && old.cpuNs && *current.cpuNs >= *old.cpuNs)
      cpu = qBound(0.0, double(*current.cpuNs - *old.cpuNs) / (double(elapsed) * 1000000 * cpus) * 100, 100.0);
    next.insert(pid, current);
    const auto bytes = [](std::optional<quint64> count) { return count ? QJsonValue(double(*count)) : QJsonValue(QJsonValue::Null); };
    return QJsonObject{{"pid", double(pid)}, {"name", name}, {"cpuPercent", cpu},
                       {"residentBytes", bytes(current.residentBytes)}, {"privateBytes", bytes(current.privateBytes)},
                       {"privateWorkingSetBytes", bytes(current.privateWorkingSetBytes)},
                       {"uptimeSeconds", current.startedAt > 0 ? QJsonValue(qMax(0.0, double(wall - current.startedAt) / 1000)) : QJsonValue(QJsonValue::Null)}};
  };
  const auto ownPid = QCoreApplication::applicationPid();
  const auto agent = row(ownPid, "Codexer Agent");
  QJsonArray children;
  if (childPid > 0 && childPid != ownPid) children.append(row(childPid, "Codex app-server"));
  cached = {{"capturedAt", double(wall)}, {"logicalCpus", cpus},
            {"sampleWindowMs", interval ? QJsonValue(double(elapsed)) : QJsonValue(QJsonValue::Null)},
            {"agent", agent}, {"children", children}};
  previous = std::move(next);
  previousAt = at;
  cachedChild = childPid;
  return cached;
}
}
