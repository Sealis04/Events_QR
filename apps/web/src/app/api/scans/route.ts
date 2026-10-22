import { hubModeOnly } from "../../../server/mode";

export const dynamic = "force-dynamic";

/** The hub API's `POST /scans`: a phone uploads scans it decided without the hub. */
export const POST = hubModeOnly(async () => (await import("../../../hub/routes")).scans);
