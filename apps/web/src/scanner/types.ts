import type { z } from "zod";
import type { api } from "@events-qr/core";

export type KeyBundle = z.infer<typeof api.keyBundle>;
export type SyncTicket = z.infer<typeof api.syncTicket>;
export type ClaimResponse = z.infer<typeof api.claimResponse>;
export type ExitResponse = z.infer<typeof api.exitResponse>;
export type SyncResponse = z.infer<typeof api.hubSyncResponse>;
export type ScannerTicketType = z.infer<typeof api.scannerTicketType>;
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
}

export interface StaffSession {
  id: string;
  name: string;
  role: "staff" | "supervisor" | "admin";
}

export interface OutboxScan {
  scan_id: string;
  [key: string]: unknown;
}

/** Local persistence. IndexedDB in the browser, an in-memory twin in tests. */
export interface ScannerStore {
  getDevice(): Promise<DeviceRecord | undefined>;
  setDevice(device: DeviceRecord): Promise<void>;
  /** Deletes the device, every ticket and the outbox (revocation, re-enrolment). */
  wipe(): Promise<void>;
  putTickets(tickets: SyncTicket[]): Promise<void>;
  getTicket(idHex: string): Promise<SyncTicket | undefined>;
  ticketCount(): Promise<number>;
  /** Name substring (case-insensitive) or the last hex characters of the ticket id. */
  searchTickets(query: string, limit?: number): Promise<SyncTicket[]>;
  /** Scan records not yet acknowledged. Written from M5 on. */
  outboxCount(): Promise<number>;
}
