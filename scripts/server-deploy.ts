import { readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import {
  DeployError,
  deployServer,
  inspectDeployArchive,
} from "../packages/shared/src/server-deploy.js";
import type { DeployReceipt } from "../packages/shared/src/server-deploy.js";
import {
  beginPublishingLogin,
  waitPublishingLogin,
  savePublishingCredential,
  loadPublishingClient,
  lockPublishingProfile,
  importPublishingCode,
} from "../packages/shared/src/publisher-auth.js";
import {
  defaultPublishingScopes,
  diagnosticsReadScope,
  publishingScopeNames,
} from "../packages/shared/src/publishing.js";
import { readPublishingCode } from "../packages/shared/src/publisher-input.js";
import { publishMobileOTAPackage } from "../packages/shared/src/mobile-ota-publish.js";
import {
  inspectClientPackage,
  publishClientPackage,
} from "../packages/shared/src/client-publish.js";

const help = `Codexer 发布工具（服务器生成授权码）
  npm run server:deploy -- login --url http://server.example.com
  npm run server:deploy -- login --web --url <服务器地址> [--name <电脑名称>] [--scopes server:read,server:write,clients:read,clients:write]
  npm run server:deploy -- status
  npm run server:deploy -- deploy --archive <服务器包.tar.gz> [--checksum <文件.sha256>] [--apply]
  npm run server:deploy -- publish-client --target <目标> --archive <安装包> [--version X.Y.Z] [--build-number N] [--notes-file <说明.txt>] [--checksum <文件.sha256>] [--apply]
  npm run server:deploy -- publish-ota --archive <热更新包.tar.gz> [--checksum <文件.sha256>] [--apply]
  npm run server:deploy -- clients
  npm run server:deploy -- logs [--limit <1-200>] [--before <日志编号>] [--level info|warn|error]
    [--category <分类>] [--code <错误码>] [--device-id <设备 ID>] [--connection-id <连接 ID>]
    [--since <带时区的 ISO 时间>] [--until <带时区的 ISO 时间>]
  npm run server:deploy -- logout

通用选项：--profile <名称>（默认 default） --timeout <秒>（默认 900）
deploy / publish-client / publish-ota 默认只预检，--apply 才执行。
login 粘贴后台“发布授权”生成的授权码，输入隐藏；也支持通过标准输入传入。支持 HTTP 和 HTTPS。
--web 保留旧版网页审批方式。工具不接收管理员密码。
客户端发布不自动安装到设备。Windows Agent 安装版同时同步兼容更新通道。
Android 自动验证正式签名、applicationId、versionName 和 versionCode（需要 Android SDK/JDK）。
`;
const output = (value: unknown) => console.log(JSON.stringify(value));
const errorMessages: Record<string, string> = {
  "diagnostics-scope-required": "当前授权缺少查看脱敏诊断日志的权限，请导入包含 diagnostics:read 的授权码。",
  "server-upgrade-required-for-diagnostics": "当前 Relay 版本不支持授权读取诊断日志，请升级服务器。",
  "invalid-log-filter": "日志筛选条件无效，请检查时间范围、日志编号、条数或筛选值。",
  "invalid-log-time": "请输入带时区的 ISO 时间，例如 2026-11-25T08:00:00+08:00。",
  "server-unreachable": "连接服务器失败，请检查服务器地址和网络。",
  "login-expired": "登录已失效，请重新导入授权码。",
};

function logTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isSafeInteger(timestamp) || timestamp <= 0)
    throw new DeployError("invalid-log-time");
  return String(timestamp);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      url: { type: "string" },
      profile: { type: "string", default: "default" },
      name: { type: "string" },
      scopes: { type: "string" },
      web: { type: "boolean" },
      archive: { type: "string" },
      checksum: { type: "string" },
      apply: { type: "boolean" },
      timeout: { type: "string", default: "900" },
      target: { type: "string" },
      version: { type: "string" },
      "build-number": { type: "string" },
      "notes-file": { type: "string" },
      limit: { type: "string" },
      before: { type: "string" },
      level: { type: "string" },
      category: { type: "string" },
      code: { type: "string" },
      "device-id": { type: "string" },
      "connection-id": { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (
    positionals.length !== 1 ||
    !["login", "status", "deploy", "publish-client", "publish-ota", "clients", "logs", "logout"].includes(command)
  )
    throw new DeployError("invalid-command");
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(values.profile!)) throw new DeployError("invalid-profile");
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3600)
    throw new DeployError("invalid-timeout");
  const base =
    process.env.CODEXER_DEPLOY_HOME ??
    (process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "Codexer",
          "server-deploy",
        )
      : join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
          "codexer",
          "server-deploy",
        ));
  const secretPath = resolve(base, values.profile! + ".secret"),
    receiptPath = resolve(base, values.profile! + ".job.json");
  const unlock = await lockPublishingProfile(secretPath);
  try {
    if (command === "login") {
      if (!values.url) throw new DeployError("server-url-required");
      if (process.platform !== "win32")
        throw new DeployError("publishing-encrypted-store-requires-windows");
      if (!values.web) {
        if (values.name || values.scopes)
          throw new DeployError("publishing-code-scopes-set-in-admin");
        const credential = await importPublishingCode(values.url, await readPublishingCode());
        await savePublishingCredential(secretPath, credential);
        output({
          event: "authorization-saved",
          profile: values.profile,
          url: credential.url,
          username: credential.username,
          grantId: credential.grantId,
          scopes: credential.scopes,
          grantExpiresAt: credential.grantExpiresAt,
        });
        return;
      }
      const scopes = values.scopes ? values.scopes.split(",") : defaultPublishingScopes;
      if (scopes.some((scope) => !Object.hasOwn(publishingScopeNames, scope)))
        throw new DeployError("invalid-publishing-scopes");
      const login = await beginPublishingLogin(values.url, values.name ?? hostname(), scopes);
      output({
        event: "authorization-required",
        url: login.verificationUri,
        userCode: login.userCode,
        computer: values.name ?? hostname(),
        scopes,
        expiresInSeconds: login.expiresIn,
      });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const credential = await waitPublishingLogin(login, { signal: controller.signal });
        await savePublishingCredential(secretPath, credential);
        output({
          event: "authorization-saved",
          profile: values.profile,
          url: credential.url,
          username: credential.username,
          grantId: credential.grantId,
          scopes: credential.scopes,
          grantExpiresAt: credential.grantExpiresAt,
        });
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
      return;
    }
    const { client, identity } = await loadPublishingClient(secretPath, values.url);
    if (command === "logout") {
      try {
        await client.json("/v1/publish/revoke", {});
      } catch (e) {
        if (
          !(e instanceof DeployError) ||
          (e.status !== 401 &&
            ![
              "invalid-publishing-credential",
              "refresh-reused-reauthorize",
              "publishing-authorization-expired-run-login",
            ].includes(e.code))
        )
          throw e;
      }
      await rm(secretPath, { force: true });
      output({ result: "logged-out", url: client.url });
      return;
    }
    await client.assertAdmin();
    if (command === "status") {
      const me = identity();
      if (!me.scopes.includes("server:read")) {
        output({ ...me, authorized: true });
        return;
      }
      const info = await client.info();
      output({
        ...me,
        currentVersion: info.currentVersion,
        platform: info.platform,
        supported: info.supported,
        uploadSupported: info.uploadSupported ?? false,
        uploading: info.uploading ?? false,
        job: info.job,
      });
      return;
    }
    if (command === "clients") {
      output(await client.request("/v1/admin/client-releases"));
      return;
    }
    if (command === "logs") {
      if (!identity().scopes.includes(diagnosticsReadScope))
        throw new DeployError("diagnostics-scope-required");
      const filters = {
        limit: values.limit,
        before: values.before,
        level: values.level,
        category: values.category,
        code: values.code,
        deviceId: values["device-id"],
        connectionId: values["connection-id"],
        since: values.since === undefined ? undefined : logTime(values.since),
        until: values.until === undefined ? undefined : logTime(values.until),
      };
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) query.set(key, value);
      }
      try {
        output(await client.request("/v1/publish/diagnostics/logs?" + query));
      } catch (error) {
        if (error instanceof DeployError && error.status === 404)
          throw new DeployError("server-upgrade-required-for-diagnostics", 404);
        if (error instanceof DeployError && error.code === "publishing-scope-denied")
          throw new DeployError("diagnostics-scope-required", 403);
        throw error;
      }
      return;
    }
    if (!values.archive) throw new DeployError("archive-required");
    if (command === "publish-ota") {
      const scopes = identity().scopes;
      if (!scopes.includes("clients:read") || !scopes.includes("clients:write"))
        throw new DeployError("publishing-scope-denied");
      output(await publishMobileOTAPackage(client, values.archive, values));
      return;
    }
    if (command === "publish-client") {
      if (!values.target) throw new DeployError("client-target-required");
      if (values["notes-file"] && (await stat(values["notes-file"])).size > 16000)
        throw new DeployError("notes-file-too-large");
      const notes = values["notes-file"] ? await readFile(values["notes-file"], "utf8") : "";
      const file = await inspectClientPackage(values.archive, values.target, {
        version: values.version,
        buildNumber:
          values["build-number"] === undefined ? undefined : Number(values["build-number"]),
        notes,
        checksum: values.checksum,
      });
      output(await publishClientPackage(client, file, values.apply));
      return;
    }
    const archive = await inspectDeployArchive(values.archive, values.checksum);
    const receipt = await readFile(receiptPath, "utf8")
      .then((text) => JSON.parse(text) as DeployReceipt)
      .catch(() => null);
    const save = async (value: DeployReceipt) => {
      await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
      const temporary = receiptPath + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        await rename(temporary, receiptPath);
      } finally {
        await rm(temporary, { force: true });
      }
    };
    output(
      await deployServer(client, archive, {
        apply: values.apply,
        receipt,
        save,
        timeoutMs: timeout * 1000,
        report: output,
      }),
    );
  } finally {
    await unlock();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    const code = error instanceof DeployError ? error.code : "local-deploy-tool-error";
    output({
      error: code,
      ...(Object.hasOwn(errorMessages, code) ? { message: errorMessages[code] } : {}),
      ...(error instanceof DeployError && error.status ? { status: error.status } : {}),
    });
    process.exitCode = 1;
  });
