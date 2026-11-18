import { useEffect, useRef, useState } from "react";
import { ArrowUpFromLine, RefreshCw } from "lucide-react";
import * as api from "./api";
import { ClientReleases } from "./client-releases";
import { Modal } from "./modal";

const tabs = [
  { id: "installers", label: "安装包" },
  { id: "ota", label: "热更新" },
] as const;
const platformName = { android: "Android", ios: "iOS" };
const maxUploadBytes = 128 * 1024 * 1024;

export function ClientUpdates() {
  const [active, setActive] = useState<(typeof tabs)[number]["id"]>("installers");
  return (
    <>
      <div className="client-update-tabs" role="tablist" aria-label="客户端更新">
        {tabs.map(({ id, label }, index) => (
          <button
            key={id}
            id={`client-tab-${id}`}
            role="tab"
            aria-selected={active === id}
            aria-controls={`client-panel-${id}`}
            tabIndex={active === id ? 0 : -1}
            onClick={() => setActive(id)}
            onKeyDown={(event) => {
              const next = event.key === "Home" ? tabs[0]
                : event.key === "End" ? tabs[tabs.length - 1]
                : event.key === "ArrowLeft" || event.key === "ArrowRight" ? tabs[1 - index]
                : undefined;
              if (!next) return;
              event.preventDefault();
              setActive(next.id);
              document.getElementById(`client-tab-${next.id}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tabs.map(({ id }) => (
        <div key={id} id={`client-panel-${id}`} role="tabpanel" aria-labelledby={`client-tab-${id}`} hidden={active !== id}>
          {active === id && (id === "installers" ? <ClientReleases /> : <MobileOTAReleases />)}
        </div>
      ))}
    </>
  );
}

function MobileOTAReleases() {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.mobileOTAReleases>>>();
  const [action, setAction] = useState<"refresh" | "upload" | "unpublish">("refresh");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [removing, setRemoving] = useState<api.MobileOTARelease | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const task = useRef<AbortController | null>(null);

  const run = async (kind: typeof action, operation?: (signal: AbortSignal) => Promise<void>) => {
    if (task.current) return;
    const request = new AbortController();
    task.current = request;
    setAction(kind);
    setPending(true);
    setError("");
    setNotice("");
    try {
      if (operation) await operation(request.signal);
      const data = await api.mobileOTAReleases(request.signal);
      if (!request.signal.aborted) setCatalog(data);
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof api.ApiError ? err.message : "请求失败，请刷新列表确认当前状态。");
    } finally {
      if (!request.signal.aborted) {
        task.current = null;
        setPending(false);
      }
    }
  };

  useEffect(() => {
    void run("refresh");
    return () => {
      task.current?.abort();
      task.current = null;
    };
  }, []);

  const publish = (archive: File) => {
    if (!archive.name.toLowerCase().endsWith(".tar.gz") || archive.size === 0 || archive.size > maxUploadBytes) {
      setNotice("");
      setError("请选择不超过 128 MiB 的热更新 .tar.gz 文件。");
      return;
    }
    void run("upload", async (signal) => {
      const { release } = await api.publishMobileOTA(archive, signal);
      setFile(null);
      if (input.current) input.current.value = "";
      setNotice(`已发布 ${platformName[release.platform]} 热更新 ${release.label || release.id}。`);
    });
  };

  const unpublish = (release: api.MobileOTARelease) =>
    run("unpublish", async (signal) => {
      await api.unpublishMobileOTA(release, signal);
      setRemoving(null);
      setNotice(`已下架 ${platformName[release.platform]} 热更新 ${release.label || release.id}。`);
    });

  const rows = (catalog?.releases ?? []).slice().sort((a, b) =>
    a.platform.localeCompare(b.platform) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  return (
    <>
      <section className="card client-package-library" aria-label="生效的热更新">
        <div className="page-head">
          <div>
            <h2>生效的热更新</h2>
            {catalog && <p className="muted">Relay {catalog.relayVersion}</p>}
          </div>
          <button disabled={pending} onClick={() => void run("refresh")}>
            <RefreshCw size={16} />刷新列表
          </button>
        </div>
        {rows.length > 0 && (
          <div className="table-scroll">
            <table className="package-table ota-release-table">
              <thead><tr><th>平台</th><th>更新版本</th><th>签发时间</th><th className="align-right">操作</th></tr></thead>
              <tbody>
                {rows.map((release) => (
                  <tr key={`${release.platform}/${release.runtimeVersion}`}>
                    <td><strong>{platformName[release.platform]}</strong></td>
                    <td>
                      <strong>{release.label || release.id.slice(0, 8)}</strong>
                      <details>
                        <summary>更新详情</summary>
                        <div className="package-details">
                          <span>更新 ID <code>{release.id}</code></span>
                          <span>运行时指纹 <code>{release.runtimeVersion}</code></span>
                          {release.relayUrl && <span>签名清单地址 <code>{release.relayUrl}</code></span>}
                        </div>
                      </details>
                    </td>
                    <td><time dateTime={release.createdAt}>{new Date(release.createdAt).toLocaleString("zh-CN")}</time></td>
                    <td><div className="row-actions">
                      <button className="danger" disabled={pending} onClick={() => { setError(""); setRemoving(release); }}>下架</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {catalog && !rows.length && <p className="empty">当前 Relay 版本暂无热更新</p>}
        {pending && action === "refresh" && !catalog && <p className="empty" role="status">正在读取热更新</p>}
        {catalog && catalog.invalid > 0 && <p className="footnote">服务器上有 {catalog.invalid} 份无法读取的热更新清单。</p>}
      </section>

      <section className="card" aria-label="上传热更新">
        <h2>上传热更新</h2>
        <p className="muted">用发布脚本的 <code>--archive-dir</code> 参数导出已签名的更新包。回滚时，用脚本重新签发旧内容，再上传发布。</p>
        <form onSubmit={(event) => { event.preventDefault(); if (file) publish(file); }}>
          <label>热更新包
            <input
              ref={input}
              type="file"
              accept=".tar.gz,.gz,application/gzip"
              disabled={pending}
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); setNotice(""); }}
            />
          </label>
          <div className="actions">
            <button className="primary" type="submit" disabled={pending || !file}>
              <ArrowUpFromLine size={16} />
              {pending && action === "upload" ? "正在上传和校验" : "上传并发布"}
            </button>
          </div>
        </form>
        {notice && <p className="footnote" role="status">{notice}</p>}
        {error && !removing && <p className="error" role="alert">{error}</p>}
      </section>
      {removing && (
        <Modal title="下架热更新" close={() => { if (!pending) { setRemoving(null); setError(""); } }}>
          <p>下架 {platformName[removing.platform]} 的「{removing.label || removing.id}」后，服务器将停止提供该更新。已安装该更新的设备可能继续运行该版本。</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button disabled={pending} onClick={() => { setRemoving(null); setError(""); }}>取消</button>
            <button className="danger" disabled={pending} onClick={() => void unpublish(removing)}>确认下架</button>
          </div>
        </Modal>
      )}
    </>
  );
}
