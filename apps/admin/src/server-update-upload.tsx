import { useEffect, useRef, useState } from "react";
import type { UpdateJob, VersionInfo } from "./api";
import { uploadServerUpdate } from "./api";
import { newerVersion } from "../../../packages/shared/src/server-update";

export function ServerUpdateUpload({
  version,
  busy,
  setBusy,
  onPrepared,
  onUnauthorized,
}: {
  version: VersionInfo | null;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onPrepared: (job: UpdateJob) => void;
  onUnauthorized: () => void;
}) {
  const [archive, setArchive] = useState<File | null>(null),
    [checksum, setChecksum] = useState<File | null>(null),
    [error, setError] = useState(""),
    [progress, setProgress] = useState<number | null>(null);
  const task = useRef<AbortController | null>(null),
    input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => task.current?.abort(), []);
  const select = (files: File[]) => {
    if (busy || task.current) return;
    if (!files.length) return;
    const archives = files.filter((f) => f.name.endsWith(".tar.gz")),
      checksums = files.filter((f) => f.name.endsWith(".tar.gz.sha256"));
    if (
      archives.length > 1 ||
      checksums.length > 1 ||
      archives.length + checksums.length !== files.length
    ) {
      setError("请选择一个服务器 .tar.gz 更新包及其 .sha256 校验文件。");
      return;
    }
    if (archives[0]) {
      setArchive(archives[0]);
      setChecksum(checksums[0] ?? null);
    } else if (checksums[0]) setChecksum(checksums[0]);
    setError("");
    if (input.current) input.current.value = "";
  };
  const match = archive?.name.match(
    /^codexer-server-(\d+\.\d+\.\d+)-(linux|darwin)-(amd64|arm64)\.tar\.gz$/,
  );
  const submit = async () => {
    if (busy || task.current || !archive || !checksum || !version?.uploadSupported) return;
    setError("");
    if (!match || `${match[2]}-${match[3]}` !== version.platform) {
      setError(`请选择适合 ${version.platform} 的服务器更新包。`);
      return;
    }
    if (!newerVersion(match[1]!, version.currentVersion)) {
      setError("只能上传高于当前服务器版本的更新包。");
      return;
    }
    if (archive.size < 128 || archive.size > 256 * 1024 * 1024) {
      setError("更新包须为 128 字节至 256 MiB。");
      return;
    }
    if (checksum.name !== archive.name + ".sha256" || checksum.size > 4096) {
      setError("请选择与更新包同名的 .sha256 校验文件。");
      return;
    }
    const controller = new AbortController();
    task.current = controller;
    setBusy(true);
    setProgress(0);
    try {
      const text = (await checksum.text()).trim(),
        parts = text.split(/\s+/);
      if (
        parts.length !== 2 ||
        !/^[a-f0-9]{64}$/i.test(parts[0]!) ||
        parts[1]!.replace(/^\*/, "") !== archive.name
      )
        throw Error("校验文件内容与更新包不匹配。");
      if (controller.signal.aborted) return;
      const job = await uploadServerUpdate(
        archive,
        parts[0]!.toLowerCase(),
        controller.signal,
        setProgress,
      );
      setArchive(null);
      setChecksum(null);
      onPrepared(job);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "上传失败，请重试");
        if (e instanceof Error && e.message === "登录已失效，请重新登录") onUnauthorized();
      }
    } finally {
      task.current = null;
      setProgress(null);
      setBusy(false);
    }
  };
  return (
    <div className="server-upload">
      <h3>手动上传服务器更新包</h3>
      <p className="muted">
        适合服务器无法访问 GitHub
        时使用。上传后先校验并准备，准备完成后需确认重启；现有配置与数据保留。
      </p>
      {version?.uploadSupported ? (
        <>
          <p className="footnote">
            当前平台：{version.platform}；最大 256 MiB。请选择发布的服务器包及对应 .sha256 文件。
          </p>
          <label
            className="installer-dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              select([...e.dataTransfer.files]);
            }}
          >
            服务器更新包与校验文件
            <input
              ref={input}
              aria-label="服务器更新包与校验文件"
              type="file"
              accept=".tar.gz,.sha256"
              multiple
              disabled={busy}
              onChange={(e) => select([...(e.target.files ?? [])])}
            />
            <span className="footnote">可一次拖入两个文件，版本与平台自动识别，无需手动输入。</span>
          </label>
          {archive && (
            <p className="package-filename">
              更新包：{archive.name}
              {match && (
                <span>
                  {" "}
                  · v{match[1]} · {match[2]}-{match[3]}
                </span>
              )}
            </p>
          )}
          {checksum && <p className="package-filename">校验文件：{checksum.name}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !archive || !checksum}
              onClick={() => void submit()}
            >
              {progress === null
                ? "上传并准备更新"
                : progress < 1
                  ? `上传中 ${Math.floor(progress * 100)}%`
                  : "上传完成，正在校验…"}
            </button>
            {progress !== null && (
              <button type="button" onClick={() => task.current?.abort()}>
                取消上传
              </button>
            )}
          </div>
          {progress !== null && <progress aria-label="服务器包上传进度" max={1} value={progress} />}
        </>
      ) : (
        <p className="update-warning">
          {version?.supported
            ? "当前更新器尚不支持手动上传。请用 0.3.39 或更新版本的本地服务器包，在服务器运行一次包内的 sudo bash install.sh 升级更新器；之后可在此上传更新。"
            : "此部署未启用手动安装更新；请通过 systemd 安装器升级，Docker 或源码部署请在外部更新。"}
        </p>
      )}
    </div>
  );
}
