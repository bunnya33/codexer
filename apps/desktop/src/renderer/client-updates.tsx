import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../client-updates";
export function AgentUpdates() {
  const [state, setState] = useState<DesktopUpdateState | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void window.codexer.updates.state().then((value) => {
      if (live) setState(value);
    });
    const off = window.codexer.updates.subscribe(setState);
    return () => {
      live = false;
      off();
    };
  }, []);
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action().catch((value) =>
      setError(value instanceof Error ? value.message : "更新失败，请重试"),
    );
  };
  return (
    <section>
      <div className="section-title">
        <h2>
          {state?.available && (
            <span
              aria-label="Agent 有新版本"
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#eb373a",
                marginRight: 8,
              }}
            />
          )}
          Agent 更新
        </h2>
        <button
          disabled={state?.checking || state?.downloading}
          onClick={() => run(() => window.codexer.updates.check())}
        >
          检查更新
        </button>
      </div>
      <p>
        当前版本 {state?.version || "—"}
        {state?.available
          ? ` · 新版本 ${state.release?.version}`
          : state?.error
            ? " · 检查暂不可用"
            : state?.checkedAt
              ? " · 已是最新版本"
              : " · 登录后从当前 Relay 检查更新"}
      </p>
      {!!state?.release?.notes && <p style={{ whiteSpace: "pre-wrap" }}>{state.release.notes}</p>}
      {state?.available && (
        <div className="buttons">
          {state.downloaded ? (
            <button className="primary" onClick={() => run(() => window.codexer.updates.open())}>
              {state.release?.target === "agent-windows-x64-portable"
                ? "打开更新文件位置"
                : "打开安装包"}
            </button>
          ) : (
            <button
              className="primary"
              disabled={state.downloading}
              onClick={() => run(() => window.codexer.updates.download())}
            >
              {state.downloading ? `下载中 ${Math.floor(state.progress * 100)}%` : "下载更新"}
            </button>
          )}
          {state.downloading && (
            <button onClick={() => run(() => window.codexer.updates.cancel())}>取消下载</button>
          )}
        </div>
      )}
      {!!(error || state?.error) && <p role="alert">{error || state?.error}</p>}
      <p className="footnote">
        下载不影响当前任务。安装前请等待本机任务完成，登录和设备配置保留。
        {state?.release?.target === "agent-windows-x64-portable" && "便携版请退出后替换原 EXE。"}
      </p>
    </section>
  );
}
