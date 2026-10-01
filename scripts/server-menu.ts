import { Writable } from "node:stream";
import { spawn } from "node:child_process";
import { loginAccount, accountFromEnv } from "../packages/shared/src/admin-account.js";
import type { AdminAccount } from "../packages/shared/src/admin-account.js";
import { promptPassword } from "../packages/shared/src/password-prompt.js";
import { chmod, chown, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { configureInstalledEnv, publicOrigin } from "./server-config.js";
import { SERVICE_NAME } from "./server-service.js";

const configPath = "/etc/codexer/relay.env";
const versionPath = "/opt/codexer/current/VERSION";
type Config = Record<string, string | undefined>;
type Ask = (question: string, secret?: boolean) => Promise<string>;

async function run(command: string, args: string[], inherit = false): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", chunk => { output += String(chunk); });
    child.stderr?.setEncoding("utf8").on("data", chunk => { output += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolveRun({ code: code ?? 1, output }));
  });
}

async function checked(command: string, args: string[]): Promise<string> {
  const result = await run(command, args);
  if (result.code !== 0) throw new Error(`${command} ${args[0] ?? ""} 失败：${result.output.trim().slice(0, 300)}`);
  return result.output;
}

async function config(): Promise<{ source: string; values: Config }> {
  const source = await readFile(configPath, "utf8");
  return { source, values: parseEnv(source) };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} 未配置；请重新运行安装器`);
  return value;
}

async function saveConfig(source: string): Promise<void> {
  const current = await stat(configPath);
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o640, flag: "wx" });
    await chown(temporary, current.uid, current.gid);
    await chmod(temporary, 0o640);
    await rename(temporary, configPath);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function active(): Promise<boolean> {
  return (await run("systemctl", ["is-active", "--quiet", SERVICE_NAME])).code === 0;
}

async function healthy(port: number, account: AdminAccount): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account), signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const session = await response.json() as { role?: string; session: string };
        await fetch(`http://127.0.0.1:${port}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${session.session}` }, signal: AbortSignal.timeout(1500) });
        if (session.role === "admin") return true;
      }
    } catch { /* Service may still be starting. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  return false;
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const { values } = await config();
  const token = await loginAccount(`http://127.0.0.1:${required(values.RELAY_PORT, "RELAY_PORT")}`, adminAccount(values));
  try {
  const response = await fetch(`http://127.0.0.1:${required(values.RELAY_PORT, "RELAY_PORT")}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${value.error ?? "请求失败"}`);
  return value;
  } finally { await fetch(`http://127.0.0.1:${values.RELAY_PORT}/v1/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => undefined); }
}

async function address(): Promise<string> {
  const { values } = await config();
  const origin = values.RELAY_ALLOWED_ORIGINS?.split(",")[0];
  if (!origin) throw new Error("访问地址未配置");
  return publicOrigin(origin).origin;
}

async function applyConfig(next: string, account: AdminAccount, port: number): Promise<void> {
  const previous = (await config()).source;
  const wasActive = await active();
  await saveConfig(next);
  if (!wasActive) { console.log("配置已保存。服务启动后生效。"); return; }
  try {
    await checked("systemctl", ["restart", SERVICE_NAME]);
    if (!await healthy(port, account)) throw new Error(`健康检查失败；运行 codexer logs 排查`);
  } catch (error) {
    await saveConfig(previous);
    await checked("systemctl", ["restart", SERVICE_NAME]).catch(() => undefined);
    throw error;
  }
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise(resolvePort => {
    server.once("error", () => resolvePort(false));
    server.listen(port, "0.0.0.0", () => server.close(() => resolvePort(true)));
  });
}

function validPort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new Error("端口必须为 1–65535 的整数");
  return port;
}

async function changePort(input: string): Promise<void> {
  const port = validPort(input);
  const { source, values } = await config();
  const current = new URL(await address());
  if (port !== Number(values.RELAY_PORT) && !await portAvailable(port)) throw new Error(`端口 ${port} 已被占用`);
  current.port = String(port);
  const account = adminAccount(values);
  const configured = configureInstalledEnv(source, current.origin, account);
  await applyConfig(configured.content, account, port);
  console.log(`新地址：${configured.origin}`);
  console.log("请同步检查防火墙、云安全组和客户端中的服务器地址。");
}

async function changeOrigins(input: string): Promise<void> {
  const { source, values } = await config();
  const account = adminAccount(values);
  const configured = configureInstalledEnv(source, await address(), account, input);
  await applyConfig(configured.content, account, configured.port);
  console.log(`允许的浏览器来源：${configured.values.RELAY_ALLOWED_ORIGINS}`);
}

function adminAccount(values: Config): AdminAccount {
  const account = accountFromEnv(values);
  if (!account) throw new Error("管理员账号未配置");
  return account;
}
async function resetAdminPassword(ask?: Ask): Promise<void> {
  const { source, values } = await config();
  const account = { ...adminAccount(values), password: ask ? await ask("新管理员密码：", true) : await promptPassword("新管理员密码：") };
  const configured = configureInstalledEnv(source, await address(), account);
  const me = await api<{ userId: string }>("/v1/me");
  await api('/v1/users/' + me.userId + '/password', "PUT", { password: account.password });
  await saveConfig(configured.content);
  console.log("管理员密码已更新，旧登录已失效。");
}

async function start(): Promise<void> {
  await checked("systemctl", ["start", SERVICE_NAME]);
  const { values } = await config();
  if (!await healthy(Number(required(values.RELAY_PORT, "RELAY_PORT")), adminAccount(values))) throw new Error("服务启动后未通过健康与认证检查，运行 codexer logs 排查");
  console.log("服务已启动。");
}

async function stop(): Promise<void> { await checked("systemctl", ["stop", SERVICE_NAME]); console.log("服务已停止。"); }

async function restart(): Promise<void> {
  await checked("systemctl", ["restart", SERVICE_NAME]);
  const { values } = await config();
  if (!await healthy(Number(required(values.RELAY_PORT, "RELAY_PORT")), adminAccount(values))) throw new Error("服务重启后未通过健康与认证检查，运行 codexer logs 排查");
  console.log("服务已重启。");
}

async function status(): Promise<void> {
  const output = await checked("systemctl", ["show", SERVICE_NAME, "--property=ActiveState,SubState,MainPID,NRestarts,MemoryCurrent", "--no-pager"]);
  console.log(output.trim());
  if (await active()) {
    const { values } = await config();
    const ok = await healthy(Number(required(values.RELAY_PORT, "RELAY_PORT")), adminAccount(values));
    console.log(`HTTP/管理员认证：${ok ? "正常" : "不可用"}`);

  }
}

async function logs(): Promise<void> {
  console.log("正在跟随日志，按 Ctrl+C 返回菜单。");
  const interrupted = () => undefined;
  process.on("SIGINT", interrupted);
  try { await run("journalctl", ["-u", SERVICE_NAME, "-n", "100", "-f", "--no-pager"], true); }
  finally { process.off("SIGINT", interrupted); }
}

async function info(): Promise<void> {
  const { values } = await config();
  const version = await readFile(versionPath, "utf8").catch(() => "未知");
  console.log(`Codexer Relay 版本：${version.trim()}`);
  console.log(`服务：${await active() ? "运行中" : "已停止"}  端口：${values.RELAY_PORT}`);
  console.log(`地址：${await address()}`);
  console.log(`程序：/opt/codexer/current  配置：${configPath}  数据：${values.RELAY_DATA_DIR}`);
}

async function userMenu(ask: Ask): Promise<void> {
  while (true) {
    console.log("\n账号管理：1 查看账号  2 创建账号  3 设置密码  4 禁用账号  0 返回");
    const choice = await ask("选择：");
    if (choice === "0") return;
    if (choice === "1") {
      const { users } = await api<{ users: { id: string; name: string; revoked_at: number | null }[] }>("/v1/users");
      for (const user of users) console.log(user.id + "  " + user.name + "  " + (user.revoked_at ? "已禁用" : "有效"));
    } else if (choice === "2") {
      const username = await ask("账号名称：");
      const password = await ask("密码：", true);
      const result = await api<{ id: string }>("/v1/users", "POST", { username, password });
      console.log("账号已创建：" + result.id);
    } else if (choice === "3" || choice === "4") {
      const id = await ask("账号 ID：");
      if (choice === "3") await api('/v1/users/' + encodeURIComponent(id) + '/password', "PUT", { password: await ask("新密码：", true) });
      else if (await ask("确认禁用？输入 YES：") === "YES") await api('/v1/users/' + encodeURIComponent(id), "DELETE");
    }
  }
}

async function dispatch(command: string, args: string[], ask?: Ask): Promise<void> {
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "restart") return restart();
  if (command === "status") return status();
  if (command === "logs") return logs();
  if (command === "port") {
    const value = args[0] || await ask?.("新端口：");
    if (!value) throw new Error("需要提供新端口");
    return changePort(value);
  }
  if (command === "password") return resetAdminPassword(ask);
  if (command === "origins") {
    const value = args[0] ?? await ask?.("额外来源（逗号分隔，留空清除）：");
    if (value === undefined) throw new Error("需要提供来源列表");
    return changeOrigins(value);
  }
  if (command === "users") { if (!ask) throw new Error("用户菜单需要交互终端"); return userMenu(ask); }
  if (command === "info") return info();
  throw new Error("未知命令。运行 codexer help 查看用法");
}

async function menu(): Promise<void> {
  if (!process.stdin.isTTY) throw new Error("交互菜单需要终端；可使用 codexer <命令>");
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const ask: Ask = async (question, secret = false) => {
    if (!secret) return (await prompt.question(question)).trim();
    process.stdout.write(question); hidden = true;
    try { return await prompt.question(""); } finally { hidden = false; process.stdout.write("\n"); }
  };
  try {
    while (true) {
      console.log("\n========== Codexer 管理菜单 ==========");
      try { await info(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
      console.log("1. 启动服务    2. 停止服务    3. 重启服务");
      console.log("4. 查看状态    5. 查看日志    6. 修改端口");
      console.log("7. 修改管理员密码    8. 账号管理    9. 浏览器来源");
      console.log("0. 退出");
      const choice = await ask("选择：");
      if (choice === "0") return;
      const command = ({ "1": "start", "2": "stop", "3": "restart", "4": "status", "5": "logs", "6": "port", "7": "password", "8": "users", "9": "origins" } as Record<string, string>)[choice];
      if (!command) { console.log("无效选项。"); continue; }
      try { await dispatch(command, [], ask); }
      catch (error) { console.error(`操作失败：${error instanceof Error ? error.message : String(error)}`); }
    }
  } finally { prompt.close(); }
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action === "help" || action === "--help") {
    console.log("codexer [start|stop|restart|status|logs|port <数字>|password|origins <地址列表>|users|info|help]");
    return;
  }
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("请在 Linux 上以 root 运行：sudo codexer");
  if (!action) return menu();
  return dispatch(action, process.argv.slice(3));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
