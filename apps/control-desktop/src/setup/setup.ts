import type { ConnectionResult, ControlSetupApi } from "../types.js";

const form = document.querySelector<HTMLFormElement>("#connection")!;
const input = document.querySelector<HTMLInputElement>("#server")!;
const button = document.querySelector<HTMLButtonElement>("#connect")!;
const message = document.querySelector<HTMLParagraphElement>("#message")!;
const version = document.querySelector<HTMLElement>("#version")!;
const api: ControlSetupApi = window.controlSetup;
let busy = false;

function setMessage(text: string, error = false): void {
  message.textContent = text;
  message.classList.toggle("error", error);
  message.setAttribute("role", error ? "alert" : "status");
}

function setBusy(value: boolean): void {
  busy = value;
  input.disabled = value;
  button.disabled = value || !input.value.trim();
  button.textContent = value ? "正在连接…" : "连接服务器";
}

input.addEventListener("input", () => setBusy(busy));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  setMessage("正在连接服务器…");
  void api
    .connect(input.value.trim())
    .then((result: ConnectionResult) => {
      if (!result.ok) setMessage(result.error ?? "连接已取消，请重试。", true);
    })
    .catch(() => setMessage("无法连接服务器，请重试。", true))
    .finally(() => setBusy(false));
});

void api
  .state()
  .then((state) => {
    input.value = state.url;
    version.textContent = "Windows 控制端 · v" + state.version;
    if (state.error) setMessage(state.error, true);
    setBusy(false);
  })
  .catch(() => {
    setMessage("无法读取连接设置，请关闭并重新打开控制端。", true);
  });
