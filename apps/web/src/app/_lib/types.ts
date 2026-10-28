export type Role = "staff" | "supervisor" | "admin";
export const RANK: Record<Role, number> = { staff: 1, supervisor: 2, admin: 3 };

export interface Me {
  id: string;
  name: string;
  role: Role;
  pin_reset: "weak" | "rotate" | "admin" | null;
  mode: "server" | "hub";
  /** The server's own zone (VM only): the default for a new event. */
  default_timezone?: string;
}

export interface TicketType {
  idx: number;
  name: string;
  capacity: number | null;
  issued: number;
  entry_rule: { mode: "single" | "unlimited" | "limited"; max_admits: number | null };
  gate_mask: number;
  slots: { start: number; end: number }[];
  early_entry_min: number;
}

export interface EventView {
  id: number;
  name: string;
  venue: string | null;
  timezone: string;
  starts_at: number;
  ends_at: number;
  gates: string[];
  day_zero: number;
  offline_gate_only: boolean;
  ticket_types: TicketType[];
}

export interface EventSummary {
  id: number;
  name: string;
  venue: string | null;
  starts_at: number;
  ends_at: number;
  gates: string[];
  timezone?: string | null;
  ticket_type_count: number;
  issued: number;
  /** Total places, or null when some ticket type has no limit. */
  capacity: number | null;
  inside: number;
  device_count: number;
}

export interface TicketRow {
  ticket_id: string;
  short_id: string;
  holder_name: string | null;
  holder_email: string | null;
  holder_phone?: string | null;
  ticket_type: number;
  status: "valid" | "used_up" | "cancelled";
  admits_used: number;
  inside: boolean;
  issued_at: number;
  updated_at: number;
}

export interface Issued {
  ticket_id: string;
  holder_name: string | null;
  ticket_type: number;
  short_id: string;
  qr_png: string;
}
