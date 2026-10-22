import { json } from "../../../server/http";
import { byMode } from "../../../server/mode";

export const dynamic = "force-dynamic";

export const GET = byMode(
  async () => json({ ok: true, mode: "server", last_cloud_sync_at: null }),
  async () => (await import("../../../hub/routes")).health,
);
