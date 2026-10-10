import { randomUUID } from "node:crypto";
import type { RelayStore } from "./go-relay.js";

export const testPassword = "test-password-12345";
export async function testAccount(store: RelayStore, name = "test", role: "admin" | "user" = "user") {
  const user = await store.createUser(name, testPassword, role);
  const { session } = await store.createSession(user.id);
  return { ...user, session, headers: { authorization: `Bearer ${session}` } };
}
export async function testAgent(store: RelayStore, userId: string) {
  const id = await store.registerAgent(userId, randomUUID(), "PC", "win32");
  const { session } = await store.createSession(userId, id);
  return { id, token: session };
}
