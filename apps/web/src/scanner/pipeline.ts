/**
 * The scanner's validation order (docs/spec.md "Validation algorithm"), run on the phone: prefix,
 * AES-GCM + Ed25519 (core `verifyToken`), event, local ticket list, then the exit or entry branch.
 * Entry checks use the signed QR fields (core `checkEntry`), so gate and slot are enforced even for
 * a ticket the phone has never heard of. The server decides "used" (`/api/claim`).
 *
 * Pure of UI and storage details: the store and the hub client are passed in, so every result
 * state is unit-tested without a browser.
 */
import {
  bytesToHex,
  checkEntry,
  decideClaim,
  decideExit,
  decodeEntryRule,
  SLOT_NONE,
  verifyToken,
  type ClaimState,
  type TicketPayload,
} from "@events-qr/core";
import { NetworkError, type HubClient } from "./client";
import type {
  ClaimResponse,
  DeviceRecord,
  Direction,
  ScannerStore,
  StaffSession,
  SyncTicket,
} from "./types";

export interface FirstScan {
  gate: string;
  at: number;
  device: string | null;
}

export type ScanOutcome =
  | {
      kind: "admitted";
      name: string | null;
      typeName: string;
      entry: number | null;
      of: number | null;
      override?: boolean;
      /** Decided on the phone alone (no hub, no VM): the result screen shows the OFFLINE banner. */
      offline?: boolean;
    }
  | {
      kind: "exited";
      name: string | null;
      typeName: string;
      entriesLeft: number | null;
      offline?: boolean;
    }
  | { kind: "no_reentry"; name: string | null; typeName: string }
  | {
      kind: "used" | "inside";
      name: string | null;
      typeName: string;
      first: FirstScan | null;
      offline?: boolean;
    }
  | { kind: "cancelled"; name: string | null }
  | { kind: "not_ticket" }
  | { kind: "invalid" }
  | { kind: "wrong_event" }
  | { kind: "wrong_gate"; allowedGates: string[] }
  | { kind: "too_early"; slotStart: number }
  | { kind: "slot_ended"; slotEnd: number }
  | {
      kind: "unknown_ticket";
      ticketId: string;
      typeName: string;
      direction: Direction;
      /** What the signed QR says about the ticket: enough to decide an override offline. */
      stub: SyncTicket;
    }
  /** Offline, and the event only lets offline phones admit tickets limited to this gate. */
  | { kind: "offline_restricted" }
  | { kind: "no_connection" };

export interface PipelineDeps {
  store: ScannerStore;
  client: HubClient;
  device: DeviceRecord;
  /** Who is logged in on the phone (goes into the scan record). */
  staff: StaffSession | null;
  /** Corrected clock, Unix seconds. */
  now(): number;
  newId(): string;
}

const keyCache = new WeakMap<
  DeviceRecord["bundle"],
  { keys: Map<number, Uint8Array>; eventKey: Uint8Array }
>();

export function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function keysOf(bundle: DeviceRecord["bundle"]) {
  let cached = keyCache.get(bundle);
  if (!cached) {
    cached = {
      keys: new Map(
        Object.entries(bundle.public_keys).map(([id, k]) => [Number(id), fromBase64(k)]),
      ),
      eventKey: fromBase64(bundle.event_key),
    };
    keyCache.set(bundle, cached);
  }
  return cached;
}

export async function processScan(
  deps: PipelineDeps,
  rawInput: string,
  direction: Direction,
): Promise<ScanOutcome> {
  const { store, client, device } = deps;
  const raw = rawInput.trim();
  if (!raw.startsWith("EVT1:")) return { kind: "not_ticket" };

  const { keys, eventKey } = keysOf(device.bundle);
  const verified = await verifyToken(raw, keys, eventKey, device.bundle.event_id);
  if (!verified.ok) {
    if (verified.error === "wrong_event") return { kind: "wrong_event" };
    if (verified.error === "not_ours") return { kind: "not_ticket" };
    return { kind: "invalid" };
  }
  const payload = verified.payload;
  const ticketId = bytesToHex(payload.ticketId);
  const local = await store.getTicket(ticketId);
  const type = device.ticketTypes.find((t) => t.idx === payload.ticketType);
  const typeName = type?.name ?? `Type ${payload.ticketType}`;
  const name = local?.holder_name ?? null;

  const entryCheck = () =>
    checkEntry(payload, {
      gateIndex:
        device.bundle.gates.indexOf(device.gate) >= 0
          ? device.bundle.gates.indexOf(device.gate)
          : undefined,
      now: deps.now(),
      dayZeroUnix: device.bundle.day_zero,
      earlyEntryMin: type?.early_entry_min ?? 15,
    });
  const entryRefusal = (): ScanOutcome | undefined => {
    const check = entryCheck();
    if (check.ok) return undefined;
    if (check.reason === "wrong_gate") {
      return {
        kind: "wrong_gate",
        allowedGates: check.allowedGates.map((i) => device.bundle.gates[i] ?? `Gate ${i + 1}`),
      };
    }
    if (check.reason === "too_early") return { kind: "too_early", slotStart: check.slotStart };
    return { kind: "slot_ended", slotEnd: check.slotEnd };
  };

  if (!local) {
    // Signature is genuine but the ticket was issued after the last sync. Gate and slot still apply.
    if (direction === "entry") {
      const refused = entryRefusal();
      if (refused) return refused;
    }
    return {
      kind: "unknown_ticket",
      ticketId,
      typeName,
      direction,
      stub: stubFromPayload(device, payload),
    };
  }
  if (local.status === "cancelled") return { kind: "cancelled", name };

  const body = {
    scan_id: deps.newId(),
    ticket_id: ticketId,
    device_id: device.deviceId,
    staff_id: deps.staff?.id ?? null,
    gate: device.gate,
    scanned_at: deps.now(),
  };

  try {
    if (direction === "exit") {
      return await runExit(deps, local, typeName, decodeEntryRule(payload.entryRule).mode, body);
    }

    const refused = entryRefusal();
    if (refused) return refused;
    const res = await client.claim(body);
    return await claimOutcome(res, local, typeName, (t) => store.putTickets([t]));
  } catch (err) {
    // Neither the hub nor the VM answered: decide alone from the local list (docs/spec.md).
    if (err instanceof NetworkError) {
      return direction === "exit"
        ? await offlineExit(deps, local, typeName, body)
        : await offlineEntry(deps, local, typeName, body, payload.gateMask);
    }
    throw err; // AuthError and anything unexpected reach the UI
  }
}

/** The signed QR fields as a ticket row, for a ticket the phone's list does not have. */
function stubFromPayload(device: DeviceRecord, payload: TicketPayload): SyncTicket {
  const rule = decodeEntryRule(payload.entryRule);
  return {
    id: bytesToHex(payload.ticketId),
    event_id: device.bundle.event_id,
    ticket_type: payload.ticketType,
    holder_name: null,
    entry_mode: rule.mode,
    max_admits: rule.maxAdmits,
    gate_mask: payload.gateMask,
    slot_start: payload.slotStart === SLOT_NONE ? null : payload.slotStart,
    slot_end: payload.slotEnd === SLOT_NONE ? null : payload.slotEnd,
    admits_used: 0,
    inside: false,
    status: "valid",
    updated_at: 0,
  };
}

const stateOf = (t: SyncTicket): ClaimState => ({
  status: t.status,
  admitsUsed: t.admits_used,
  inside: t.inside,
  entryMode: t.entry_mode,
  maxAdmits: t.max_admits,
});

type OfflineBody = Parameters<HubClient["claim"]>[0];

/**
 * The offline entry branch (docs/spec.md "Validation algorithm"): the shared `decideClaim` on the
 * phone's own copy of the ticket. An admit updates the local state and queues the scan in the
 * outbox (`offline = true`) in one step; the hub or the VM sorts out duplicates when it arrives.
 */
async function offlineEntry(
  deps: PipelineDeps,
  local: SyncTicket,
  typeName: string,
  body: OfflineBody,
  gateMask: number,
  override = false,
): Promise<ScanOutcome> {
  const name = local.holder_name;
  if (deps.device.offlineGateOnly && gateMask === 0 && !override)
    return { kind: "offline_restricted" };
  const decision = decideClaim(stateOf(local));
  if (decision.result === "rejected_cancelled") return { kind: "cancelled", name };
  if (decision.result !== "admitted") {
    return {
      // The spec's offline wording: "Already inside (offline)" / "No entries left (offline)".
      kind: decision.result === "rejected_inside" ? "inside" : "used",
      name,
      typeName,
      first: null,
      offline: true,
    };
  }
  await deps.store.commitOffline(
    {
      ...local,
      admits_used: decision.admitsUsed,
      inside: true,
      status: decision.next.status,
    },
    {
      scan_id: body.scan_id,
      ticket_id: body.ticket_id,
      device_id: body.device_id,
      staff_id: body.staff_id ?? null,
      gate: body.gate,
      direction: "entry",
      scanned_at: body.scanned_at,
      result: override ? "override" : "admitted",
      offline: true,
    },
  );
  const reentry = decision.limit !== 1;
  return {
    kind: "admitted",
    name,
    typeName,
    entry: reentry ? decision.admitsUsed : null,
    of: reentry ? decision.limit : null,
    offline: true,
    ...(override ? { override } : {}),
  };
}

/** The offline exit branch: `decideExit`; single-entry tickets show grey and log nothing. */
async function offlineExit(
  deps: PipelineDeps,
  local: SyncTicket,
  typeName: string,
  body: OfflineBody,
): Promise<ScanOutcome> {
  const name = local.holder_name;
  const decision = decideExit(stateOf(local));
  if (decision.result !== "exited") {
    return decision.result === "rejected_cancelled"
      ? { kind: "cancelled", name }
      : { kind: "no_reentry", name, typeName };
  }
  await deps.store.commitOffline(
    { ...local, inside: decision.next.inside },
    {
      scan_id: body.scan_id,
      ticket_id: body.ticket_id,
      device_id: body.device_id,
      staff_id: body.staff_id ?? null,
      gate: body.gate,
      direction: "exit",
      scanned_at: body.scanned_at,
      result: "exited",
      offline: true,
    },
  );
  return { kind: "exited", name, typeName, entriesLeft: decision.entriesLeft, offline: true };
}

type ScanBody = Parameters<HubClient["exit"]>[0];

/** Exit: always asks the server so the scan is logged; a single-entry ticket just shows grey. */
async function runExit(
  deps: PipelineDeps,
  local: SyncTicket,
  typeName: string,
  mode: SyncTicket["entry_mode"],
  body: ScanBody,
): Promise<ScanOutcome> {
  const name = local.holder_name;
  const res = await deps.client.exit(body);
  if (res.result === "rejected_cancelled") return { kind: "cancelled", name };
  if (res.result === "no_reentry" || mode === "single")
    return { kind: "no_reentry", name, typeName };
  await deps.store.putTickets([{ ...local, inside: false }]);
  return { kind: "exited", name, typeName, entriesLeft: res.entries_left ?? null };
}

/** Manual exit from the search list (no QR to read). */
export async function manualExit(deps: PipelineDeps, local: SyncTicket): Promise<ScanOutcome> {
  const type = deps.device.ticketTypes.find((t) => t.idx === local.ticket_type);
  const typeName = type?.name ?? `Type ${local.ticket_type}`;
  const body = {
    scan_id: deps.newId(),
    ticket_id: local.id,
    device_id: deps.device.deviceId,
    staff_id: deps.staff?.id ?? null,
    gate: deps.device.gate,
    scanned_at: deps.now(),
  };
  try {
    if (local.status === "cancelled") return { kind: "cancelled", name: local.holder_name };
    return await runExit(deps, local, typeName, local.entry_mode, body);
  } catch (err) {
    if (err instanceof NetworkError) return await offlineExit(deps, local, typeName, body);
    throw err;
  }
}

async function claimOutcome(
  res: ClaimResponse,
  local: SyncTicket,
  typeName: string,
  persist: (ticket: SyncTicket) => Promise<void>,
  override = false,
): Promise<ScanOutcome> {
  const name = local.holder_name;
  if (res.result === "rejected_cancelled") {
    await persist({ ...local, status: "cancelled" });
    return { kind: "cancelled", name };
  }
  if (res.result === "admitted") {
    const used = res.admits_used ?? local.admits_used + 1;
    const limit = res.limit ?? null;
    await persist({
      ...local,
      admits_used: used,
      inside: true,
      status: limit !== null && used >= limit ? "used_up" : local.status,
    });
    const reentry = limit !== 1;
    return {
      kind: "admitted",
      name,
      typeName,
      entry: reentry ? used : null,
      of: reentry ? limit : null,
      ...(override ? { override } : {}),
    };
  }
  return {
    // A single-entry ticket has no inside/outside: once admitted it is simply used.
    kind: res.result === "rejected_inside" && local.entry_mode !== "single" ? "inside" : "used",
    name,
    typeName,
    first: res.first_scan ?? null,
  };
}

/**
 * Supervisor override (the amber screen, or a manual admit from the search list): the ticket is not in the phone's list, so the server
 * (which knows every ticket) decides, and records the scan as `override` with the supervisor's id.
 */
export async function overrideAdmit(
  deps: PipelineDeps,
  ticketId: string,
  typeName: string,
  supervisor: StaffSession,
  known?: SyncTicket,
  /** The ticket as the signed QR describes it (the amber screen carries it): used offline. */
  signed?: SyncTicket,
): Promise<ScanOutcome> {
  const { client, device } = deps;
  const body = {
    scan_id: deps.newId(),
    ticket_id: ticketId,
    device_id: device.deviceId,
    staff_id: supervisor.id,
    gate: device.gate,
    scanned_at: deps.now(),
  };
  try {
    const res = await client.claim({ ...body, override: true });
    const stub: SyncTicket = known ?? {
      id: ticketId,
      event_id: device.bundle.event_id,
      ticket_type: 0,
      holder_name: null,
      entry_mode: "single",
      max_admits: null,
      gate_mask: 0,
      slot_start: null,
      slot_end: null,
      admits_used: 0,
      inside: false,
      status: "valid",
      updated_at: 0,
    };
    // A ticket the phone does not know is not stored: the next sync brings the real row.
    return await claimOutcome(
      res,
      stub,
      typeName,
      known ? (t) => deps.store.putTickets([t]) : async () => {},
      true,
    );
  } catch (err) {
    if (err instanceof NetworkError) {
      // A supervisor's override also works with no network: their PIN was checked offline, and
      // the signed QR (or the phone's own row) says how many entries the ticket allows.
      const basis = known ?? signed;
      if (!basis) return { kind: "no_connection" };
      return await offlineEntry(deps, basis, typeName, body, 0, true);
    }
    throw err;
  }
}
