import { hubModeOnly } from "../../../server/mode";

export const dynamic = "force-dynamic";

/** The hub API's `POST /enroll` (docs/spec.md "APIs"): the same exchange as `/api/devices/enroll`. */
export const POST = hubModeOnly(async () => (await import("../../../hub/routes")).enroll);
