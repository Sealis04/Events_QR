import { eq } from "drizzle-orm";
import type { ZodType, ZodTypeDef } from "zod";
import { sqliteSchema } from "@events-qr/core";
import type { AuthedDevice } from "../server/auth";
import { badRequest, HttpError, json } from "../server/errors";
import { safeEqual, sha256Hex } from "../server/secrets";
import { getHubContext, type HubContext } from "./context";

const { devices } = sqliteSchema;

/** Device bearer tokens look like `<device id>.<secret>`; only the SHA-256 of the whole token is stored. */
export function authenticateHubDevice(ctx: HubContext, req: Request): AuthedDevice | undefined {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return undefined;
  const token = header.slice(7).trim();
  const deviceId = token.split(".")[0];
  if (!deviceId || deviceId.length !== 36) return undefined;
  const row = ctx.db.select().from(devices).where(eq(devices.id, deviceId)).get();
  if (!row || row.revoked || row.kind !== "scanner" || !safeEqual(row.tokenHash, sha256Hex(token)))
    return undefined;
  const now = ctx.now();
  // A write per request would queue behind the claims: refresh the timestamp at most every 30 s.
  if (row.lastSeenAt === null || now - row.lastSeenAt >= 30) {
    ctx.db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.id)).run();
  }
  return {
    id: row.id,
    eventId: row.eventId,
    gate: row.gate,
    direction: row.direction,
    label: row.label,
    kind: "scanner",
  };
}

export interface HubRouteArgs<B, Q> {
  req: Request;
  ctx: HubContext;
  device: AuthedDevice;
  body: B;
  query: Q;
}

export interface HubRouteOptions<B, Q> {
  access: "public" | "device";
  body?: ZodType<B, ZodTypeDef, unknown>;
  query?: ZodType<Q, ZodTypeDef, unknown>;
}

/** The hub twin of `route()`: same JSON errors, same validation, SQLite context, device auth only. */
export function hubRoute<B = undefined, Q = undefined>(
  options: HubRouteOptions<B, Q>,
  handler: (args: HubRouteArgs<B, Q>) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const ctx = await getHubContext();
      let device: AuthedDevice | undefined;
      if (options.access === "device") {
        device = authenticateHubDevice(ctx, req);
        if (!device) throw new HttpError(401, "unauthenticated", "device token required");
      }

      let body: unknown;
      if (options.body) {
        if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
          throw new HttpError(415, "unsupported_media_type", "send application/json");
        }
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          throw badRequest("body is not valid JSON");
        }
        const parsed = options.body.safeParse(raw);
        if (!parsed.success) throw badRequest("invalid body", parsed.error.issues);
        body = parsed.data;
      }

      let query: unknown;
      if (options.query) {
        const parsed = options.query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
        if (!parsed.success) throw badRequest("invalid query", parsed.error.issues);
        query = parsed.data;
      }

      return await handler({
        req,
        ctx,
        device: device as AuthedDevice,
        body: body as B,
        query: query as Q,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return json(
          { error: { code: err.code, message: err.message, details: err.details } },
          err.status,
        );
      }
      console.error(err);
      return json({ error: { code: "internal", message: "internal error" } }, 500);
    }
  };
}
