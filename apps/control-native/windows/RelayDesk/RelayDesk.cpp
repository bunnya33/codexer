// RelayDesk.cpp : Defines the entry point for the application.
//

#include "pch.h"
#include "RelayDesk.h"

#include "AutolinkedNativeModules.g.h"

#include "NativeModules.h"
#include "DesktopHost.h"
#include <fstream>

// A PackageProvider containing any turbo modules you define within this app project
struct CompReactPackageProvider
    : winrt::implements<CompReactPackageProvider, winrt::Microsoft::ReactNative::IReactPackageProvider> {
 public: // IReactPackageProvider
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
    AddAttributedModules(packageBuilder, true);
  }
};

// The entry point of the Win32 application
_Use_decl_annotations_ int CALLBACK WinMain(HINSTANCE instance, HINSTANCE, PSTR /* commandLine */, int showCmd) {
  // Initialize WinRT
  winrt::init_apartment(winrt::apartment_type::single_threaded);

  // Enable per monitor DPI scaling
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Find the path hosting the app exe file
  WCHAR appDirectory[MAX_PATH];
  GetModuleFileNameW(NULL, appDirectory, MAX_PATH);
  PathCchRemoveFileSpec(appDirectory, MAX_PATH);

  desktop::Host host;
  desktop::host = &host;
  WCHAR executable[32768]; GetModuleFileNameW(nullptr, executable, 32768);
  host.exe = executable; host.directory = appDirectory;
  auto stem = std::filesystem::path(host.exe).stem().wstring();
  host.mode = desktop::env(L"CODEXER_NATIVE_MODE");
  if (host.mode != L"agent" && host.mode != L"control") host.mode = stem == L"Codexer" ? L"agent" : L"control";
  host.name = host.mode == L"agent" ? L"Codexer PC Agent" : L"RelayDesk";
  host.profile = desktop::env(L"CODEXER_NATIVE_DATA_DIR");
  if (host.profile.empty()) host.profile = desktop::env(L"APPDATA") + (host.mode == L"agent" ? L"\\Codexer" : L"\\CodexerControl");
  host.instanceKey = L"CodexerNative-" + host.mode + L"-" + std::to_wstring(std::hash<std::wstring>{}(host.profile));
  auto mutex = CreateMutexW(nullptr, TRUE, host.instanceKey.c_str());
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    EnumWindows([](HWND hwnd, LPARAM data)->BOOL { auto host = reinterpret_cast<desktop::Host*>(data); if (GetPropW(hwnd, host->instanceKey.c_str())) { PostMessageW(hwnd, desktop::Host::RestoreMessage, 0, 0); return FALSE; } return TRUE; }, reinterpret_cast<LPARAM>(&host));
    CloseHandle(mutex); return 0;
  }

  // Create a ReactNativeWin32App with the ReactNativeAppBuilder
  auto reactNativeWin32App{winrt::Microsoft::ReactNative::ReactNativeAppBuilder().Build()};

  // Configure the initial InstanceSettings for the app's ReactNativeHost
  auto settings{reactNativeWin32App.ReactNativeHost().InstanceSettings()};
  if (!desktop::env(L"CODEXER_NATIVE_DATA_DIR").empty()) {
    std::filesystem::create_directories(host.profile);
    settings.NativeLogger([profile=host.profile](auto, winrt::hstring const& message) {
      std::ofstream log(std::filesystem::path(profile) / L"native-renderer.log",std::ios::app); log << winrt::to_string(message) << "\n";
    });
  }
  // Register any autolinked native modules
  RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
  // Register any native modules defined within this app project
  settings.PackageProviders().Append(winrt::make<CompReactPackageProvider>());

#if BUNDLE
  // Load the JS bundle from a file (not Metro):
  // Set the path (on disk) where the .bundle file is located
  settings.BundleRootPath(std::wstring(L"file://").append(appDirectory).append(L"\\Bundle\\").c_str());
  // Set the name of the bundle file (without the .bundle extension)
  settings.JavaScriptBundleFile(L"index.windows");
  // Disable hot reload
  settings.UseFastRefresh(false);
#else
  // Load the JS bundle from Metro
  settings.JavaScriptBundleFile(L"index");
  // Enable hot reload
  settings.UseFastRefresh(true);
#endif
#if _DEBUG
  // For Debug builds
  // Enable Direct Debugging of JS
  settings.UseDirectDebugger(true);
  // Enable the Developer Menu
  settings.UseDeveloperSupport(true);
#else
  // For Release builds:
  // Disable Direct Debugging of JS
  settings.UseDirectDebugger(false);
  // Disable the Developer Menu
  settings.UseDeveloperSupport(false);
#endif

  // Get the AppWindow so we can configure its initial title and size
  auto appWindow{reactNativeWin32App.AppWindow()};
  host.window = appWindow;
  host.hwnd = winrt::Microsoft::UI::GetWindowFromWindowId(appWindow.Id());
  SetPropW(host.hwnd, host.instanceKey.c_str(), reinterpret_cast<HANDLE>(1));
  SetWindowSubclass(host.hwnd, desktop::Host::subclass, 1, reinterpret_cast<DWORD_PTR>(&host));
  desktop::Host::wheelHost = &host;
  host.wheelHook = SetWindowsHookExW(WH_GETMESSAGE, desktop::Host::wheelMessage, nullptr, GetCurrentThreadId());
  appWindow.Title(host.name);
  appWindow.Resize({1280, 860});
  host.addTray();
  appWindow.Closing([&host](auto const&, auto const& args) {
    if (host.quitting) return;
    args.Cancel(true);
    if (!host.closeExits && host.trayAdded) host.window.Hide(); else host.exit();
  });
  try { host.start(); }
  catch (...) { MessageBoxW(host.hwnd, L"无法启动本机服务，请重新安装完整客户端。", host.name.c_str(), MB_OK | MB_ICONERROR); CloseHandle(mutex); return 1; }

  // Get the ReactViewOptions so we can set the initial RN component to load
  auto viewOptions{reactNativeWin32App.ReactViewOptions()};
  viewOptions.ComponentName(L"RelayDesk");

  // Start the app
  ShowWindow(host.hwnd, SW_SHOW);
  if (std::wstring(GetCommandLineW()).find(L"--background") != std::wstring::npos) host.ui([&host] { if(host.trayAdded) host.window.Hide(); });
  reactNativeWin32App.Start();
  CloseHandle(mutex);
  return 0;
}
