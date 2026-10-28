/**
 * The hub's sync with the VM (docs/spec.md "Sync loops"). Every function is one idempotent step,
 * safe to retry and safe to run from two processes at once: tickets and scans are keyed by their
 * ids, cursors only move forward after a page has been stored, and the hub never lets a pull
 * undo what it decided itself (its own admits win until the scans are merged and recomputed).
 *
 *   pull (every 30 s, and on demand)  meta, tickets, then the VM's scans
 *   push (every 5 s)                  devices enrolled at the hub, then the hub's scans
 */
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  api,
  bytesToHex,
  hexToBytes,
  sqliteSchema,
  type HubCheckResult,
  type HubCheckStep,
  type Outage,
} from "@events-qr/core";
import { immediate, type HubContext } from "./context";
import { recomputeTicket } from "./recompute";
import { getEventId, getLink, getState, setState } from "./state";
import { VmClient, VmRefused, VmUnreachable } from "./vmclient";

const { events, ticketTypes, staff, devices, enrolmentCodes, tickets, scans } = sqliteSchema;
const { hubScanOutbox, hubDeviceOutbox, hubChecks, hubCheckOutbox } = sqliteSchema;

type SyncTicket = z.infer<typeof api.syncTicket>;
type Meta = z.infer<typeof api.syncMetaResponse>;

export function vmClientFor(ctx: HubContext, timeoutMs?: number): VmClient | undefined {
  const link = getLink(ctx);
  if (!link) return undefined;
  return new VmClient({
    baseUrl: link.vmUrl,
    token: link.token,
    fetch: ctx.vmFetch,
    timeoutMs: timeoutMs ?? ctx.config.HUB_VM_TIMEOUT_SECONDS * 1000,
  });
}

/** Mirrors the event, ticket types, staff, scanner devices and unused phone codes from the VM. */
export function applyMeta(ctx: HubContext, meta: Meta): void {
  immediate(ctx, () => {
    const { event } = meta;
    ctx.db
      .insert(events)
      .values({
        id: event.id,
        name: event.name,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        encKeyRef: "hub: the event key is in hub_state",
        signKeyId: event.sign_key_id,
        gates: event.gates,
        config: event.config,
      })
      .onConflictDoUpdate({
        target: events.id,
        set: {
          name: event.name,
          startsAt: event.starts_at,
          endsAt: event.ends_at,
          signKeyId: event.sign_key_id,
          gates: event.gates,
          config: event.config,
        },
      })
      .run();
    setState(ctx, "event_id", String(event.id));

    for (const t of meta.ticket_types) {
      const values = {
        eventId: event.id,
        idx: t.idx,
        name: t.name,
        capacity: t.capacity,
        issued: t.issued,
        entryMode: t.entry_mode,
        maxAdmits: t.max_admits,
        gateMask: t.gate_mask,
        slots: t.slots,
        earlyEntryMin: t.early_entry_min,
      };
      ctx.db
        .insert(ticketTypes)
        .values(values)
        .onConflictDoUpdate({ target: [ticketTypes.eventId, ticketTypes.idx], set: values })
        .run();
    }

    for (const s of meta.staff) {
      ctx.db
        .insert(staff)
        .values({ id: s.id, name: s.name, pinHash: s.pin_hash, role: s.role })
        .onConflictDoUpdate({
          target: staff.id,
          set: { name: s.name, pinHash: s.pin_hash, role: s.role },
        })
        .run();
    }
    // The VM lists only the event's current staff (none after it ends). Anyone else loses their
    // hash here: the row stays (scans point at it) but with an empty hash nobody can log in as it.
    const listedStaff = meta.staff.map((s) => s.id);
    ctx.db
      .update(staff)
      .set({ pinHash: "" })
      .where(listedStaff.length ? notInArray(staff.id, listedStaff) : undefined)
      .run();

    for (const d of meta.devices) {
      ctx.db
        .insert(devices)
        .values({
          id: d.id,
          eventId: event.id,
          label: d.label,
          gate: d.gate,
          direction: d.direction,
          tokenHash: d.token_hash,
          revoked: d.revoked,
        })
        .onConflictDoUpdate({
          target: devices.id,
          set: {
            label: d.label,
            gate: d.gate,
            direction: d.direction,
            tokenHash: d.token_hash,
            revoked: d.revoked,
          },
        })
        .run();
    }

    // Codes: add the new ones. A code that has vanished from the VM's unused list was used (or
    // revoked) there, so it stops working here too, unless this hub used it itself (already marked).
    const now = ctx.now();
    for (const c of meta.enrolment_codes) {
      ctx.db
        .insert(enrolmentCodes)
        .values({
          eventId: event.id,
          codeHash: c.code_hash,
          gate: c.gate,
          direction: c.direction,
          label: c.label,
          createdAt: now,
          expiresAt: c.expires_at,
        })
        .onConflictDoNothing()
        .run();
    }
    const listed = meta.enrolment_codes.map((c) => c.code_hash);
    ctx.db
      .update(enrolmentCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(enrolmentCodes.kind, "scanner"),
          isNull(enrolmentCodes.usedAt),
          listed.length ? notInArray(enrolmentCodes.codeHash, listed) : undefined,
        ),
      )
      .run();
  });
}

/**
 * Stores a page of the VM's tickets. A ticket the hub has never seen is stored as the VM has it.
 * For one it knows, the descriptive fields follow the VM and a cancellation wins, but `admits_used`
 * and `inside` stay the hub's own: the scans decide those (see `pullScans`). Rows get the hub's
 * clock as `updated_at`, so phones that already moved past the VM's timestamp still see the change.
 */
export function applyTickets(ctx: HubContext, rows: SyncTicket[]): void {
  const eventId = getEventId(ctx);
  const incoming = rows.filter((t) => t.event_id === eventId);
  if (!incoming.length) return;
  immediate(ctx, () => {
    const now = ctx.now();
    for (let i = 0; i < incoming.length; i += 400) {
      const chunk = incoming.slice(i, i + 400);
      const known = new Map(
        ctx.db
          .select()
          .from(tickets)
          .where(
            inArray(
              tickets.id,
              chunk.map((t) => hexToBytes(t.id)),
            ),
          )
          .all()
          .map((r) => [bytesToHex(r.id), r]),
      );
      for (const t of chunk) {
        const cur = known.get(t.id);
        if (!cur) {
          ctx.db
            .insert(tickets)
            .values({
              id: hexToBytes(t.id),
              eventId: t.event_id,
              ticketType: t.ticket_type,
              holderName: t.holder_name,
              tokenNonce: new Uint8Array(12), // the hub never re-sends a token
              entryMode: t.entry_mode,
              maxAdmits: t.max_admits,
              gateMask: t.gate_mask,
              slotStart: t.slot_start,
              slotEnd: t.slot_end,
              admitsUsed: t.admits_used,
              inside: t.inside,
              status: t.status,
              cancelledAt: t.cancelled_at ?? null,
              issuedAt: t.updated_at,
              updatedAt: now,
            })
            .run();
          continue;
        }
        const status = t.status === "cancelled" ? "cancelled" : cur.status;
        const changed =
          cur.ticketType !== t.ticket_type ||
          cur.holderName !== t.holder_name ||
          cur.entryMode !== t.entry_mode ||
          cur.maxAdmits !== t.max_admits ||
          cur.gateMask !== t.gate_mask ||
          cur.slotStart !== t.slot_start ||
          cur.slotEnd !== t.slot_end ||
          cur.status !== status ||
          (t.cancelled_at != null && cur.cancelledAt !== t.cancelled_at);
        if (!changed) continue;
        ctx.db
          .update(tickets)
          .set({
            ticketType: t.ticket_type,
            holderName: t.holder_name,
            entryMode: t.entry_mode,
            maxAdmits: t.max_admits,
            gateMask: t.gate_mask,
            slotStart: t.slot_start,
            slotEnd: t.slot_end,
            status,
            cancelledAt: t.cancelled_at ?? cur.cancelledAt,
            updatedAt: sql`max(${now}, ${tickets.updatedAt})`,
          })
          .where(eq(tickets.id, cur.id))
          .run();
        // Offline admits scanned after the cancellation are conflicts: re-judge this ticket.
        if (status === "cancelled") recomputeTicket(ctx, t.id);
      }
    }
  });
}

export async function pullMeta(ctx: HubContext, vm: VmClient): Promise<void> {
  applyMeta(ctx, await vm.meta());
}

/** Ticket pages until the VM says there are no more. Returns how many rows came in. */
export async function pullTickets(ctx: HubContext, vm: VmClient): Promise<number> {
  let count = 0;
  for (;;) {
    const page = await vm.tickets(getState(ctx, "cursor_tickets") ?? null);
    applyTickets(ctx, page.tickets);
    if (page.next_cursor) setState(ctx, "cursor_tickets", page.next_cursor);
    count += page.tickets.length;
    if (!page.has_more) return count;
  }
}

/**
 * Scans the VM holds (decided at the VM while the hub was out of reach, or uploaded by other
 * hubs), merged into the hub's `scans` and followed by a recompute of the tickets they touch, so
 * the hub's `admits_used`, `inside` and `conflict` flags converge on what the VM computes. A scan
 * for a ticket the hub does not have yet stops the page there: the cursor must not skip it.
 */
export async function pullScans(ctx: HubContext, vm: VmClient): Promise<number> {
  let count = 0;
  for (;;) {
    const page = await vm.scans(getState(ctx, "cursor_scans") ?? null);
    const applied = immediate(ctx, () => {
      const knownDevices = new Set(
        ctx.db
          .select({ id: devices.id })
          .from(devices)
          .all()
          .map((d) => d.id),
      );
      const knownStaff = new Set(
        ctx.db
          .select({ id: staff.id })
          .from(staff)
          .all()
          .map((s) => s.id),
      );
      const touched = new Set<string>();
      let last: string | null = null;
      let stopped = false;
      let n = 0;
      for (const s of page.scans) {
        const ticketId = hexToBytes(s.ticket_id);
        const ticket = ctx.db
          .select({ id: tickets.id })
          .from(tickets)
          .where(eq(tickets.id, ticketId))
          .get();
        if (!ticket) {
          stopped = true;
          break;
        }
        const inserted = ctx.db
          .insert(scans)
          .values({
            id: s.scan_id,
            ticketId,
            deviceId: knownDevices.has(s.device_id) ? s.device_id : null,
            staffId: s.staff_id && knownStaff.has(s.staff_id) ? s.staff_id : null,
            gate: s.gate,
            direction: s.direction,
            scannedAt: s.scanned_at,
            receivedAt: s.received_at,
            result: s.result,
            offline: s.offline,
          })
          .onConflictDoNothing()
          .run();
        if (inserted.changes) {
          n += 1;
          touched.add(s.ticket_id);
        }
        last = `${s.received_at}:${s.scan_id}`;
      }
      for (const id of touched) recomputeTicket(ctx, id);
      if (last) setState(ctx, "cursor_scans", last);
      return { n, stopped };
    });
    count += applied.n;
    if (applied.stopped || !page.has_more) return count;
  }
}

/** Uploads the hub's own scans in batches of up to 500. Returns how many the VM acknowledged. */
export async function pushScans(ctx: HubContext, vm: VmClient): Promise<number> {
  let sent = 0;
  for (;;) {
    const rows = ctx.db
      .select({ scan: scans })
      .from(hubScanOutbox)
      .innerJoin(scans, eq(scans.id, hubScanOutbox.scanId))
      .where(isNull(hubScanOutbox.ackedAt))
      .orderBy(scans.scannedAt, scans.id)
      .limit(500)
      .all();
    if (!rows.length) return sent;
    const res = await vm.pushScans(
      rows.map(({ scan: s }) => ({
        scan_id: s.id,
        ticket_id: bytesToHex(s.ticketId),
        device_id: s.deviceId ?? "00000000-0000-0000-0000-000000000000",
        staff_id: s.staffId,
        gate: s.gate,
        direction: s.direction as "entry" | "exit",
        scanned_at: s.scannedAt,
        result: s.result as z.infer<typeof api.scanResult>,
        offline: s.offline,
      })),
    );
    if (!res.acknowledged.length) return sent;
    ctx.db
      .update(hubScanOutbox)
      .set({ ackedAt: ctx.now() })
      .where(inArray(hubScanOutbox.scanId, res.acknowledged))
      .run();
    sent += res.acknowledged.length;
    if (rows.length < 500) return sent;
  }
}

/** Phones enrolled at the hub become valid devices on the VM, so the VM fallback accepts them. */
export async function pushDevices(ctx: HubContext, vm: VmClient): Promise<number> {
  const rows = ctx.db
    .select({ outbox: hubDeviceOutbox, device: devices })
    .from(hubDeviceOutbox)
    .innerJoin(devices, eq(devices.id, hubDeviceOutbox.deviceId))
    .where(isNull(hubDeviceOutbox.ackedAt))
    .limit(200)
    .all();
  if (!rows.length) return 0;
  const res = await vm.pushDevices(
    rows.map(({ outbox, device }) => ({
      id: device.id,
      gate: device.gate,
      direction: device.direction as "entry" | "exit" | "both",
      label: device.label,
      token_hash: device.tokenHash,
      code_hash: outbox.codeHash,
      enrolled_at: outbox.usedAt,
    })),
  );
  if (res.acknowledged.length) {
    ctx.db
      .update(hubDeviceOutbox)
      .set({ ackedAt: ctx.now() })
      .where(inArray(hubDeviceOutbox.deviceId, res.acknowledged))
      .run();
  }
  return res.acknowledged.length;
}

export const pendingScanCount = (ctx: HubContext): number =>
  ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(hubScanOutbox)
    .where(isNull(hubScanOutbox.ackedAt))
    .get()?.n ?? 0;

const MAX_OUTAGES = 10;

/** Finished uplink outages (newest last), then the one still going on, if any: the hub setup page's offline check reads these. */
export function uplinkOutages(ctx: Pick<HubContext, "db">): Outage[] {
  const raw = getState(ctx, "cloud_outages");
  const done: Outage[] = raw ? (JSON.parse(raw) as Outage[]) : [];
  const downSince = getState(ctx, "cloud_down_since");
  return downSince ? [...done, { from: Number(downSince), to: null }] : done;
}

/**
 * Keeps the uplink outage log. Only calls that really reached (or failed to reach) the VM count:
 * a push with nothing to send touches no network, so it says nothing either way. An outage starts
 * at the last contact that worked (the hub cannot know sooner than its next call that the cable
 * was pulled) and ends at the first one that works again.
 */
function trackUplink(ctx: HubContext, up: boolean): void {
  const now = ctx.now();
  if (up) {
    const downSince = getState(ctx, "cloud_down_since");
    if (downSince) {
      const raw = getState(ctx, "cloud_outages");
      const done: Outage[] = raw ? (JSON.parse(raw) as Outage[]) : [];
      done.push({ from: Number(downSince), to: now });
      setState(ctx, "cloud_outages", JSON.stringify(done.slice(-MAX_OUTAGES)));
      setState(ctx, "cloud_down_since", null);
    }
    setState(ctx, "cloud_last_ok_at", String(now));
  } else if (!getState(ctx, "cloud_down_since")) {
    setState(ctx, "cloud_down_since", getState(ctx, "cloud_last_ok_at") ?? String(now));
  }
}

function markCloud(ctx: HubContext, error: unknown): void {
  if (error === null) {
    setState(ctx, "last_cloud_sync_at", String(ctx.now()));
    setState(ctx, "last_cloud_error", null);
  } else {
    setState(ctx, "last_cloud_error", error instanceof Error ? error.message : String(error));
  }
}

/** Uploads hub setup results recorded on this hub; the VM keeps them as the record that the hub was tested. */
export async function pushChecks(ctx: HubContext, vm: VmClient): Promise<number> {
  const rows = ctx.db
    .select({ check: hubChecks })
    .from(hubCheckOutbox)
    .innerJoin(hubChecks, eq(hubChecks.id, hubCheckOutbox.checkId))
    .where(isNull(hubCheckOutbox.ackedAt))
    .limit(100)
    .all();
  if (!rows.length) return 0;
  const res = await vm.pushChecks(
    rows.map(({ check: c }) => ({
      id: c.id,
      device_id: c.deviceId,
      step: c.step as HubCheckStep,
      result: c.result as HubCheckResult,
      code: c.code,
      summary: c.summary,
      details: c.details,
      checked_at: c.checkedAt,
      checked_by: c.checkedBy,
      checked_by_name: c.checkedByName,
    })),
  );
  if (res.acknowledged.length)
    ctx.db
      .update(hubCheckOutbox)
      .set({ ackedAt: ctx.now() })
      .where(inArray(hubCheckOutbox.checkId, res.acknowledged))
      .run();
  return res.acknowledged.length;
}

/** One pull pass: meta, tickets, then the VM's scans. Throws VmUnreachable / VmRefused. */
export async function pullCycle(ctx: HubContext, vm: VmClient) {
  try {
    await pullMeta(ctx, vm);
    const ticketsIn = await pullTickets(ctx, vm);
    const scansIn = await pullScans(ctx, vm);
    markCloud(ctx, null);
    trackUplink(ctx, true);
    setState(ctx, "last_pull_at", String(ctx.now()));
    return { tickets: ticketsIn, scans: scansIn };
  } catch (err) {
    markCloud(ctx, err);
    trackUplink(ctx, false);
    throw err;
  }
}

/** One push pass: devices first (so the VM knows who scanned), then scans. */
export async function pushCycle(ctx: HubContext, vm: VmClient) {
  try {
    const devicesOut = await pushDevices(ctx, vm);
    const scansOut = await pushScans(ctx, vm);
    const checksOut = await pushChecks(ctx, vm);
    markCloud(ctx, null);
    if (devicesOut + scansOut + checksOut > 0) trackUplink(ctx, true);
    return { devices: devicesOut, scans: scansOut, checks: checksOut };
  } catch (err) {
    markCloud(ctx, err);
    trackUplink(ctx, false);
    throw err;
  }
}

let onDemand: Promise<void> | undefined;

/**
 * Pull tickets now, for a claim that names a ticket the hub has not got. Concurrent callers share
 * one pull; a short timeout keeps the gate moving, and an unreachable VM is simply ignored.
 */
export function pullTicketsQuietly(ctx: HubContext): Promise<void> {
  onDemand ??= (async () => {
    try {
      const vm = vmClientFor(ctx, 3000);
      if (vm) await pullTickets(ctx, vm);
    } catch (err) {
      if (!(err instanceof VmUnreachable || err instanceof VmRefused)) console.error(err);
    } finally {
      onDemand = undefined;
    }
  })();
  return onDemand;
}
