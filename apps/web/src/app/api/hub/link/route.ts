import { hubModeOnly } from "../../../../server/mode";

export const dynamic = "force-dynamic";

/** Hub only: links an unlinked hub with a setup code (the server address is HUB_SERVER_URL). */
export const POST = hubModeOnly(async () => (await import("../../../../hub/routes")).link);
