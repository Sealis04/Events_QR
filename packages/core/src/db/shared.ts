/**
 * Column vocabulary shared by the MariaDB and SQLite schemas. Both dialect files are written
 * against these constants, and test/db.test.ts asserts they define identical tables and columns.
 * Times are Unix seconds UTC (event-local slot times live in the signed QR as minutes).
 */
import { ENTRY_MODES } from "../rules/entryRule";

export { ENTRY_MODES };
export const TICKET_STATUSES = ["valid", "used_up", "cancelled"] as const;
export const DIRECTIONS = ["entry", "exit"] as const;
export const DEVICE_DIRECTIONS = ["entry", "exit", "both"] as const;
/** A device row is a scanner phone or a venue hub (the hub authenticates to the VM like a device). */
export const DEVICE_KINDS = ["scanner", "hub"] as const;
export const STAFF_ROLES = ["staff", "supervisor", "admin"] as const;
export const SCAN_RESULTS = [
  "admitted",
  "exited",
  "rejected_used",
  "rejected_inside",
  "rejected_gate",
  "rejected_slot",
  "rejected_invalid",
  "override",
] as const;
export const EMAIL_STATUSES = ["pending", "sending", "sent", "failed"] as const;
/** The eight steps of the hub setup checklist (M12), in the order the page shows them. */
export const HUB_CHECK_STEPS = [
  "hub_running",
  "dns_record",
  "certificate",
  "link_hub",
  "local_dns",
  "data_match",
  "phone_via_hub",
  "offline_scan",
] as const;
export const HUB_CHECK_RESULTS = ["pass", "warn", "fail", "skipped"] as const;
/** Where a check ran: on the VM or on the hub's own dashboard. */
export const HUB_CHECK_SOURCES = ["vm", "hub"] as const;

export const TICKET_ID_BYTES = 16;
export const NONCE_BYTES = 12;

export type TicketStatusValue = (typeof TICKET_STATUSES)[number];
export type ScanResultValue = (typeof SCAN_RESULTS)[number];

/** `'a','b'` for use inside a CHECK ... IN (...) constraint. */
export const sqlList = (values: readonly string[]): string =>
  values.map((v) => `'${v}'`).join(", ");
