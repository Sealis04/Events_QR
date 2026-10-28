import { hubModeOnly } from "../../../../server/mode";

export const dynamic = "force-dynamic";

/** Hub only: wipes the hub back to the setup page. */
export const POST = hubModeOnly(async () => (await import("../../../../hub/routes")).reset);
