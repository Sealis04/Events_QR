/**
 * The hub setup page on the hub's own dashboard (M12, part 2 at the venue). Same routes and JSON as
 * the VM's (`src/server/hubSetup.ts`), so the page code is shared. Steps that need the VM (the DNS
 * record, the "linked and pulling" view) say so and are skipped; results are kept in this hub's
 * SQLite file and uploaded to the VM with the next push (`pushChecks`), where they join the record.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import {
  api,
  evaluateCertificate,
  evaluateDataMatch,
  evaluateHubRunning,
  evaluateLocalDns,
  evaluateOfflineScan,
  evaluatePhoneViaHub,
  skipped,
  sqliteSchema,
  type CheckOutcome,
  type HubCheckStep,
} from "@events-qr/core";
import type { z } from "zod";
import { badRequest, json } from "../server/errors";
import { certExpiresAt } from "../server/hubCert";
import type { HubContext } from "./context";
import { immediate } from "./context";
import { hubRoute } from "./http";
import { getEventId, getLink, getState, setState } from "./state";
import { uplinkOutages } from "./vmsync";
import { VmRefused, VmUnreachable } from "./vmclient";
import { vmClientFor } from "./vmsync";

const { hubChecks, hubCheckOutbox, devices, tickets, staff, scans, hubScanOutbox } = sqliteSchema;

type CheckRecord = z.infer<typeof api.hubCheckRecord>;
type CheckRow = typeof hubChecks.$inferSelect;

const toRecord = (row: Omit<CheckRow, "seq">): CheckRecord => ({
  id: row.id,
  step: row.step as HubCheckStep,
  result: row.result as CheckRecord["result"],
  code: row.code,
  summary: row.summary,
  details: (row.details ?? null) as CheckRecord["details"],
  checked_at: row.checkedAt,
  checked_by_name: row.checkedByName,
  source: "hub",
  device_id: row.deviceId,
});

function records(ctx: HubContext, eventId: number) {
  const rows = ctx.db
    .select()
    .from(hubChecks)
    .where(eq(hubChecks.eventId, eventId))
    .orderBy(desc(hubChecks.checkedAt), desc(hubChecks.seq))
    .limit(400)
    .all();
  const latest = new Map<string, CheckRecord>();
  for (const row of rows) if (!latest.has(row.step)) latest.set(row.step, toRecord(row));
  return { latest: [...latest.values()], history: rows.slice(0, 40).map(toRecord) };
}

export function hubSetupView(ctx: HubContext, eventId: number) {
  const { latest, history } = records(ctx, eventId);
  const link = getLink(ctx);
  const startedAt = getState(ctx, "offline_test_started_at");
  const lastSync = getState(ctx, "last_cloud_sync_at");
  return {
    mode: "hub" as const,
    event_id: eventId,
    now: ctx.now(),
    hub_url: null,
    vm_url: link?.vmUrl ?? null,
    pull_interval_seconds: ctx.config.HUB_TICKET_PULL_SECONDS,
    hubs: [],
    checks: latest,
    history,
    /** Steps that need the VM; the hub skips them. */
    vm_only_steps: ["dns_record", "link_hub"] as HubCheckStep[],
    offline_test_started_at: startedAt ? Number(startedAt) : null,
    uplink: {
      online: !getState(ctx, "cloud_down_since") && !getState(ctx, "last_cloud_error"),
      last_sync_at: lastSync ? Number(lastSync) : null,
    },
  };
}

const idOf = (url: string): string | undefined => new URL(url).pathname.split("/")[3];

export const hubSetupViewRoute = hubRoute({ access: { staff: "admin" } }, ({ req, ctx }) => {
  const id = getEventId(ctx);
  if (id === undefined || String(id) !== idOf(req.url))
    return json({ error: { code: "not_found", message: "event not found" } }, 404);
  return json(hubSetupView(ctx, id));
});

/** What this hub holds for the data-match step. */
export function hubCounts(ctx: HubContext, eventId: number) {
  const rows = ctx.db
    .select({ status: tickets.status, n: sql<number>`COUNT(*)` })
    .from(tickets)
    .where(eq(tickets.eventId, eventId))
    .groupBy(tickets.status)
    .all();
  const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
  const people = ctx.db
    .select({ n: sql<number>`COUNT(*)` })
    .from(staff)
    .where(ne(staff.pinHash, ""))
    .get();
  return {
    tickets: { valid: by("valid"), used_up: by("used_up"), cancelled: by("cancelled") },
    staff: Number(people?.n ?? 0),
  };
}

async function dataMatch(ctx: HubContext, eventId: number): Promise<CheckOutcome> {
  const vm = vmClientFor(ctx, 4000);
  if (!vm) return skipped("needs_vm", "This hub is not linked to a VM yet.");
  let remote;
  try {
    remote = await vm.counts();
  } catch (err) {
    const why =
      err instanceof VmUnreachable || err instanceof VmRefused ? err.message : "unknown error";
    return skipped("needs_vm", `The VM could not be asked for its counts (${why}).`);
  }
  const lastPull = getState(ctx, "last_pull_at");
  return evaluateDataMatch({
    now: ctx.now(),
    hub: hubCounts(ctx, eventId),
    vm: remote,
    lastPullAt: lastPull ? Number(lastPull) : null,
    pullIntervalSeconds: ctx.config.HUB_TICKET_PULL_SECONDS,
  });
}

function phoneCheck(ctx: HubContext, eventId: number): CheckOutcome {
  const phones = ctx.db
    .select()
    .from(devices)
    .where(
      and(eq(devices.eventId, eventId), eq(devices.kind, "scanner"), eq(devices.revoked, false)),
    )
    .all();
  return evaluatePhoneViaHub({
    now: ctx.now(),
    phones: phones.map((p) => ({ label: p.label, gate: p.gate, lastSeenAt: p.lastSeenAt })),
  });
}

function offlineCheck(ctx: HubContext): CheckOutcome {
  const started = getState(ctx, "offline_test_started_at");
  const startedAt = started ? Number(started) : null;
  const rows = ctx.db
    .select({ receivedAt: scans.receivedAt, ackedAt: hubScanOutbox.ackedAt })
    .from(scans)
    .innerJoin(hubScanOutbox, eq(hubScanOutbox.scanId, scans.id))
    .where(gte(scans.receivedAt, startedAt ?? ctx.now() - 6 * 3600))
    .all();
  return evaluateOfflineScan({
    now: ctx.now(),
    startedAt,
    outages: uplinkOutages(ctx),
    scans: rows.flatMap((r) =>
      r.receivedAt === null ? [] : [{ receivedAt: r.receivedAt, ackedAt: r.ackedAt }],
    ),
  });
}

export const hubRunCheckRoute = hubRoute(
  { access: { staff: "admin" }, body: api.hubCheckRequest },
  async ({ req, ctx, staff: who, body }) => {
    const eventId = getEventId(ctx);
    if (eventId === undefined || String(eventId) !== idOf(req.url))
      return json({ error: { code: "not_found", message: "event not found" } }, 404);
    const now = ctx.now();
    const unstored = (step: HubCheckStep, o: CheckOutcome) =>
      json({
        check: {
          id: "00000000-0000-0000-0000-000000000000",
          step,
          result: o.result,
          code: o.code,
          summary: o.summary,
          details: o.details,
          checked_at: now,
          checked_by_name: who.name,
          source: "hub",
          device_id: null,
        },
        stored: false,
      });

    if (body.action === "start") {
      if (body.step !== "offline_scan") throw badRequest("only the offline test is started");
      setState(ctx, "offline_test_started_at", String(now));
      return unstored(body.step, {
        result: "skipped",
        code: "offline_started",
        summary: "The offline test has started.",
        details: { started_at: now },
      });
    }

    let outcome: CheckOutcome;
    switch (body.step) {
      case "hub_running":
      case "local_dns":
        if (!body.fetch) throw badRequest("this step is measured by the browser: send `fetch`");
        outcome =
          body.step === "hub_running"
            ? evaluateHubRunning(body.fetch)
            : evaluateLocalDns(body.fetch);
        break;
      case "certificate":
        outcome = evaluateCertificate({
          now,
          browser: body.browser && {
            reachedOverHttps: body.browser.reached_over_https,
            certExpiresAt:
              body.browser.cert_expires_at ?? certExpiresAt(ctx.config.HUB_CERT_PATH) ?? null,
          },
        });
        break;
      case "data_match":
        outcome = await dataMatch(ctx, eventId);
        break;
      case "phone_via_hub":
        outcome = phoneCheck(ctx, eventId);
        break;
      case "offline_scan":
        outcome = offlineCheck(ctx);
        break;
      default:
        return unstored(
          body.step,
          skipped("needs_vm", "This step needs the VM: run it on the VM's page."),
        );
    }
    // A skipped step (VM unreachable) is shown, not recorded: it says nothing about the hub.
    if (outcome.result === "skipped") return unstored(body.step, outcome);

    const row: Omit<CheckRow, "seq"> = {
      id: randomUUID(),
      eventId,
      deviceId: getLink(ctx)?.deviceId ?? null,
      step: body.step,
      result: outcome.result,
      code: outcome.code,
      summary: outcome.summary,
      details: outcome.details,
      checkedAt: now,
      checkedBy: who.id,
      checkedByName: who.name,
      source: "hub",
    };
    immediate(ctx, () => {
      ctx.db.insert(hubChecks).values(row).run();
      ctx.db.insert(hubCheckOutbox).values({ checkId: row.id, ackedAt: null }).run();
    });
    return json({ check: toRecord(row), stored: true });
  },
);
