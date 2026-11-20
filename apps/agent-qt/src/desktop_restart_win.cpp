#include "native.h"
#include <windows.h>
#include <appmodel.h>
#include <shobjidl.h>
#include <tlhelp32.h>
#include <algorithm>
#include <vector>

namespace Native {
namespace {
constexpr auto PackageFamily = L"OpenAI.Codex_2p2nqsd0c76g0";
constexpr auto ApplicationId = L"OpenAI.Codex_2p2nqsd0c76g0!App";
using Handle = std::unique_ptr<void, decltype(&CloseHandle)>;

bool isCodexPackage(HANDLE process) {
  wchar_t name[PACKAGE_FAMILY_NAME_MAX_LENGTH + 1]{};
  UINT32 length = ARRAYSIZE(name);
  return GetPackageFamilyName(process, &length, name) == ERROR_SUCCESS &&
         wcscmp(name, PackageFamily) == 0;
}

} // namespace

void restartCodexDesktop() {
  DWORD session = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &session) || !session)
    throw Error("desktop-restart-unavailable");

  const auto comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE)
    throw Error("desktop-restart-unavailable");
  const auto uninitialize = qScopeGuard([&] {
    if (SUCCEEDED(comResult))
      CoUninitialize();
  });
  IApplicationActivationManager *activation = nullptr;
  if (FAILED(CoCreateInstance(__uuidof(ApplicationActivationManager), nullptr,
                             CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(&activation))))
    throw Error("desktop-restart-unavailable");
  const auto releaseActivation = qScopeGuard([&] { activation->Release(); });

  auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    throw Error("desktop-restart-unavailable");
  const Handle closeSnapshot(snapshot, &CloseHandle);
  PROCESSENTRY32W process{};
  process.dwSize = sizeof(process);
  if (!Process32FirstW(snapshot, &process))
    throw Error("desktop-restart-unavailable");

  std::vector<Handle> targets;
  QSet<DWORD> windows;
  do {
    const bool desktop = _wcsicmp(process.szExeFile, L"ChatGPT.exe") == 0;
    if (!desktop && _wcsicmp(process.szExeFile, L"codex.exe") != 0)
      continue;
    DWORD processSession = 0;
    if (!ProcessIdToSessionId(process.th32ProcessID, &processSession) ||
        processSession != session)
      continue;
    Handle handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION |
                                  PROCESS_TERMINATE | SYNCHRONIZE,
                              FALSE, process.th32ProcessID),
                  &CloseHandle);
    if (!handle || !isCodexPackage(handle.get()))
      continue;
    if (desktop)
      windows.insert(process.th32ProcessID);
    targets.push_back(std::move(handle));
  } while (Process32NextW(snapshot, &process));

  if (!windows.isEmpty())
    EnumWindows([](HWND window, LPARAM context) -> BOOL {
      const auto &ids = *reinterpret_cast<const QSet<DWORD> *>(context);
      DWORD processId = 0;
      GetWindowThreadProcessId(window, &processId);
      if (ids.contains(processId) && IsWindowVisible(window))
        PostMessageW(window, WM_CLOSE, 0, 0);
      return TRUE;
    }, reinterpret_cast<LPARAM>(&windows));

  const auto stopped = [&] {
    return std::all_of(targets.cbegin(), targets.cend(), [](const auto &target) {
      return WaitForSingleObject(target.get(), 0) == WAIT_OBJECT_0;
    });
  };
  if (!waitFor(stopped, 5000)) {
    for (const auto &target : targets)
      if (WaitForSingleObject(target.get(), 0) == WAIT_TIMEOUT)
        TerminateProcess(target.get(), 1);
    if (!waitFor(stopped, 5000))
      throw Error("desktop-restart-exit-unconfirmed", true);
  }

  DWORD pid = 0, newSession = 0;
  if (FAILED(activation->ActivateApplication(ApplicationId, nullptr, AO_NONE, &pid)))
    throw Error("desktop-restart-launch-failed");
  const Handle launched(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                                    FALSE, pid),
                        &CloseHandle);
  if (!launched || !isCodexPackage(launched.get()) ||
      !ProcessIdToSessionId(pid, &newSession) || newSession != session ||
      WaitForSingleObject(launched.get(), 0) != WAIT_TIMEOUT)
    throw Error("desktop-restart-launch-unconfirmed", true);
}
} // namespace Native
