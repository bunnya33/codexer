import { HttpError } from "../core/errors.js";
import type { RelayStore } from "../storage/store.js";

/** 独立的账号失败计数；调用者仍通过队列串行处理登录。 */
export function createLoginService(store: RelayStore) {
  const failures = new Map<string, { count: number; until: number }>();

  async function login(username: string, password: string, role: "admin" | "user" = "user") {
    const key = role + ":" + username.toLowerCase(),
      now = Date.now();
    for (const [name, entry] of failures) if (entry.until <= now) failures.delete(name);
    if ((failures.get(key)?.count ?? 0) >= 10) throw new HttpError(429, "login-rate-limited");
    const account = await store.checkPassword(username, password, role);
    if (!account) {
      const entry = failures.get(key) ?? { count: 0, until: now + 15 * 60000 };
      entry.count++;
      failures.set(key, entry);
      if (failures.size > 10000) failures.delete(failures.keys().next().value!);
      throw new HttpError(401, "invalid-account-or-password");
    }
    failures.delete(key);
    return account;
  }

  return login;
}
