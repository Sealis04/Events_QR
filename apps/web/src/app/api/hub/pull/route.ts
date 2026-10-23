import { hubModeOnly } from "../../../../server/mode";

export const dynamic = "force-dynamic";

/** Hub only: "Pull tickets now" on the dashboard. The VM answers 404. */
export const POST = hubModeOnly(async () => (await import("../../../../hub/routes")).pullNow);
