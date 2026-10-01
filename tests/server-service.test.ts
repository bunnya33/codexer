import { expect, it } from "vitest";
import { isManagedUnit, serviceUnit } from "../scripts/server-service.js";

it("generates a persistent systemd unit for the installed checkout", () => {
  const unit = serviceUnit("/usr/bin/node");
  expect(unit).toContain("User=codexer\nGroup=codexer\nWorkingDirectory=/opt/codexer/current\nEnvironmentFile=/etc/codexer/relay.env");
  expect(unit).toContain("ExecStart=/usr/bin/node /opt/codexer/current/dist/apps/relay/src/main.js");
  expect(unit).toContain("ProtectSystem=strict");
  expect(unit).toContain("ReadWritePaths=/var/lib/codexer");
  expect(unit).toContain("Restart=on-failure");
  expect(unit).toContain("WantedBy=multi-user.target");
  expect(isManagedUnit(unit)).toBe(true);
  expect(isManagedUnit(unit.replace("WorkingDirectory=/opt/codexer/current", "WorkingDirectory=/tmp"))).toBe(false);
});

it("refuses unsafe unit fields", () => {
  expect(() => serviceUnit("/usr/bin/node\nExecStart=/bin/false")).toThrow();
  expect(() => serviceUnit("/usr/local/node with spaces")).toThrow();
});
