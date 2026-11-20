#define NOMINMAX
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <algorithm>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#pragma comment(linker, "/manifestdependency:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

namespace {
using Handle = std::unique_ptr<void, decltype(&CloseHandle)>;
enum { Retry = 100, CloseAndContinue = 101 };

bool samePath(const std::wstring &left, const std::wstring &right) {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) ==
         CSTR_EQUAL;
}

std::wstring normalizedPath(const std::filesystem::path &path) {
  std::error_code error;
  auto canonical = std::filesystem::weakly_canonical(path, error);
  return (error ? path.lexically_normal() : canonical).make_preferred().native();
}

std::optional<std::vector<Handle>>
runningAgents(const std::vector<std::wstring> &paths) {
  auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    return std::nullopt;
  const Handle snapshotHandle(snapshot, &CloseHandle);
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot, &entry))
    return std::nullopt;

  std::vector<Handle> running;
  do {
    const bool matchingName = std::any_of(paths.begin(), paths.end(),
        [&](const auto &path) {
          return samePath(std::filesystem::path(path).filename().native(),
                          entry.szExeFile);
        });
    if (!matchingName)
      continue;
    constexpr DWORD query = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
    Handle process(OpenProcess(query | PROCESS_TERMINATE, FALSE,
                               entry.th32ProcessID), &CloseHandle);
    if (!process)
      process.reset(OpenProcess(query, FALSE, entry.th32ProcessID));
    std::wstring image(32768, L'\0');
    DWORD length = static_cast<DWORD>(image.size());
    if (!process || !QueryFullProcessImageNameW(process.get(), 0, image.data(),
                                                &length))
      continue;
    image.resize(length);
    const auto imagePath = normalizedPath(image);
    if (std::any_of(paths.begin(), paths.end(), [&](const auto &path) {
          return samePath(path, imagePath);
        }) && WaitForSingleObject(process.get(), 0) == WAIT_TIMEOUT)
      running.push_back(std::move(process));
  } while (Process32NextW(snapshot, &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES)
    return std::nullopt;
  return running;
}

int prompt(HWND owner, bool closeFailed, bool uninstall) {
  const TASKDIALOG_BUTTON buttons[] = {
      {Retry, L"重试"}, {CloseAndContinue, L"关闭进程并继续"},
      {IDCANCEL, uninstall ? L"取消卸载" : L"取消安装"}};
  TASKDIALOGCONFIG dialog{};
  dialog.cbSize = sizeof(dialog);
  dialog.hwndParent = owner;
  dialog.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
  dialog.pszWindowTitle = uninstall ? L"Codexer Agent 卸载程序"
                                   : L"Codexer Agent 安装程序";
  dialog.pszMainIcon = TD_WARNING_ICON;
  dialog.pszMainInstruction = L"Codexer Agent 正在运行";
  dialog.pszContent = closeFailed
      ? L"未能关闭 Agent。请从系统托盘退出 Agent 后点击重试。"
      : L"请退出 Agent 后重试，或让安装程序关闭进程。关闭进程可能中断当前任务。";
  dialog.cButtons = ARRAYSIZE(buttons);
  dialog.pButtons = buttons;
  dialog.nDefaultButton = Retry;
  int result = IDCANCEL;
  if (FAILED(TaskDialogIndirect(&dialog, &result, nullptr, nullptr)))
    return 0;
  return result;
}
} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argumentCount = 0;
  const std::unique_ptr<wchar_t *, decltype(&LocalFree)> arguments(
      CommandLineToArgvW(GetCommandLineW(), &argumentCount), &LocalFree);
  if (!arguments || argumentCount < 4)
    return ERROR_INVALID_PARAMETER;
  const bool uninstall = wcscmp(arguments.get()[2], L"uninstall") == 0;
  const bool silent = wcscmp(arguments.get()[1], L"--silent") == 0;
  const auto owner = reinterpret_cast<HWND>(
      static_cast<UINT_PTR>(_wcstoui64(arguments.get()[1], nullptr, 10)));
  std::vector<std::wstring> paths;
  for (int i = 3; i < argumentCount; ++i) {
    if (*arguments.get()[i])
      paths.push_back(normalizedPath(arguments.get()[i]));
  }

  bool closeFailed = false;
  for (;;) {
    auto running = runningAgents(paths);
    if (!running)
      return ERROR_INSTALL_FAILURE;
    if (running->empty())
      return ERROR_SUCCESS;
    if (silent)
      return ERROR_INSTALL_ALREADY_RUNNING;
    const int choice = prompt(owner, closeFailed, uninstall);
    if (choice == IDCANCEL)
      return ERROR_INSTALL_USEREXIT;
    if (choice == Retry)
      continue;
    if (choice != CloseAndContinue)
      return ERROR_INSTALL_FAILURE;
    for (const auto &process : *running)
      TerminateProcess(process.get(), 0);
    for (const auto &process : *running)
      WaitForSingleObject(process.get(), 3000);
    closeFailed = true;
  }
}
