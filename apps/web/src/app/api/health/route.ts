import { loadConfig } from "../../../server/config";
import { json } from "../../../server/http";
import { byMode } from "../../../server/mode";

export const dynamic = "force-dynamic";

export const GET = byMode(
  async () => {
    // Config only: the health check must not depend on the database or the signing key.
    const label = loadConfig().INSTANCE_LABEL;
    return json({
      ok: true,
      mode: "server",
      last_cloud_sync_at: null,
      ...(label ? { instance_label: label } : {}),
    });
  },
  async () => (await import("../../../hub/routes")).health,
);
