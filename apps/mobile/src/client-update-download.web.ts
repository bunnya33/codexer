import type { ClientRelease } from "../../../packages/shared/src/client-release";
import type { FileSource } from "./file-transfer";
export async function downloadClientUpdate(
  _source: FileSource,
  _release: ClientRelease,
  _signal: AbortSignal,
  _progress: (value: number) => void,
) {
  throw new Error("网页控制端随服务器更新");
}
