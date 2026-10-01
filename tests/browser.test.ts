import { expect, it } from "vitest";
import { clearWebCredentials, randomId, readWebCredentials, saveWebCredentials } from "../packages/client-shared/src/browser.js";

it("keeps administrator and control logins separate across navigation and logout", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  saveWebCredentials("admin-session", store, "admin");
  expect(readWebCredentials(store, "control")).toBeNull();
  saveWebCredentials("control-session", store, "control");
  expect(readWebCredentials(store, "admin")).toBe("admin-session");
  clearWebCredentials(store, "admin");
  expect(readWebCredentials(store, "admin")).toBeNull();
  expect(readWebCredentials(store, "control")).toBe("control-session");
});

it("ignores legacy tokens and remembers the account session across refreshes", () => {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  store.setItem("codexer.relay.admin-token.v1", "old-admin-token");
  store.setItem("codexer.web.relay.v1", JSON.stringify({ url: "http://relay.example", token: "old-access-token" }));
  expect(readWebCredentials(store)).toBeNull();
  expect(readWebCredentials(store, "admin")).toBeNull();
  const saved = JSON.stringify({ url: "http://different.example:9000", session: "test-account-session" });
  saveWebCredentials(saved, store);
  expect(store.getItem("codexer.relay.admin-token.v1")).toBeNull();
  expect(store.getItem("codexer.web.relay.v1")).toBeNull();
  expect(readWebCredentials(store)).toBe(saved);
  clearWebCredentials(store);
  expect(readWebCredentials(store)).toBeNull();
});

it("generates independent UUID v4 IDs when an HTTP context has no randomUUID API", () => {
  const httpCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
  const ids = Array.from({ length: 256 }, () => randomId(httpCrypto));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it("removes current and legacy credentials on logout", () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  saveWebCredentials("test-account-session", store);
  store.setItem("codexer.relay.admin-token.v1", "old-admin-token");
  store.setItem("codexer.web.relay.v1", "old-access-token");
  expect(readWebCredentials(store)).toBe("test-account-session");
  clearWebCredentials(store);
  expect(values.size).toBe(0);
});

it("continues without storage when the browser blocks it", () => {
  const blocked = {
    getItem: () => { throw new Error("storage-blocked"); },
    setItem: () => { throw new Error("storage-blocked"); },
    removeItem: () => { throw new Error("storage-blocked"); },
  };
  expect(readWebCredentials(blocked)).toBeNull();
  expect(() => saveWebCredentials("session", blocked)).toThrow("storage-blocked");
  expect(() => clearWebCredentials(blocked)).not.toThrow();
  expect(readWebCredentials()).toBeNull();
  expect(() => clearWebCredentials()).not.toThrow();
});
