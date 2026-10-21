import type { ZodType, ZodTypeDef } from "zod";
import { getContext, type AppContext } from "./context";
import {
  authenticateDevice,
  authenticateStaff,
  hasRole,
  type AuthedDevice,
  type AuthedStaff,
} from "./auth";
import type { StaffRole } from "./auth";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "invalid_request", message, details);
export const notFound = (what = "not found") => new HttpError(404, "not_found", what);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export type Access = "public" | "device" | { staff: StaffRole };

export interface RouteArgs<B, Q> {
  req: Request;
  ctx: AppContext;
  staff: AuthedStaff;
  device: AuthedDevice;
  body: B;
  query: Q;
  params: Record<string, string>;
}

export interface RouteOptions<B, Q> {
  access: Access;
  body?: ZodType<B, ZodTypeDef, unknown>;
  query?: ZodType<Q, ZodTypeDef, unknown>;
}

type RouteContext = { params: Promise<Record<string, string>> };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Cookie-authenticated writes must come from our own origin (on top of SameSite=Lax). */
function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "bad_origin", "bad origin");
  }
  if (host && originHost !== host)
    throw new HttpError(403, "bad_origin", "cross-origin request refused");
}

/**
 * Wraps a route handler: resolves the context, authenticates by role, validates JSON body and
 * query with zod, and turns thrown HttpErrors into JSON errors. Handlers are plain
 * `(Request, {params}) => Response`, so tests call them directly.
 */
export function route<B = undefined, Q = undefined>(
  options: RouteOptions<B, Q>,
  handler: (args: RouteArgs<B, Q>) => Promise<Response>,
): (req: Request, routeCtx: RouteContext) => Promise<Response> {
  return async (req, routeCtx) => {
    try {
      const ctx = await getContext();
      let staff: AuthedStaff | undefined;
      let device: AuthedDevice | undefined;

      if (options.access === "device") {
        device = await authenticateDevice(ctx, req);
        if (!device) throw new HttpError(401, "unauthenticated", "device token required");
      } else if (options.access !== "public") {
        staff = await authenticateStaff(ctx, req);
        if (!staff) throw new HttpError(401, "unauthenticated", "log in first");
        if (MUTATING.has(req.method)) assertSameOrigin(req);
        if (!hasRole(staff.role, options.access.staff)) {
          throw new HttpError(403, "forbidden", `requires ${options.access.staff}`);
        }
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
        staff: staff as AuthedStaff,
        device: device as AuthedDevice,
        body: body as B,
        query: query as Q,
        params: (await routeCtx.params) ?? {},
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

/** For routes whose access depends on the body (e.g. `/devices/enroll`). */
export async function requireStaff(
  ctx: AppContext,
  req: Request,
  need: StaffRole,
): Promise<AuthedStaff> {
  const staff = await authenticateStaff(ctx, req);
  if (!staff) throw new HttpError(401, "unauthenticated", "log in first");
  if (MUTATING.has(req.method)) assertSameOrigin(req);
  if (!hasRole(staff.role, need)) throw new HttpError(403, "forbidden", `requires ${need}`);
  return staff;
}

export function intParam(params: Record<string, string>, name: string): number {
  const value = params[name];
  if (!value || !/^\d{1,10}$/.test(value)) throw badRequest(`bad ${name}`);
  return Number(value);
}

export function hexParam(params: Record<string, string>, name: string): string {
  const value = params[name]?.toLowerCase();
  if (!value || !/^[0-9a-f]{32}$/.test(value)) throw badRequest(`bad ${name}`);
  return value;
}
