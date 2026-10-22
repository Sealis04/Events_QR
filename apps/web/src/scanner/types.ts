import type { z } from "zod";
import type { api } from "@events-qr/core";

export type KeyBundle = z.infer<typeof api.keyBundle>;
export type SyncTicket = z.infer<typeof api.syncTicket>;
export type ClaimResponse = z.infer<typeof api.claimResponse>;
export type ExitResponse = z.infer<typeof api.exitResponse>;
export type SyncResponse = z.infer<typeof api.hubSyncResponse>;
export type ScannerTicketType = z.infer<typeof api.scannerTicketType>;
export type ScanRecord = z.infer<typeof api.scanRecord>;
export type UploadResponse = z.infer<typeof api.hubScansResponse>;
export type DeviceDirection = "entry" | "exit" | "both";
export type Direction = "entry" | "exit";

/** Everything the phone keeps about its enrolment (IndexedDB, one record). */
export interface DeviceRecord {
  deviceId: string;
  token: string;
  /** Base URL of the server the phone enrolled at ("" = the page's own origin). */
  serverUrl: string;
  /** The venue hub's address from the setup QR; null/absent when there is none. Asked first. */
  hubUrl?: string | null;
  /** The VM's address: where a scan goes when the hub does not answer. Absent = `serverUrl`. */
  cloudUrl?: string | null;
  gate: string;
  direction: DeviceDirection;
  label: string | null;
  bundle: KeyBundle;
  /** Server time minus device time at the last sync, in seconds. */
  clockOffset: number;
  /** `(updated_at, id)` ticket cursor on the hub (or the only server); null = full sync still needed. */
  cursor: string | null;
  /** The same cursor on the VM. The two servers stamp rows with their own clocks, so each has its own. */
  cloudCursor?: string | null;
  /** True once a complete ticket sync has finished; scanning stays locked until then. */
  synced: boolean;
  ticketTypes: ScannerTicketType[];
  /** Staff and their argon2id PIN hashes from the last sync: offline login checks against these. */
  staff?: OfflineStaff[];
  /** Offline devices admit only tickets whose signed gate list names this gate. */
  offlineGateOnly?: boolean;
  /** Set when the event is over and the keys and ticket list were wiped (the outbox may remain). */
  ended?: boolean;
}

export interface OfflineStaff {
  id: string;
  name: string;
  role: StaffSession["role"];
  pinHash: string;
}

export interface StaffSession {
  id: string;
  name: string;
  role: "staff" | "supervisor" | "admin";
}

/** A scan decided on the phone, waiting for the hub or the VM to acknowledge it. */
export type OutboxScan = ScanRecord;

/** Local persistence. IndexedDB in the browser, an in-memory twin in tests. */
export interface ScannerStore {
  getDevice(): Promise<DeviceRecord | undefined>;
  setDevice(device: DeviceRecord): Promise<void>;
  /** Deletes the device, every ticket and the outbox (revocation, re-enrolment). */
  wipe(): Promise<void>;
  /** Deletes the ticket list but keeps the device and the outbox (after the event). */
  wipeTickets(): Promise<void>;
  putTickets(tickets: SyncTicket[]): Promise<void>;
  getTicket(idHex: string): Promise<SyncTicket | undefined>;
  ticketCount(): Promise<number>;
  /** Name substring (case-insensitive) or the last hex characters of the ticket id. */
  searchTickets(query: string, limit?: number): Promise<SyncTicket[]>;
  /** An offline decision: the new ticket state and its outbox record, written together. */
  commitOffline(ticket: SyncTicket, scan: OutboxScan): Promise<void>;
  /** Scan records not yet acknowledged, oldest first. */
  outboxBatch(limit?: number): Promise<OutboxScan[]>;
  outboxCount(): Promise<number>;
  /** Removes acknowledged scans. */
  ackOutbox(scanIds: string[]): Promise<void>;
  /** Ticket ids with scans still in the outbox: a sync must not overwrite their local state. */
  pendingTicketIds(): Promise<Set<string>>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}
