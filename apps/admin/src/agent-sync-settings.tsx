import { useEffect, useRef, useState } from "react";
import { Monitor, RefreshCw } from "lucide-react";
import {
  DEFAULT_SYNC_THREADS,
  MAX_SYNC_THREADS,
} from "../../../packages/shared/src/agent-settings";
import * as api from "./api";

export function AgentSyncSettings() {
  const [draft, setDraft] = useState(String(DEFAULT_SYNC_THREADS));
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const live = useRef(true),
    pending = useRef<AbortController | null>(null);
  const load = async () => {
    if (pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError("");
    try {
      const value = await api.agentSettings(abort.signal);
      if (live.current) {
        setDraft(String(value.threadLimit));
        setLoaded(true);
      }
    } catch (error) {
      if (live.current) setError(error instanceof Error ? error.message : "读取失败，请重试");
    } finally {
      pending.current = null;
      if (live.current) setBusy(false);
    }
  };
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
      pending.current?.abort();
    };
  }, []);
  return (
    <form
      className="card login-settings"
      aria-label="实时同步会话设置"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!loaded || pending.current) return;
        const threadLimit = Number(draft);
        if (
          !/^\d+$/.test(draft) ||
          !Number.isInteger(threadLimit) ||
          threadLimit < 1 ||
          threadLimit > MAX_SYNC_THREADS
        ) {
          setError(`请填写 1 至 ${MAX_SYNC_THREADS} 的整数。`);
          setMessage("");
          return;
        }
        const abort = new AbortController();
        pending.current = abort;
        setBusy(true);
        setError("");
        setMessage("");
        void api
          .saveAgentSettings({ threadLimit }, abort.signal)
          .then((value) => {
            if (live.current) {
              setDraft(String(value.threadLimit));
              setMessage(
                "已保存并通知在线连接器；离线连接器下次连接时获取。需要 Agent 0.2.20 或更高版本。",
              );
            }
          })
          .catch((error) => {
            if (live.current) setError(error instanceof Error ? error.message : "保存失败，请重试");
          })
          .finally(() => {
            pending.current = null;
            if (live.current) setBusy(false);
          });
      }}
    >
      <h2>
        <Monitor size={20} />
        实时同步会话上限
      </h2>
      <p className="muted">
        设置每台 PC
        连接器同时跟踪的会话预览数量。完整会话目录和历史仍可查看；提高上限会增加内存与同步流量。
      </p>
      <div className="timeout-fields">
        <label>
          每台连接器的会话数
          <input
            aria-label="实时同步会话上限"
            type="number"
            min={1}
            max={MAX_SYNC_THREADS}
            step={1}
            value={draft}
            disabled={!loaded || busy}
            onChange={(event) => {
              setDraft(event.target.value);
              setMessage("");
            }}
          />
        </label>
        <button className="primary" disabled={!loaded || busy}>
          {busy ? "正在处理…" : "保存会话上限"}
        </button>
        <button type="button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={16} />
          重新读取
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <p className="footnote">
        默认 {DEFAULT_SYNC_THREADS}，范围 1–{MAX_SYNC_THREADS}
        。降低上限优先移出安全的空闲预览；正在执行、等待回复或有待发内容的会话等到空闲后再收缩。不会删除历史或中断任务。旧版控制端继续接收最多
        20 个预览。
      </p>
    </form>
  );
}
