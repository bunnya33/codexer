/** 把消息中的本地链接转换为 PC 路径；不会交给浏览器或系统直接打开。 */
export function localFilePath(value: string): string | null {
  let path = value.trim();
  if (path.length > 4096) return null;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = url.pathname;
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path
    .replaceAll("\\", "/")
    .replace(/#(?:L?\d+(?:-L?\d+)?)$/, "")
    .replace(/:\d+(?::\d+)?$/, "");
  // Codex 的 Windows 文档链接也会使用 /D:/...，转换为真实盘符路径。
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  if (/[\u0000-\u001f\u007f]/.test(path) || path.startsWith("//")) return null;
  if (!/^[A-Za-z]:\//.test(path) && !path.startsWith("/")) return null;
  return path;
}

export function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) || "文件";
}

/** 按文件名选择图片阅读器；实际解码失败时由预览器提示，不自动执行文件。 */
export function fileImageMime(name: string): string | null {
  if (!name.includes(".")) return null;
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg",
    webp: "image/webp", gif: "image/gif", bmp: "image/bmp", ico: "image/x-icon",
    avif: "image/avif", svg: "image/svg+xml",
  };
  return Object.hasOwn(types, extension) ? types[extension]! : null;
}

export function fileReaderKind(name: string): "image" | "markdown" | "json" | "text" | "download" {
  const extension = name.toLowerCase().split(".").at(-1);
  if (fileImageMime(name)) return "image";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "json") return "json";
  if (
    extension &&
    [
      "txt",
      "log",
      "csv",
      "tsv",
      "yaml",
      "yml",
      "toml",
      "ini",
      "xml",
      "conf",
      "css",
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "go",
      "rs",
      "sql",
      "sh",
      "ps1",
    ].includes(extension)
  )
    return "text";
  return "download";
}

export function readableFileText(bytes: Uint8Array, name: string): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\u0000")) throw new Error("这个文件不是可阅读的文本，请下载后查看");
  if (fileReaderKind(name) === "json") {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 原样显示无效 JSON，便于检查。 */
    }
  }
  return text;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
