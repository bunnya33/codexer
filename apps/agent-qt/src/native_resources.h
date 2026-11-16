#pragma once
#include <QtCore>
#include <functional>
#include <optional>

namespace Native {
struct ProcessReading {
  qint64 pid = 0, startedAt = 0;
  quint64 identity = 0;
  std::optional<quint64> cpuNs, residentBytes, privateBytes, privateWorkingSetBytes;
};
// At most two counters and one small response; no timers, process walks or history.
class ResourceMonitor {
  std::function<ProcessReading(qint64)> readProcess;
  std::function<qint64()> clock;
  QHash<qint64, ProcessReading> previous;
  QJsonObject cached;
  qint64 previousAt = -1, cachedChild = -1;
  int cpus;
public:
  explicit ResourceMonitor(std::function<ProcessReading(qint64)> reader = {},
                           std::function<qint64()> monotonic = {}, int logicalCpus = 0);
  QJsonObject sample(qint64 childPid = 0);
};
}
