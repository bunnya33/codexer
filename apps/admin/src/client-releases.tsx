import { useEffect, useRef, useState } from "react";
import {
  CLIENT_TARGETS,
  MAX_CLIENT_RELEASE_BYTES,
} from "../../../packages/shared/src/client-release";
import type { ClientRelease, ClientTarget } from "../../../packages/shared/src/client-release";
import * as api from "./api";

export function ClientReleases() {
  const [releases, setReleases] = useState<Record<string, ClientRelease>>({}),
    [target, setTarget] = useState<ClientTarget>("agent-windows-x64-setup");
  const [version, setVersion] = useState(""),
    [build, setBuild] = useState(""),
    [notes, setNotes] = useState(""),
    [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [progress, setProgress] = useState(0),
    [message, setMessage] = useState("");
  const task = useRef<AbortController | null>(null),
    live = useRef(true),
    input = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    setLoading(true);
    try {
      const value = await api.clientReleases();
      if (live.current) setReleases(value);
    } catch {
      if (live.current) setMessage("客户端版本读取失败，请重试");
    } finally {
      if (live.current) setLoading(false);
    }
  };
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
      task.current?.abort();
    };
  }, []);
  const release = releases[target],
    extension = target.includes("windows")
      ? ".exe"
      : target === "control-android"
        ? ".apk"
        : ".dmg";
  return (
    <section className="card agent-installer">
      <h2>客户端更新与红点提示</h2>
      <p className="muted">
        按产品和平台发布。客户端从所连接的 Relay 检查更新；桌面托盘、Android
        设置按钮显示红点，升级后清除。
      </p>
      <label>
        发布目标
        <select
          aria-label="客户端发布目标"
          value={target}
          disabled={busy}
          onChange={(e) => {
            setTarget(e.target.value as ClientTarget);
            setVersion("");
            setBuild("");
            setNotes("");
            setFile(null);
            setMessage("");
            if (input.current) input.current.value = "";
          }}
        >
          {Object.entries(CLIENT_TARGETS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p>
        {loading
          ? "正在读取…"
          : release
            ? `已发布 ${release.version}${release.buildNumber ? `（构建 ${release.buildNumber}）` : ""} · ${release.name}`
            : "尚未发布此客户端"}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (task.current || !file) return;
          if (!/^\d+\.\d+\.\d+$/.test(version)) {
            setMessage("版本格式须为 0.2.12");
            return;
          }
          if (
            !file.name.toLowerCase().endsWith(extension) ||
            file.size < 128 ||
            file.size > MAX_CLIENT_RELEASE_BYTES
          ) {
            setMessage(`请选择不超过 512 MiB 的 ${extension} 安装包`);
            return;
          }
          if (
            target === "control-android" &&
            (!/^\d+$/.test(build) || Number(build) < 1 || Number(build) > 2147483647)
          ) {
            setMessage("请填写 APK 实际的 versionCode");
            return;
          }
          const abort = new AbortController();
          task.current = abort;
          setBusy(true);
          setMessage("");
          setProgress(0);
          void api
            .uploadClientRelease(
              target,
              file,
              version,
              target === "control-android" ? Number(build) : 0,
              notes,
              abort.signal,
              (value) => {
                if (live.current) setProgress(value);
              },
            )
            .then((value) => {
              if (live.current) {
                setReleases((current) => ({ ...current, [target]: value }));
                setMessage("已发布。对应客户端将在下次检查时收到更新提示。");
                setFile(null);
                if (input.current) input.current.value = "";
              }
            })
            .catch((error) => {
              if (live.current) setMessage(abort.signal.aborted ? "上传已取消" : error.message);
            })
            .finally(() => {
              task.current = null;
              if (live.current) setBusy(false);
            });
        }}
      >
        <div className="installer-fields">
          <label>
            客户端版本
            <input
              aria-label="客户端版本"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              maxLength={80}
              required
              disabled={busy}
            />
          </label>
          {target === "control-android" && (
            <label>
              Android versionCode
              <input
                aria-label="Android versionCode"
                type="number"
                min="1"
                max="2147483647"
                required
                value={build}
                onChange={(e) => setBuild(e.target.value)}
                disabled={busy}
              />
            </label>
          )}
          <label>
            安装包
            <input
              aria-label="客户端安装包"
              ref={input}
              type="file"
              accept={extension}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
              required
            />
          </label>
        </div>
        <label>
          更新说明
          <textarea
            aria-label="客户端更新说明"
            value={notes}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy || loading || !file}>
            {busy ? `上传中 ${Math.floor(progress * 100)}%` : "上传并发布客户端"}
          </button>
          {busy ? (
            <button type="button" onClick={() => task.current?.abort()}>
              取消上传
            </button>
          ) : (
            <button type="button" onClick={() => void refresh()}>
              刷新
            </button>
          )}
        </div>
        {busy && <progress max={1} value={progress} />}
      </form>
      {!!message && <p role="status">{message}</p>}
      <p className="footnote">
        填写安装包实际版本；Android 沿用原应用 ID 和签名，并填写实际 versionCode。旧“PC Agent
        安装包”入口继续用于手动下载。
      </p>
    </section>
  );
}
