import { useEffect, useRef, useState } from "react";
import {
  CLIENT_TARGETS,
  MAX_CLIENT_RELEASE_BYTES,
} from "../../../packages/shared/src/client-release";
import type { ClientRelease, ClientTarget } from "../../../packages/shared/src/client-release";
import * as api from "./api";
import { Modal } from "./modal";
import { RefreshCw, Trash2 } from "lucide-react";

const formatSize = (bytes: number) =>
  `${(bytes / 1024 / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MiB`;

export function ClientReleases() {
  const [releases, setReleases] = useState<Record<string, ClientRelease>>({}),
    [packages, setPackages] = useState<ClientRelease[]>([]),
    [filter, setFilter] = useState("all"),
    [status, setStatus] = useState("all"),
    [deleting, setDeleting] = useState<ClientRelease | null>(null),
    [deleteError, setDeleteError] = useState(""),
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
      if (live.current) {
        setReleases(value.releases);
        setPackages(value.packages);
      }
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
  const isCurrent = (value: ClientRelease) => releases[value.target]?.id === value.id;
  const visiblePackages = packages.filter(
    (value) =>
      (filter === "all" || value.target === filter) &&
      (status === "all" || isCurrent(value) === (status === "current")),
  );
  const remove = async () => {
    if (!deleting || task.current) return;
    const value = deleting;
    task.current = new AbortController();
    setBusy(true);
    setDeleteError("");
    try {
      await api.deleteClientRelease(value);
      if (!live.current) return;
      setPackages((current) => current.filter((item) => item.id !== value.id));
      setReleases((current) => {
        const next = { ...current };
        if (next[value.target]?.id === value.id) delete next[value.target];
        return next;
      });
      setDeleting(null);
      setMessage(`已删除 ${value.name}，释放 ${formatSize(value.size)}。`);
      await refresh();
    } catch (error) {
      if (live.current) setDeleteError(error instanceof Error ? error.message : "删除失败，请重试");
    } finally {
      task.current = null;
      if (live.current) setBusy(false);
    }
  };
  return (
    <>
      <section className="card client-package-library" aria-label="客户端安装包管理">
        <div className="page-head">
          <div>
            <h2>安装包管理</h2>
            <p className="muted">查看当前发布与历史版本，删除不再需要的安装包以释放服务器空间。</p>
          </div>
          <button
            disabled={busy || loading}
            onClick={() => {
              setMessage("");
              void refresh();
            }}
          >
            <RefreshCw size={16} />
            刷新列表
          </button>
        </div>
        <div className="package-toolbar">
          <p className="muted">
            共 {packages.length} 个安装包 ·{" "}
            {formatSize(packages.reduce((sum, value) => sum + value.size, 0))}
          </p>
          <div className="package-filters">
            <label>
              平台
              <select
                aria-label="筛选客户端平台"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">全部平台</option>
                {Object.entries(CLIENT_TARGETS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              状态
              <select
                aria-label="筛选安装包状态"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="all">全部版本</option>
                <option value="current">当前发布</option>
                <option value="history">历史版本</option>
              </select>
            </label>
          </div>
        </div>
        <div className="table-scroll">
          <table className="package-table">
            <thead>
              <tr>
                <th>客户端 / 安装包</th>
                <th>版本</th>
                <th>大小 / 上传时间</th>
                <th>状态</th>
                <th className="align-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {visiblePackages.map((value) => (
                <tr key={value.id}>
                  <td>
                    <strong>{CLIENT_TARGETS[value.target]}</strong>
                    <span className="package-filename muted">{value.name}</span>
                    <details>
                      <summary>安装包详情</summary>
                      <div className="package-details">
                        <span>SHA-256</span>
                        <code>{value.sha256}</code>
                        {value.notes && <p>{value.notes}</p>}
                      </div>
                    </details>
                  </td>
                  <td>
                    <strong>{value.version}</strong>
                    {value.buildNumber > 0 && (
                      <small className="package-filename muted">构建 {value.buildNumber}</small>
                    )}
                  </td>
                  <td>
                    {formatSize(value.size)}
                    <small className="package-filename muted">
                      {new Date(value.uploadedAt).toLocaleString("zh-CN")}
                    </small>
                  </td>
                  <td>
                    <span className={`badge ${isCurrent(value) ? "" : "disabled"}`}>
                      {isCurrent(value) ? "当前发布" : "历史版本"}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="danger"
                        aria-label={`删除 ${value.name} ${value.version}`}
                        disabled={busy || loading}
                        onClick={() => {
                          setDeleting(value);
                          setDeleteError("");
                        }}
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visiblePackages.length && (
          <p className="empty">
            {loading
              ? "正在读取安装包…"
              : packages.length
                ? "没有符合筛选条件的安装包"
                : "尚未上传客户端安装包"}
          </p>
        )}
        {!!message && <p role="status">{message}</p>}
        <p className="footnote">
          新上传会将上一版保留为历史版本；历史版本不再向客户端提供更新。此前已自动清理的文件无法恢复。
        </p>
      </section>
      <section className="card agent-installer">
        <h2>上传并发布客户端</h2>
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
                  setPackages((current) => [value, ...current]);
                  setMessage("已发布。对应客户端将在下次检查时收到更新提示。");
                  setFile(null);
                  if (input.current) input.current.value = "";
                  return refresh();
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
        <p className="footnote">
          填写安装包实际版本；Android 沿用原应用 ID 和签名，并填写实际 versionCode。旧“PC Agent
          安装包”入口继续用于手动下载。
        </p>
      </section>
      {deleting && (
        <Modal
          title={isCurrent(deleting) ? "删除当前发布版本？" : "删除历史安装包？"}
          close={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <p className="package-delete-name">
            {CLIENT_TARGETS[deleting.target]} · {deleting.version}
            <br />
            {deleting.name}
          </p>
          <p>将永久删除服务器上的安装包，释放 {formatSize(deleting.size)}，此操作无法撤销。</p>
          {isCurrent(deleting) ? (
            <p className="update-warning">
              此版本正在发布。删除后，该平台将不再提供更新或下载，不会自动回退到历史版本。已安装的客户端可继续使用。
            </p>
          ) : (
            <p className="muted">当前发布版本和已安装的客户端可继续使用。</p>
          )}
          {deleteError && (
            <p role="alert" className="error">
              {deleteError}
            </p>
          )}
          <div className="actions">
            <button disabled={busy} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button className="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? "正在删除…" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
