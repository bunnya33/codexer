#pragma once
#include "NativeModules.h"
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>
#include <shellapi.h>
#include <dwmapi.h>
#pragma comment(lib, "dwmapi.lib")
#include <shobjidl.h>
#include <commctrl.h>
#include <wincrypt.h>
#include <wincodec.h>
#include <wrl.h>
#include <WebView2.h>
#include <atomic>
#include <filesystem>
#include <functional>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace desktop {
using namespace winrt::Windows::Data::Json;
using winrt::Microsoft::ReactNative::ReactContext;
using Microsoft::WRL::ComPtr;
using Reply = std::function<void(IJsonValue, std::string)>;
inline JsonValue str(std::wstring_view value) { return JsonValue::CreateStringValue(value); }
inline JsonValue text(std::string_view value) { return str(winrt::to_hstring(value)); }
inline JsonValue boolean(bool value) { return JsonValue::CreateBooleanValue(value); }
inline JsonValue number(double value) { return JsonValue::CreateNumberValue(value); }
inline std::wstring env(const wchar_t* name) {
  auto size = GetEnvironmentVariableW(name, nullptr, 0); if (!size) return {};
  std::wstring value(size, 0); GetEnvironmentVariableW(name, value.data(), size); value.resize(size - 1); return value;
}
inline std::wstring field(JsonObject const& value, wchar_t const* name, wchar_t const* fallback = L"") {
  return std::wstring(value.GetNamedString(name, fallback));
}
inline std::vector<uint8_t> decode(std::wstring_view value) {
  auto buffer = winrt::Windows::Security::Cryptography::CryptographicBuffer::DecodeFromBase64String(value);
  winrt::com_array<uint8_t> bytes; winrt::Windows::Security::Cryptography::CryptographicBuffer::CopyToByteArray(buffer, bytes);
  return {bytes.begin(), bytes.end()};
}
inline JsonValue encode(const uint8_t* data, size_t length) {
  auto buffer = winrt::Windows::Security::Cryptography::CryptographicBuffer::CreateFromByteArray({data, data + length});
  return str(winrt::Windows::Security::Cryptography::CryptographicBuffer::EncodeToBase64String(buffer));
}
struct PreviewWindow {
  HWND hwnd{}; std::wstring id;
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> view;
};
class Host {
 public:
  HWND hwnd{};
  winrt::Microsoft::UI::Windowing::AppWindow window{nullptr};
  std::wstring exe, directory, profile, name, mode, instanceKey;
  ReactContext context;
  std::atomic<bool> closeExits{false}, quitting{false};
  std::atomic<int> activeTasks{0};
  HANDLE input{}, output{}, process{}, job{};
  std::thread reader, shutdownWatcher;
  HHOOK wheelHook{};
  static inline Host* wheelHost{};
  std::mutex writeMutex, pendingMutex;
  std::map<int, Reply> pending;
  std::atomic<int> sequence{0};
  NOTIFYICONDATAW tray{};
  UINT taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  bool trayAdded = false;
  std::map<std::wstring, std::shared_ptr<PreviewWindow>> previews;
  static constexpr UINT RunMessage = WM_APP + 41, TrayMessage = WM_APP + 42, RestoreMessage = WM_APP + 43;

  void ui(std::function<void()> action) {
    auto call = new std::function<void()>(std::move(action));
    if (!PostMessageW(hwnd, RunMessage, 0, reinterpret_cast<LPARAM>(call))) delete call;
  }
  void emit(std::wstring const& event, IJsonValue const& value) {
    if (context) context.EmitJSEvent(L"RCTDeviceEventEmitter", event, winrt::to_string(value.Stringify()));
  }
  void send(JsonObject const& message) {
    auto line = winrt::to_string(message.Stringify()) + "\n";
    std::lock_guard lock(writeMutex); DWORD written{}; size_t offset = 0;
    while (offset < line.size()) {
      if (!WriteFile(input, line.data() + offset, static_cast<DWORD>(line.size() - offset), &written, nullptr) || !written) throw std::runtime_error("native-service-unavailable");
      offset += written;
    }
  }
  void request(std::string const& method, std::string const& payload, Reply reply) {
    try {
      JsonObject message; int id = ++sequence;
      message.Insert(L"id", number(id)); message.Insert(L"method", text(method));
      message.Insert(L"value", JsonValue::Parse(winrt::to_hstring(payload)));
      { std::lock_guard lock(pendingMutex); pending.emplace(id, std::move(reply)); }
      try { send(message); } catch (...) {
        Reply failed; { std::lock_guard lock(pendingMutex); failed = std::move(pending.at(id)); pending.erase(id); }
        failed(nullptr, "native-service-unavailable");
      }
    } catch (...) { if (reply) reply(nullptr, "invalid-native-request"); }
  }
  void receive(std::string const& line) {
    JsonObject message; if (!JsonObject::TryParse(winrt::to_hstring(line), message)) return;
    if (message.HasKey(L"nativeId")) {
      auto id = message.GetNamedNumber(L"nativeId"); auto method = field(message, L"method");
      auto value = message.GetNamedObject(L"value", JsonObject());
      ui([this,id,method,value] {
        auto done = [this,id](IJsonValue result, std::string error) {
          JsonObject response; response.Insert(L"nativeId", number(id));
          if (error.empty()) response.Insert(L"value", result ? result : JsonValue::CreateNullValue()); else response.Insert(L"error", text(error));
          try { send(response); } catch (...) {}
        };
        try { platform(method, value, done); } catch (...) { done(nullptr, "windows-operation-failed"); }
      });
    } else if (message.HasKey(L"event")) {
      auto event = field(message, L"event"); auto value = message.GetNamedValue(L"value", JsonValue::CreateNullValue());
      if (event == L"preferences" && value.ValueType() == JsonValueType::Object) closeExits = value.GetObject().GetNamedBoolean(L"closeExits", false);
      if (event == L"activeTasks") activeTasks = static_cast<int>(value.GetNumber());
      emit(event, value);
    } else if (message.HasKey(L"id")) {
      Reply reply; int id = static_cast<int>(message.GetNamedNumber(L"id"));
      { std::lock_guard lock(pendingMutex); auto item = pending.find(id); if (item != pending.end()) { reply = std::move(item->second); pending.erase(item); } }
      if (reply) reply(message.GetNamedValue(L"value", JsonValue::CreateNullValue()), winrt::to_string(message.GetNamedString(L"error", L"")));
    }
  }
  void start() {
    SetEnvironmentVariableW(L"CODEXER_NATIVE_MODE", mode.c_str());
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE childInput{}, childOutput{};
    winrt::check_bool(CreatePipe(&childInput, &input, &security, 0));
    winrt::check_bool(CreatePipe(&output, &childOutput, &security, 0));
    SetHandleInformation(input, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(output, HANDLE_FLAG_INHERIT, 0);
    HANDLE nullOutput = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOW startup{sizeof(startup)}; startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = childInput; startup.hStdOutput = childOutput; startup.hStdError = nullOutput;
    PROCESS_INFORMATION child{};
    std::wstring command = L"\"" + directory + L"\\runtime\\node.exe\" \"" + directory + L"\\service\\sidecar.cjs\"";
    BOOL ok = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, directory.c_str(), &startup, &child);
    CloseHandle(childInput); CloseHandle(childOutput); CloseHandle(nullOutput);
    winrt::check_bool(ok); process = child.hProcess;
    job = CreateJobObjectW(nullptr, nullptr); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
    AssignProcessToJobObject(job, process); ResumeThread(child.hThread); CloseHandle(child.hThread);
    reader = std::thread([this] {
      winrt::init_apartment(); std::string buffered; char bytes[32768]; DWORD count{};
      while (ReadFile(output, bytes, sizeof(bytes), &count, nullptr) && count) {
        buffered.append(bytes, count); size_t at;
        while ((at = buffered.find('\n')) != std::string::npos) {
          auto line = buffered.substr(0, at); buffered.erase(0, at + 1);
          try { receive(line); } catch (...) {}
        }
        if (buffered.size() > 16 * 1024 * 1024) break;
      }
      std::map<int, Reply> failed; { std::lock_guard lock(pendingMutex); failed.swap(pending); }
      for (auto& [id, reply] : failed) reply(nullptr, "native-service-stopped");
      if (!quitting) emit(L"backendError", text("native-service-stopped"));
    });
  }
  void addTray() {
    if (trayAdded) Shell_NotifyIconW(NIM_DELETE, &tray);
    tray = {}; tray.cbSize = sizeof(tray); tray.hWnd = hwnd; tray.uID = 1;
    tray.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP; tray.uCallbackMessage = TrayMessage;
    tray.hIcon = static_cast<HICON>(LoadImageW(nullptr, (directory + L"\\icon.ico").c_str(), IMAGE_ICON, 32, 32, LR_LOADFROMFILE | LR_SHARED));
    if (!tray.hIcon) tray.hIcon = static_cast<HICON>(LoadImageW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(1008), IMAGE_ICON, 32, 32, LR_DEFAULTCOLOR | LR_SHARED));
    if (!tray.hIcon) tray.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(tray.hIcon));
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(tray.hIcon));
    wcscpy_s(tray.szTip, name.c_str()); trayAdded = !!Shell_NotifyIconW(NIM_ADD, &tray);
  }
  void restore() { window.Show(); ShowWindow(hwnd, SW_RESTORE); SetForegroundWindow(hwnd); }
  void exit(bool confirm = true) {
    if (quitting) return;
    auto message = mode == L"agent" ? L"退出 PC Agent 后，这台电脑将无法远程控制。确定退出进程吗？" : L"确定退出 RelayDesk 进程吗？";
    if (activeTasks > 0) message = L"本机仍有任务运行。退出 PC Agent 会中断远程连接，并可能停止后台任务。确定退出进程吗？";
    if (confirm && MessageBoxW(hwnd, message, name.c_str(), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2) != IDYES) return;
    quitting = true;
    request("shutdown", "{}", [this](IJsonValue, std::string) { ui([this] { window.Destroy(); }); });
    shutdownWatcher = std::thread([this] {
      if (WaitForSingleObject(process, 10000) == WAIT_TIMEOUT) {
        TerminateProcess(process, 0);
        ui([this] { if (IsWindow(hwnd)) window.Destroy(); });
      }
    });
  }
  void trayMenu() {
    POINT point{}; GetCursorPos(&point); auto menu = CreatePopupMenu();
    AppendMenuW(menu, MF_STRING, 1, L"打开窗口"); AppendMenuW(menu, MF_STRING, 2, L"设置"); AppendMenuW(menu, MF_SEPARATOR, 0, nullptr); AppendMenuW(menu, MF_STRING, 3, L"退出进程…");
    SetForegroundWindow(hwnd); auto selected = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, 0, hwnd, nullptr); DestroyMenu(menu);
    if (selected == 1) restore();
    if (selected == 2) { restore(); emit(L"openSettings", JsonValue::CreateNullValue()); }
    if (selected == 3) exit();
  }
  static LRESULT CALLBACK subclass(HWND target, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR, DWORD_PTR data) {
    auto host = reinterpret_cast<Host*>(data);
    if (message == RunMessage) { std::unique_ptr<std::function<void()>> action(reinterpret_cast<std::function<void()>*>(lparam)); (*action)(); return 0; }
    if (message == RestoreMessage) { host->restore(); return 0; }
    if (message == TrayMessage) { if (lparam == WM_LBUTTONUP || lparam == WM_LBUTTONDBLCLK) host->restore(); if (lparam == WM_RBUTTONUP) host->trayMenu(); return 0; }
    if (message == host->taskbarCreated) { host->addTray(); return 0; }
    return DefSubclassProc(target, message, wparam, lparam);
  }
  // Fabric scroll viewers own child HWNDs, so observe the whole UI thread.
  static LRESULT CALLBACK wheelMessage(int code, WPARAM removed, LPARAM data) {
    if (code >= 0 && removed == PM_REMOVE && wheelHost) {
      auto message = reinterpret_cast<MSG*>(data);
      if (message->message == WM_MOUSEWHEEL && (message->hwnd == wheelHost->hwnd || IsChild(wheelHost->hwnd, message->hwnd))) {
        JsonObject value;
        value.Insert(L"direction", text(GET_WHEEL_DELTA_WPARAM(message->wParam) > 0 ? "up" : "down"));
        wheelHost->emit(L"scrollIntent", value);
      }
    }
    return CallNextHookEx(nullptr, code, removed, data);
  }
  JsonValue crypt(JsonObject const& value, bool protect) {
    auto bytes = decode(field(value, L"value")); DATA_BLOB inputBlob{static_cast<DWORD>(bytes.size()),bytes.data()}, outputBlob{};
    BOOL ok = protect ? CryptProtectData(&inputBlob, L"Codexer native credentials", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &outputBlob) : CryptUnprotectData(&inputBlob, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &outputBlob);
    winrt::check_bool(ok); auto result = encode(outputBlob.pbData, outputBlob.cbData); LocalFree(outputBlob.pbData); return result;
  }
  JsonValue convertImage(JsonObject const& value) {
    ComPtr<IWICImagingFactory> factory; winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
    ComPtr<IWICBitmapDecoder> decoder; winrt::check_hresult(factory->CreateDecoderFromFilename(field(value,L"path").c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder));
    ComPtr<IWICBitmapFrameDecode> frame; winrt::check_hresult(decoder->GetFrame(0,&frame));
    UINT width{},height{}; winrt::check_hresult(frame->GetSize(&width,&height));
    if (!width || !height || static_cast<uint64_t>(width)*height > 100000000) throw std::runtime_error("image-too-large");
    auto edge = std::clamp(value.GetNamedNumber(L"edge",1600), 100., 4096.);
    double ratio = std::min(1., edge / std::max(width,height)); width = std::max(1u,static_cast<UINT>(width*ratio)); height = std::max(1u,static_cast<UINT>(height*ratio));
    ComPtr<IWICBitmapScaler> scaler; winrt::check_hresult(factory->CreateBitmapScaler(&scaler)); winrt::check_hresult(scaler->Initialize(frame.Get(),width,height,WICBitmapInterpolationModeFant));
    ComPtr<IWICFormatConverter> pixels; winrt::check_hresult(factory->CreateFormatConverter(&pixels)); winrt::check_hresult(pixels->Initialize(scaler.Get(),GUID_WICPixelFormat24bppBGR,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom));
    ComPtr<IStream> stream; winrt::check_hresult(CreateStreamOnHGlobal(nullptr,TRUE,&stream));
    ComPtr<IWICBitmapEncoder> encoder; winrt::check_hresult(factory->CreateEncoder(GUID_ContainerFormatJpeg,nullptr,&encoder)); winrt::check_hresult(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache));
    ComPtr<IWICBitmapFrameEncode> encoded; ComPtr<IPropertyBag2> options; winrt::check_hresult(encoder->CreateNewFrame(&encoded,&options));
    PROPBAG2 quality{}; quality.pstrName = const_cast<LPOLESTR>(L"ImageQuality"); VARIANT setting; VariantInit(&setting); setting.vt=VT_R4; setting.fltVal=static_cast<float>(std::clamp(value.GetNamedNumber(L"quality",.85),.1,1.));
    winrt::check_hresult(options->Write(1,&quality,&setting)); winrt::check_hresult(encoded->Initialize(options.Get())); winrt::check_hresult(encoded->SetSize(width,height)); auto format=GUID_WICPixelFormat24bppBGR;
    winrt::check_hresult(encoded->SetPixelFormat(&format)); winrt::check_hresult(encoded->WriteSource(pixels.Get(),nullptr)); winrt::check_hresult(encoded->Commit()); winrt::check_hresult(encoder->Commit());
    STATSTG info{}; winrt::check_hresult(stream->Stat(&info,STATFLAG_NONAME)); if (info.cbSize.QuadPart>8*1024*1024) throw std::runtime_error("image-too-large");
    HGLOBAL memory{}; winrt::check_hresult(GetHGlobalFromStream(stream.Get(),&memory)); auto data=static_cast<uint8_t*>(GlobalLock(memory)); auto base64=encode(data,static_cast<size_t>(info.cbSize.QuadPart)); GlobalUnlock(memory);
    JsonObject result; result.Insert(L"base64",base64); result.Insert(L"width",number(width)); result.Insert(L"height",number(height)); return result.as<JsonValue>();
  }
  void platform(std::wstring const& method, JsonObject const& value, Reply done);
  void openPreview(JsonObject const& value, Reply done);
  static LRESULT CALLBACK previewProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
  ~Host() {
    if (wheelHook) UnhookWindowsHookEx(wheelHook);
    wheelHost = nullptr;
    quitting = true; if (trayAdded) Shell_NotifyIconW(NIM_DELETE,&tray);
    if (input) CloseHandle(input);
    if (job) CloseHandle(job);
    if (reader.joinable()) reader.join();
    if (shutdownWatcher.joinable()) shutdownWatcher.join();
    if (output) CloseHandle(output); if (process) CloseHandle(process);
  }
};
inline Host* host{};

inline void Host::platform(std::wstring const& method, JsonObject const& value, Reply done) {
  if (method==L"window.theme") {
    BOOL dark = value.GetNamedBoolean(L"dark", false);
    auto color = [&](wchar_t const* key) { auto rgb = static_cast<unsigned int>(value.GetNamedNumber(key)); return RGB((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255); };
    COLORREF background = color(L"background"), foreground = color(L"text");
    struct Palette { HWND owner; BOOL dark; COLORREF background, foreground; } palette{hwnd, dark, background, foreground};
    // Include RNW-owned modal windows. Their custom AppWindow title bars need
    // the Windowing API in addition to DWM's system title bar attributes.
    EnumWindows([](HWND target, LPARAM data)->BOOL {
      auto& palette = *reinterpret_cast<Palette*>(data);
      DWORD process{}; GetWindowThreadProcessId(target, &process);
      if (process != GetCurrentProcessId() || GetAncestor(target, GA_ROOTOWNER) != palette.owner) return TRUE;
      DwmSetWindowAttribute(target, 20, &palette.dark, sizeof(palette.dark));
      DwmSetWindowAttribute(target, 35, &palette.background, sizeof(palette.background));
      DwmSetWindowAttribute(target, 36, &palette.foreground, sizeof(palette.foreground));
      try {
        auto bar = winrt::Microsoft::UI::Windowing::AppWindow::GetFromWindowId(winrt::Microsoft::UI::GetWindowIdFromWindow(target)).TitleBar();
        auto color = [](COLORREF value) { return winrt::Windows::UI::Color{255, GetRValue(value), GetGValue(value), GetBValue(value)}; };
        auto background = color(palette.background), foreground = color(palette.foreground);
        bar.BackgroundColor(background); bar.ForegroundColor(foreground);
        bar.InactiveBackgroundColor(background); bar.InactiveForegroundColor(foreground);
        bar.ButtonBackgroundColor(background); bar.ButtonForegroundColor(foreground);
        bar.ButtonInactiveBackgroundColor(background); bar.ButtonInactiveForegroundColor(foreground);
      } catch (...) { /* Older Windows versions may only support DWM colors. */ }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&palette));
    done(boolean(true), {}); return;
  }
  if (method==L"protect" || method==L"unprotect") { done(crypt(value,method==L"protect"),{}); return; }
  if (method==L"image.convert") { done(convertImage(value),{}); return; }
  if (method==L"pick" || method==L"saveDialog") {
    ComPtr<IFileDialog> dialog; auto save=method==L"saveDialog"; auto kind=field(value,L"kind");
    winrt::check_hresult(CoCreateInstance(save?CLSID_FileSaveDialog:CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&dialog)));
    FILEOPENDIALOGOPTIONS flags{}; dialog->GetOptions(&flags); flags|=FOS_FORCEFILESYSTEM|FOS_NOCHANGEDIR;
    if (kind==L"folder" || kind==L"home" || kind==L"project") flags|=FOS_PICKFOLDERS;
    if (!save && value.GetNamedBoolean(L"multiple",true)) flags|=FOS_ALLOWMULTISELECT;
    dialog->SetOptions(flags); if (save) dialog->SetFileName(field(value,L"name",L"download").c_str());
    if (kind==L"images") { COMDLG_FILTERSPEC filters[]={{L"图片",L"*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.tif;*.tiff"}}; dialog->SetFileTypes(1,filters); }
    auto result=dialog->Show(hwnd); if (result==HRESULT_FROM_WIN32(ERROR_CANCELLED)) { done(save?str(L""):JsonArray().as<IJsonValue>(),{}); return; } winrt::check_hresult(result);
    if (save) { ComPtr<IShellItem> item; dialog->GetResult(&item); PWSTR path{}; item->GetDisplayName(SIGDN_FILESYSPATH,&path); auto picked=str(path); CoTaskMemFree(path); done(picked,{}); }
    else { ComPtr<IFileOpenDialog> open; dialog.As(&open); ComPtr<IShellItemArray> items; open->GetResults(&items); DWORD count{}; items->GetCount(&count); JsonArray paths; for (DWORD i=0;i<count;i++){ComPtr<IShellItem> item; items->GetItemAt(i,&item); PWSTR path{}; item->GetDisplayName(SIGDN_FILESYSPATH,&path); paths.Append(str(path)); CoTaskMemFree(path);} done(paths,{}); }
    return;
  }
  if (method==L"clipboard.write") {
    auto content=field(value,L"value"); winrt::check_bool(OpenClipboard(hwnd)); EmptyClipboard(); auto memory=GlobalAlloc(GMEM_MOVEABLE,(content.size()+1)*sizeof(wchar_t));
    if (!memory) {CloseClipboard(); throw std::bad_alloc();} memcpy(GlobalLock(memory),content.c_str(),(content.size()+1)*sizeof(wchar_t)); GlobalUnlock(memory); if (!SetClipboardData(CF_UNICODETEXT,memory)) GlobalFree(memory); CloseClipboard(); done(boolean(true),{}); return;
  }
  if (method==L"confirm") { done(boolean(MessageBoxW(hwnd,field(value,L"message").c_str(),field(value,L"title",L"确认").c_str(),MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2)==IDYES),{}); return; }
  if (method==L"openUrl") {auto result=reinterpret_cast<INT_PTR>(ShellExecuteW(hwnd,L"open",field(value,L"url").c_str(),nullptr,nullptr,SW_SHOWNORMAL)); if(result<=32) throw std::runtime_error("open-failed"); done(boolean(true),{}); return;}
  if (method==L"loginItem") {
    if (!env(L"CODEXER_NATIVE_DATA_DIR").empty()) {done(boolean(true),{}); return;}
    HKEY key{}; winrt::check_win32(RegCreateKeyExW(HKEY_CURRENT_USER,L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",0,nullptr,0,KEY_SET_VALUE,nullptr,&key,nullptr));
    if(value.GetNamedBoolean(L"enabled",false)){auto command=L"\""+exe+L"\" --background"; RegSetValueExW(key,L"Codexer",0,REG_SZ,reinterpret_cast<BYTE const*>(command.c_str()),static_cast<DWORD>((command.size()+1)*sizeof(wchar_t)));} else RegDeleteValueW(key,L"Codexer"); RegCloseKey(key); done(boolean(true),{}); return;
  }
  if (method==L"preview.open") { openPreview(value,done); return; }
  if (method==L"preview.send" || method==L"preview.close") {
    auto found=previews.find(field(value,L"id")); if(found!=previews.end()) {
      if(method==L"preview.close") DestroyWindow(found->second->hwnd);
      else if(found->second->view) {auto script=L"window.codexerPreviewSend && window.codexerPreviewSend("+std::wstring(value.GetNamedValue(L"message").Stringify())+L");"; found->second->view->ExecuteScript(script.c_str(),nullptr);}
    } done(boolean(true),{}); return;
  }
  done(nullptr,"unknown-windows-operation");
}

inline LRESULT CALLBACK Host::previewProc(HWND target,UINT message,WPARAM wparam,LPARAM lparam) {
  auto preview=reinterpret_cast<PreviewWindow*>(GetWindowLongPtrW(target,GWLP_USERDATA));
  if(message==WM_NCCREATE){preview=static_cast<PreviewWindow*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams); SetWindowLongPtrW(target,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(preview));}
  if(preview && message==WM_SIZE && preview->controller){RECT bounds{}; GetClientRect(target,&bounds); preview->controller->put_Bounds(bounds);}
  if(preview && message==WM_DESTROY){auto id=preview->id; if(preview->controller) preview->controller->Close(); JsonObject event; event.Insert(L"id",str(id)); host->emit(L"previewClosed",event); host->previews.erase(id); return 0;}
  return DefWindowProcW(target,message,wparam,lparam);
}
inline void Host::openPreview(JsonObject const& value,Reply done) {
  auto id=field(value,L"id"); if(id.empty() || id.size()>100) throw std::runtime_error("invalid-preview");
  if(previews.contains(id)){SetForegroundWindow(previews.at(id)->hwnd); done(boolean(true),{}); return;}
  WNDCLASSW klass{}; klass.lpfnWndProc=previewProc; klass.hInstance=GetModuleHandleW(nullptr); klass.lpszClassName=L"CodexerContentPreview"; klass.hCursor=LoadCursorW(nullptr,IDC_ARROW); RegisterClassW(&klass);
  auto preview=std::make_shared<PreviewWindow>(); preview->id=id; previews[id]=preview;
  preview->hwnd=CreateWindowExW(WS_EX_DLGMODALFRAME,klass.lpszClassName,field(value,L"title",L"内容预览").c_str(),WS_OVERLAPPEDWINDOW|WS_VISIBLE,CW_USEDEFAULT,CW_USEDEFAULT,1050,780,hwnd,nullptr,klass.hInstance,preview.get());
  auto html=field(value,L"html"); auto profilePath=profile+L"\\native-content-preview";
  auto completed=std::make_shared<Reply>(std::move(done));
  auto hr=CreateCoreWebView2EnvironmentWithOptions(nullptr,profilePath.c_str(),nullptr,Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([this,preview,html,completed](HRESULT result,ICoreWebView2Environment* environment)->HRESULT {
    if(FAILED(result)||!environment){(*completed)(nullptr,"webview-runtime-unavailable"); if(IsWindow(preview->hwnd)) DestroyWindow(preview->hwnd); return S_OK;}
    return environment->CreateCoreWebView2Controller(preview->hwnd,Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([this,preview,html,completed](HRESULT result,ICoreWebView2Controller* controller)->HRESULT {
      if(FAILED(result)||!controller||!IsWindow(preview->hwnd)){(*completed)(nullptr,"preview-open-failed"); return S_OK;}
      preview->controller=controller; controller->get_CoreWebView2(&preview->view); RECT bounds{}; GetClientRect(preview->hwnd,&bounds); controller->put_Bounds(bounds);
      ComPtr<ICoreWebView2Settings> settings; preview->view->get_Settings(&settings); settings->put_AreDevToolsEnabled(FALSE); settings->put_AreHostObjectsAllowed(FALSE); settings->put_AreDefaultContextMenusEnabled(FALSE);
      EventRegistrationToken token{};
      preview->view->add_NewWindowRequested(Microsoft::WRL::Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*,ICoreWebView2NewWindowRequestedEventArgs* args)->HRESULT {args->put_Handled(TRUE); return S_OK;}).Get(),&token);
      preview->view->add_PermissionRequested(Microsoft::WRL::Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*,ICoreWebView2PermissionRequestedEventArgs* args)->HRESULT {args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY); return S_OK;}).Get(),&token);
      preview->view->add_NavigationStarting(Microsoft::WRL::Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs* args)->HRESULT {LPWSTR uri{}; args->get_Uri(&uri); if(uri && std::wstring(uri)!=L"about:blank") args->put_Cancel(TRUE); CoTaskMemFree(uri); return S_OK;}).Get(),&token);
      preview->view->add_WebMessageReceived(Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>([this,preview](ICoreWebView2*,ICoreWebView2WebMessageReceivedEventArgs* args)->HRESULT {
        LPWSTR content{}; if(SUCCEEDED(args->TryGetWebMessageAsString(&content)) && content){JsonObject event; event.Insert(L"id",str(preview->id)); event.Insert(L"data",str(content)); emit(L"previewMessage",event);} CoTaskMemFree(content); return S_OK;
      }).Get(),&token);
      // The content window has only string messages; it never receives the desktop RPC bridge.
      auto shell=L"<script>window.ReactNativeWebView={postMessage:m=>window.chrome.webview.postMessage(String(m))};</script>"+html;
      preview->view->NavigateToString(shell.c_str()); (*completed)(boolean(true),{}); return S_OK;
    }).Get());
  }).Get());
  if(FAILED(hr)){(*completed)(nullptr,"webview-runtime-unavailable"); DestroyWindow(preview->hwnd);}
}
} // namespace desktop

REACT_MODULE(RelayDesktop)
struct RelayDesktop {
  REACT_SYNC_METHOD(randomId)
  std::string randomId() noexcept { GUID guid{}; CoCreateGuid(&guid); WCHAR value[40]; StringFromGUID2(guid,value,40); return winrt::to_string(std::wstring_view(value+1,36)); }
  REACT_INIT(Initialize)
  void Initialize(winrt::Microsoft::ReactNative::ReactContext const& context) noexcept {desktop::host->context=context;}
  REACT_SYNC_METHOD(boot)
  std::string boot() noexcept {
    desktop::JsonObject value; value.Insert(L"mode",desktop::str(desktop::host->mode)); value.Insert(L"version",desktop::str(L"0.2.5")); value.Insert(L"closeExits",desktop::boolean(desktop::host->closeExits)); value.Insert(L"serverUrl",desktop::str(L"")); return winrt::to_string(value.Stringify());
  }
  REACT_METHOD(request)
  void request(std::string method,std::string payload,winrt::Microsoft::ReactNative::ReactPromise<std::string> promise) noexcept {
    desktop::host->request(method,payload,[promise](desktop::IJsonValue value,std::string error){if(!error.empty())promise.Reject(error.c_str());else promise.Resolve(winrt::to_string(value.Stringify()));});
  }
};
