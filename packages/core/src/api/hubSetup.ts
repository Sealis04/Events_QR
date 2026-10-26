import { z } from "zod";
import { HUB_CHECK_RESULTS, HUB_CHECK_SOURCES, HUB_CHECK_STEPS } from "../db/shared";
import { unixSeconds, uuid } from "./common";

export const hubCheckStep = z.enum(HUB_CHECK_STEPS);
const details = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** One stored check result. */
export const hubCheckRecord = z.object({
  id: uuid,
  step: hubCheckStep,
  result: z.enum(HUB_CHECK_RESULTS),
  code: z.string().nullable(),
  summary: z.string(),
  details: details.nullable(),
  checked_at: unixSeconds,
  checked_by_name: z.string().nullable(),
  source: z.enum(HUB_CHECK_SOURCES),
  device_id: uuid.nullable(),
});

/** What the browser saw when it fetched the hub's health (steps 1 and 5). */
export const healthFetch = z.object({
  url: z.string().max(500),
  reached: z.boolean(),
  status: z.number().int().optional(),
  body: z.unknown().optional(),
  error: z.string().max(500).optional(),
});

/**
 * `POST /events/{id}/hub-setup/checks` (admin). Steps 1 and 5 are measured by the browser and sent
 * as `fetch`; step 2 and 3 use the hub's name (`address`, a host name or URL); the rest need no
 * evidence. `action: "start"` begins the offline test (step 8) and records nothing else.
 */
export const hubCheckRequest = z.object({
  step: hubCheckStep,
  action: z.enum(["run", "start"]).default("run"),
  address: z.string().max(500).optional(),
  fetch: healthFetch.optional(),
  /** Step 3: the browser's view of the hub's certificate. */
  browser: z
    .object({
      reached_over_https: z.boolean(),
      cert_expires_at: unixSeconds.nullable().optional(),
    })
    .optional(),
});
/** `stored: false` for a step that could not run here (nothing was written). */
export const hubCheckResponse = z.object({ check: hubCheckRecord, stored: z.boolean() });

/** `POST /api/sync/hub-checks` (hub only): results recorded on the hub, uploaded with the next sync. */
export const syncHubChecksRequest = z.object({
  checks: z
    .array(
      z.object({
        id: uuid,
        device_id: uuid.nullable(),
        step: hubCheckStep,
        result: z.enum(HUB_CHECK_RESULTS),
        code: z.string().max(40).nullable(),
        summary: z.string().max(2000),
        details: details.nullable(),
        checked_at: unixSeconds,
        checked_by: uuid.nullable(),
        checked_by_name: z.string().max(255).nullable(),
      }),
    )
    .max(200),
});
export const syncHubChecksResponse = z.object({ acknowledged: z.array(uuid) });

/** `GET /api/sync/counts` (hub only): what the VM holds for the hub's event, for the data-match check. */
export const syncCountsResponse = z.object({
  tickets: z.object({
    valid: z.number().int(),
    used_up: z.number().int(),
    cancelled: z.number().int(),
  }),
  staff: z.number().int(),
  server_time: unixSeconds,
});
