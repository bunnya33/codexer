import type { FastifyRequest } from "fastify";
import type { Principal } from "../auth/types.js";
import { HttpError } from "../core/errors.js";
import type { RelayStore } from "../storage/store.js";

export function bearer(request: FastifyRequest): string {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : "";
}

/** 每个请求单独保存身份；设备校验隐藏跨账号资源的存在。 */
export function createGuards(store: RelayStore, allowedOrigins: string[]) {
  const principals = new WeakMap<FastifyRequest, Principal>();

  const origins = new Set(allowedOrigins);

  const authenticate = async (request: FastifyRequest): Promise<Principal> => {
    const principal = await store.sessionPrincipal(bearer(request));
    if (!principal) throw new HttpError(401, "unauthorized");
    return principal;
  };

  const member = async (request: FastifyRequest) => {
    principals.set(request, await authenticate(request));
  };

  const control = async (request: FastifyRequest) => {
    const principal = await authenticate(request);
    if (principal.kind !== "user") throw new HttpError(403, "control-account-required");
    principals.set(request, principal);
  };

  const admin = async (request: FastifyRequest) => {
    const principal = await authenticate(request);
    if (principal.kind !== "admin") throw new HttpError(403, "admin-required");
    principals.set(request, principal);
  };

  const deviceAccess = async (request: FastifyRequest) => {
    const principal = await authenticate(request);
    const { deviceId } = request.params as { deviceId: string };
    if (!(await store.ownsDevice(deviceId, principal)))
      throw new HttpError(404, "device-not-found");
    principals.set(request, principal);
  };

  const originAllowed = (request: FastifyRequest) =>
    !request.headers.origin ||
    origins.has(request.headers.origin) ||
    request.headers.origin === `${request.protocol}://${request.headers.host}`;

  return { principals, member, control, admin, deviceAccess, originAllowed };
}
