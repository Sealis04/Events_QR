/**
 * The hub setup checklist on the VM (M12): stores check results, runs the checks that need the
 * VM (DNS through a public resolver, the TLS handshake, the hub device row) and takes the hub's
 * own results and counts. The evaluation itself is pure and lives in `@events-qr/core`
 * (`packages/core/src/hubSetup`). Steps that look at what the hub holds run on the hub's own page.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  api,
  evaluateCertificate,
  evaluateDnsRecord,
  evaluateHubRunning,
  evaluateLinkHub,
  evaluateLocalDns,
  mysqlSchema,
  skipped,
  type CheckOutcome,
  type DnsLookup,
  type HubCheckStep,
} from "@events-qr/core";
import type { AuthedStaff } from "./auth";
import type { AppContext } from "./context";
import { loadEvent } from "./events";
import { hashesForEvent } from "./eventStaff";
import { badRequest } from "./http";
import {
  parseDnsAnswers,
  parseHubAddress,
  publicDnsLookup,
  tlsProbe as realTlsProbe,
  type TlsProbe,
} from "./hubProbe";

const { hubChecks, devices, tickets } = mysqlSchema;

export type CheckRecord = z.infer<typeof api.hubCheckRecord>;
type CheckRow = typeof hubChecks.$inferSelect;
type CheckRequest = z.infer<typeof api.hubCheckRequest>;

/** The network pieces a check uses, replaceable in tests. */
export interface HubProbes {
  dns: (host: string) => Promise<DnsLookup>;
  tls: TlsProbe;
}

export const realProbes = (ctx: AppContext): HubProbes => {
  const fixed = parseDnsAnswers(ctx.config.HUB_CHECK_DNS_ANSWERS);
  return {
    dns: (host) => publicDnsLookup(ctx.config, host),
    // A name answered by the test hook has no real address behind it: do not dial it.
    tls: (target) =>
      fixed.has(target.servername) ? Promise.resolve(undefined) : realTlsProbe(target),
  };
};

export const toRecord = (row: CheckRow): CheckRecord => ({
  id: row.id,
  step: row.step as HubCheckStep,
  result: row.result as CheckRecord["result"],
  code: row.code,
  summary: row.summary,
  details: (row.details ?? null) as CheckRecord["details"],
  checked_at: row.checkedAt,
  checked_by_name: row.checkedByName,
  source: row.source as "vm" | "hub",
  device_id: row.deviceId,
});

/** The newest row per step, and the latest `limit` rows overall as the record of what was tested. */
export async function checkRecords(ctx: AppContext, eventId: number, limit = 40) {
  const rows = await ctx.db
    .select()
    .from(hubChecks)
    .where(eq(hubChecks.eventId, eventId))
    .orderBy(desc(hubChecks.checkedAt), desc(hubChecks.id))
    .limit(400);
  const latest = new Map<string, CheckRecord>();
  for (const row of rows) if (!latest.has(row.step)) latest.set(row.step, toRecord(row));
  return { latest: [...latest.values()], history: rows.slice(0, limit).map(toRecord) };
}

async function hubDevices(ctx: AppContext, eventId: number) {
  const rows = await ctx.db
    .select()
    .from(devices)
    .where(and(eq(devices.eventId, eventId), eq(devices.kind, "hub")));
  return rows.map((d) => ({
    id: d.id,
    label: d.label,
    revoked: d.revoked,
    lastSeenAt: d.lastSeenAt,
    lastPullAt: d.lastPullAt,
  }));
}

/** `GET /api/events/{id}/hub-setup`: everything the page needs to draw itself on the VM. */
export async function hubSetupView(ctx: AppContext, eventId: number) {
  await loadEvent(ctx.db, eventId);
  const { latest, history } = await checkRecords(ctx, eventId);
  const hubs = await hubDevices(ctx, eventId);
  return {
    mode: "server" as const,
    event_id: eventId,
    now: ctx.now(),
    /** The address the browser should use for the hub; the page lets the person change it. */
    hub_url: ctx.config.HUB_URL ?? null,
    vm_url: ctx.config.PUBLIC_URL ?? null,
    pull_interval_seconds: ctx.config.HUB_TICKET_PULL_SECONDS,
    hubs: hubs.map((h) => ({
      id: h.id,
      label: h.label,
      revoked: h.revoked,
      last_seen_at: h.lastSeenAt,
      last_pull_at: h.lastPullAt,
    })),
    checks: latest,
    history,
    /** Steps the VM cannot run: they look at what the hub holds. */
    hub_only_steps: ["data_match", "phone_via_hub", "offline_scan"] as HubCheckStep[],
    offline_test_started_at: null,
  };
}

async function store(
  ctx: AppContext,
  eventId: number,
  staff: AuthedStaff,
  step: HubCheckStep,
  result: CheckOutcome,
  deviceId: string | null,
): Promise<CheckRecord> {
  const row: CheckRow = {
    id: randomUUID(),
    eventId,
    deviceId,
    step,
    result: result.result,
    code: result.code,
    summary: result.summary,
    details: result.details,
    checkedAt: ctx.now(),
    checkedBy: staff.id,
    checkedByName: staff.name,
    source: "vm",
  };
  await ctx.db.insert(hubChecks).values(row);
  return toRecord(row);
}

const hostOrThrow = (ctx: AppContext, address: string | undefined) => {
  const parsed = parseHubAddress(address ?? ctx.config.HUB_URL ?? "");
  if (!parsed) throw badRequest("give the hub's address, for example https://hub.example.org");
  return parsed;
};

/** `POST /api/events/{id}/hub-setup/checks`: run (or record the browser's measurement of) one step. */
export async function runHubCheck(
  ctx: AppContext,
  staff: AuthedStaff,
  eventId: number,
  input: CheckRequest,
  probes: HubProbes = realProbes(ctx),
): Promise<{ check: CheckRecord; stored: boolean }> {
  await loadEvent(ctx.db, eventId);
  if (input.action === "start") throw badRequest("the offline test is started on the hub");
  const now = ctx.now();
  let outcome: CheckOutcome;
  let deviceId: string | null = null;

  switch (input.step) {
    case "hub_running":
    case "local_dns": {
      if (!input.fetch) throw badRequest("this step is measured by the browser: send `fetch`");
      outcome =
        input.step === "hub_running"
          ? evaluateHubRunning(input.fetch)
          : evaluateLocalDns(input.fetch);
      break;
    }
    case "dns_record": {
      const { host } = hostOrThrow(ctx, input.address);
      outcome = /^[\d.]+$|:/.test(host)
        ? {
            result: "fail",
            code: "dns_ip_address",
            summary: `${host} is an IP address, not a name.`,
            details: { host },
          }
        : evaluateDnsRecord(await probes.dns(host));
      break;
    }
    case "certificate": {
      const { host, port } = hostOrThrow(ctx, input.address);
      const lookup = await probes.dns(host).catch(() => undefined);
      // Try the private address DNS gave (usually unreachable from the VM: the hub sits on its own LAN).
      const address = lookup?.addresses[0];
      const vmTls = address ? await probes.tls({ address, port, servername: host }) : undefined;
      outcome = evaluateCertificate({
        now,
        vmTls,
        browser: input.browser && {
          reachedOverHttps: input.browser.reached_over_https,
          certExpiresAt: input.browser.cert_expires_at ?? null,
        },
      });
      break;
    }
    case "link_hub": {
      const hubs = await hubDevices(ctx, eventId);
      outcome = evaluateLinkHub({ now, hubs });
      const id = outcome.details.device_id;
      deviceId = typeof id === "string" ? id : null;
      break;
    }
    default:
      // data_match, phone_via_hub, offline_scan: they read the hub's own data.
      outcome = skipped(
        "run_on_hub",
        "This step looks at what the hub holds: run it on the hub's own page.",
      );
      return {
        check: {
          id: "00000000-0000-0000-0000-000000000000",
          step: input.step,
          result: outcome.result,
          code: outcome.code,
          summary: outcome.summary,
          details: outcome.details,
          checked_at: now,
          checked_by_name: staff.name,
          source: "vm",
          device_id: null,
        },
        stored: false,
      };
  }
  return { check: await store(ctx, eventId, staff, input.step, outcome, deviceId), stored: true };
}

/**
 * `POST /api/sync/hub-checks` (hub): results recorded on the hub's own page. Idempotent on the id
 * the hub chose; a hub may only write to its own event.
 */
export async function acceptHubChecks(
  ctx: AppContext,
  hub: { id: string; eventId: number },
  input: z.infer<typeof api.syncHubChecksRequest>,
): Promise<z.infer<typeof api.syncHubChecksResponse>> {
  const acknowledged: string[] = [];
  for (const c of input.checks) {
    await ctx.db
      .insert(hubChecks)
      .values({
        id: c.id,
        eventId: hub.eventId,
        deviceId: c.device_id ?? hub.id,
        step: c.step,
        result: c.result,
        code: c.code,
        summary: c.summary,
        details: c.details,
        checkedAt: c.checked_at,
        checkedBy: c.checked_by,
        checkedByName: c.checked_by_name,
        source: "hub",
      })
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
    acknowledged.push(c.id);
  }
  return { acknowledged };
}

/** `GET /api/sync/counts` (hub): what the VM holds for the hub's event, to compare with the hub's own. */
export async function vmCounts(
  ctx: AppContext,
  hub: { eventId: number },
): Promise<z.infer<typeof api.syncCountsResponse>> {
  const rows = await ctx.db
    .select({ status: tickets.status, n: sql<number>`COUNT(*)` })
    .from(tickets)
    .where(eq(tickets.eventId, hub.eventId))
    .groupBy(tickets.status);
  const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  return {
    tickets: { valid: by("valid"), used_up: by("used_up"), cancelled: by("cancelled") },
    staff: (await hashesForEvent(ctx, hub.eventId)).length,
    server_time: ctx.now(),
  };
}
