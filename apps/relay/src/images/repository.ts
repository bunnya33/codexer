import { jsonForStorage } from "../../../../packages/shared/src/json.js";
import type { ImagePayload } from "../../../../packages/protocol/src/index.js";
import type { Sql } from "../storage/types.js";

/** 按设备和会话隔离图片缓存，限制容量并保留命令需要的图片。 */
export class ImageRepository {
  constructor(private readonly sql: Sql) {}

  async image(
    deviceId: string,
    threadId: string,
    id: string,
    uploadedOnly = false,
  ): Promise<ImagePayload | null> {
    const { rows } = await this.sql.query(
      "SELECT payload FROM images WHERE device_id=$1 AND thread_id=$2 AND id=$3 AND (expires_at IS NULL OR expires_at>$4) AND ($5=FALSE OR uploaded=TRUE) AND EXISTS(SELECT 1 FROM devices WHERE id=$1 AND revoked_at IS NULL)",
      [deviceId, threadId, id, Date.now(), uploadedOnly],
    );
    return (rows[0]?.payload as ImagePayload) ?? null;
  }

  async saveImage(
    deviceId: string,
    threadId: string,
    id: string,
    image: ImagePayload,
    uploaded: boolean,
  ): Promise<void> {
    const bytes = Buffer.byteLength(image.base64, "base64");
    const total = (
      await this.sql.query(
        "SELECT COALESCE(SUM(bytes),0) AS total FROM images WHERE device_id=$1 AND NOT (thread_id=$2 AND id=$3)",
        [deviceId, threadId, id],
      )
    ).rows[0]?.total;
    if (Number(total) + bytes > 128 * 1024 * 1024) throw new Error("image-storage-full");
    await this.sql.query(
      "INSERT INTO images(device_id,thread_id,id,payload,bytes,uploaded,expires_at,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT(device_id,thread_id,id) DO UPDATE SET payload=EXCLUDED.payload,expires_at=CASE WHEN images.expires_at IS NULL THEN NULL ELSE EXCLUDED.expires_at END",
      [
        deviceId,
        threadId,
        id,
        jsonForStorage(image),
        bytes,
        uploaded,
        Date.now() + (uploaded ? 86400000 : 7 * 86400000),
        Date.now(),
      ],
    );
  }

  async retainImages(deviceId: string, threadId: string, ids: string[]): Promise<void> {
    for (const id of ids)
      await this.sql.query(
        "UPDATE images SET expires_at=$4 WHERE device_id=$1 AND thread_id=$2 AND id=$3 AND uploaded=TRUE",
        [deviceId, threadId, id, Date.now() + 7 * 86400000],
      );
  }
}
