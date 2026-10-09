const addressError = "请输入 HTTP 或 HTTPS 服务器根地址，例如 http://192.0.2.10:8899";

/** 控制端与服务器页面同源运行，地址只允许根路径且不能携带登录凭据。 */
export function normalizeServerUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(addressError);
  }
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(addressError);
    return url.origin;
  } catch {
    throw new Error(addressError);
  }
}

export function sameServerOrigin(value: string, server: string | null): boolean {
  if (!server) return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin === server
    );
  } catch {
    return false;
  }
}

/** 仅允许常规网页交给系统浏览器；本地路径及可执行协议始终留在沙箱之外。 */
export function externalWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** 本地地址选择窗口的主 frame 才能调用配置 IPC，服务器页面没有 preload。 */
export function trustedSetupRequest(
  event: { sender: unknown; senderFrame: { url: string } | null },
  expected: { sender: unknown; frame: unknown; url: string },
): boolean {
  return (
    event.sender === expected.sender &&
    !!event.senderFrame &&
    event.senderFrame === expected.frame &&
    event.senderFrame.url === expected.url
  );
}
