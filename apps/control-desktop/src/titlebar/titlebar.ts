import type { WindowState } from "../types.js";

const header = document.querySelector<HTMLElement>("#titlebar")!;
const detail = document.body.dataset.windowLabel ?? "会话控制端";
header.innerHTML = `
  <div class="window-title"><img src="../icon.png" alt="" width="20" height="20"><strong>RelayDesk</strong><span class="window-detail"></span></div>
  <div class="window-controls" aria-label="窗口操作">
    <button type="button" id="window-menu" aria-label="控制端菜单" title="控制端菜单"><svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h10"/></svg></button>
    <button type="button" id="window-minimize" aria-label="最小化" title="最小化"><svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg></button>
    <button type="button" id="window-maximize" aria-label="最大化" title="最大化"><svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10"/></svg></button>
    <button type="button" id="window-close" class="window-close" aria-label="关闭窗口" title="关闭窗口"><svg viewBox="0 0 16 16"><path d="m3 3 10 10M13 3 3 13"/></svg></button>
  </div>`;
header.querySelector(".window-detail")!.textContent = "· " + detail;
const maximize = header.querySelector<HTMLButtonElement>("#window-maximize")!;
const api = window.relayDesk;

function render(state: WindowState): void {
  header.classList.toggle("maximized", state.maximized);
  header.classList.toggle("inactive", !state.focused);
  const label = state.maximized ? "还原窗口" : "最大化";
  maximize.setAttribute("aria-label", label);
  maximize.title = label;
  maximize.innerHTML = state.maximized
    ? '<svg viewBox="0 0 16 16"><path d="M5 3V2h9v9h-1"/><rect x="2" y="5" width="9" height="9"/></svg>'
    : '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10"/></svg>';
}

for (const [id, action] of [
  ["window-menu", () => api.menu()],
  ["window-minimize", () => api.minimize()],
  ["window-maximize", () => api.toggleMaximize()],
  ["window-close", () => api.close()],
] as const) {
  header
    .querySelector<HTMLButtonElement>("#" + id)!
    .addEventListener("click", () => void action().catch(() => undefined));
}
const unsubscribe = api.subscribe(render);
window.addEventListener("pagehide", unsubscribe, { once: true });
void api
  .state()
  .then(render)
  .catch(() => undefined);
