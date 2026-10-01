import { parseEnv } from "node:util";
import { expect, it } from "vitest";
import { configureServerEnv, publicOrigin } from "../scripts/server-config.js";

const adminToken = { username: "admin", password: "admin-password-example-12345" };

it("creates a server config with the browser origin and matching port", () => {
  const result = configureServerEnv("", "http://203.0.113.25:8899/", adminToken);
  expect(result).toMatchObject({ origin: "http://203.0.113.25:8899", port: 8899 });
  expect(parseEnv(result.content)).toMatchObject({ RELAY_HOST: "0.0.0.0", RELAY_PORT: "8899", RELAY_ALLOWED_ORIGINS: "http://203.0.113.25:8899", RELAY_ADMIN_USERNAME: adminToken.username, RELAY_ADMIN_PASSWORD_B64: Buffer.from(adminToken.password).toString("base64") });
});

it("keeps other settings and an existing origin list until the URL changes", () => {
  const source = `# Keep this setting\nDATABASE_URL=postgres://localhost/example\nRELAY_ADMIN_TOKEN=${adminToken.password}\nRELAY_ALLOWED_ORIGINS=http://first.example:8899,http://second.example:8899\nRELAY_PORT=8899\n`;
  const retained = configureServerEnv(source, "http://first.example:8899", adminToken, true);
  expect(retained.content).toContain("# Keep this setting");
  expect(parseEnv(retained.content)).toMatchObject({ DATABASE_URL: "postgres://localhost/example", RELAY_ADMIN_USERNAME: adminToken.username, RELAY_ADMIN_PASSWORD_B64: Buffer.from(adminToken.password).toString("base64"), RELAY_ALLOWED_ORIGINS: "http://first.example:8899,http://second.example:8899" });
  const changed = configureServerEnv(retained.content, "http://new.example:9000", adminToken);
  expect(parseEnv(changed.content)).toMatchObject({ DATABASE_URL: "postgres://localhost/example", RELAY_ADMIN_USERNAME: adminToken.username, RELAY_ADMIN_PASSWORD_B64: Buffer.from(adminToken.password).toString("base64"), RELAY_PORT: "9000", RELAY_ALLOWED_ORIGINS: "http://new.example:9000" });
});

it("adds validated browser origins without duplicates", () => {
  const result = configureServerEnv("", "http://203.0.113.25:8899", adminToken, false, "http://other.example:8899,http://203.0.113.25:8899");
  expect(parseEnv(result.content).RELAY_ALLOWED_ORIGINS).toBe("http://203.0.113.25:8899,http://other.example:8899");
  expect(parseEnv(configureServerEnv(result.content, "http://203.0.113.25:8899", adminToken, false, "").content).RELAY_ALLOWED_ORIGINS).toBe("http://203.0.113.25:8899");
  expect(() => configureServerEnv("", "http://203.0.113.25:8899", adminToken, false, "http://other.example/path")).toThrow();
  expect(parseEnv(configureServerEnv("", "http://203.0.113.25:8899", adminToken, false, "https://relay.example.com").content).RELAY_ALLOWED_ORIGINS).toBe("http://203.0.113.25:8899,https://relay.example.com");
});

it("rejects an address that cannot be the browser's HTTP origin", () => {
  for (const address of ["https://example.com", "http://example.com/path", "http://user:pass@example.com", "http://example.com?x=1", "http://192.0.2.10:8899"]) {
    expect(() => publicOrigin(address)).toThrow();
  }
});

it("round trips administrator passwords with quotes and backslashes through the installed environment", () => {
  const account = { username: "admin", password: `quotes ' \" and backslash \\ 12345` };
  const values = parseEnv(configureServerEnv("", "http://203.0.113.25:8899", account).content);
  expect(Buffer.from(values.RELAY_ADMIN_PASSWORD_B64!, "base64").toString()).toBe(account.password);
});
