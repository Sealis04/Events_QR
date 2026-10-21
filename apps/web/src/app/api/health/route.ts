import { json } from "../../../server/http";

export const dynamic = "force-dynamic";

export const GET = async () => json({ ok: true, mode: "server", last_cloud_sync_at: null });
