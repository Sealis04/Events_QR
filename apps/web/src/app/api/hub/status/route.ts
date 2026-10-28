import { hubModeOnly } from "../../../../server/mode";

export const dynamic = "force-dynamic";

/** Hub only: what the setup page shows (linked or not, server address, unsent counts). */
export const GET = hubModeOnly(async () => (await import("../../../../hub/routes")).status);
