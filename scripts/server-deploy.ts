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
  PUBLISH_SCOPES,
} from "../packages/shared/src/publisher-auth.js";
import {
  inspectClientPackage,
  publishClientPackage,
} from "../packages/shared/src/client-publish.js";

const help = `Codexer 发布工具（独立网页授权）
  npm run server:deploy -- login --url https://server.example.com [--name <电脑名称>] [--scopes server:read,server:write,clients:read,clients:write]
  npm run server:deploy -- status
  npm run server:deploy -- deploy --archive <服务器包.tar.gz> [--checksum <文件.sha256>] [--apply]
  npm run server:deploy -- publish-client --target <目标> --archive <安装包> [--version X.Y.Z] [--build-number N] [--notes-file <说明.txt>] [--checksum <文件.sha256>] [--apply]
  npm run server:deploy -- clients
  npm run server:deploy -- logout

通用选项：--profile <名称>（默认 default） --timeout <秒>（默认 900）
deploy / publish-client 默认只预检，--apply 才执行。
login 在真实服务器后台授权，工具不接收管理员密码。远程连接必须使用 HTTPS。
客户端发布不自动安装到设备。Windows Agent 安装版同时同步兼容更新通道。
Android 自动验证正式签名、applicationId、versionName 和 versionCode（需要 Android SDK/JDK）。
`;
const output = (value: unknown) => console.log(JSON.stringify(value));
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      url: { type: "string" },
      profile: { type: "string", default: "default" },
      name: { type: "string" },
      scopes: { type: "string" },
      archive: { type: "string" },
      checksum: { type: "string" },
      apply: { type: "boolean" },
      timeout: { type: "string", default: "900" },
      target: { type: "string" },
      version: { type: "string" },
      "build-number": { type: "string" },
      "notes-file": { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(help);
    return;
  }
  if (
    positionals.length !== 1 ||
    !["login", "status", "deploy", "publish-client", "clients", "logout"].includes(command)
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
      const scopes = values.scopes ? values.scopes.split(",") : PUBLISH_SCOPES;
      if (
        scopes.length === 0 ||
        scopes.some((s) => !PUBLISH_SCOPES.includes(s as (typeof PUBLISH_SCOPES)[number]))
      )
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
    if (!values.archive) throw new DeployError("archive-required");
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
    output({
      error: error instanceof DeployError ? error.code : "local-deploy-tool-error",
      ...(error instanceof DeployError && error.status ? { status: error.status } : {}),
    });
    process.exitCode = 1;
  });
