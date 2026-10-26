import { z } from "zod";

/** What the ticket list shows per row (M11): derived from status, `inside` and `admits_used`. */
export const TICKET_STATES = ["not_in", "inside", "left", "cancelled"] as const;
export const TICKET_SORTS = ["holder", "type", "state", "issued"] as const;

/** Shared by the VM list, the hub list and the CSV export, so the same filters mean the same rows. */
export const ticketFilterQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["valid", "used_up", "cancelled"]).optional(),
  state: z.enum(TICKET_STATES).optional(),
  type: z.coerce.number().int().min(0).max(255).optional(),
});

export const ticketListQuery = ticketFilterQuery.extend({
  sort: z.enum(TICKET_SORTS).default("issued"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type TicketFilter = z.infer<typeof ticketFilterQuery>;
export type TicketListQuery = z.infer<typeof ticketListQuery>;

/** The search text, split into what a LIKE needs and the hex tail of a ticket code (when the text could be one). */
export function searchTerms(q: string | undefined): { like: string; hex: string | null } | null {
  const text = q?.trim();
  if (!text) return null;
  const hex = text.toUpperCase().replace(/[^0-9A-F]/g, "");
  return {
    like: "%" + text.replace(/[%_\\]/g, "\\$&") + "%",
    hex: hex.length === text.length && hex.length >= 4 ? hex : null,
  };
}
