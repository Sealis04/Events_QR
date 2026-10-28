import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, both for the scanner PWA:
 *
 * 1. CORS on the scanner-facing API. The phone loads the page from one server (usually the hub)
 *    and also calls the other (the VM) when the hub does not answer, so the calls are cross-origin.
 *    They carry a bearer token and no cookies, so any origin may call them.
 * 2. On a venue hub (`APP_MODE=hub`), everything but the scanner, its API and the read-only
 *    dashboard answers 404: the issuance, staff and sync routes need the signing key or MariaDB.
 */
const SCANNER_API = new Set([
  "/api/claim",
  "/api/exit",
  "/api/sync",
  "/api/health",
  "/api/enroll",
  "/api/scans",
  "/api/devices/enroll",
  "/api/auth/login",
  "/api/devices/heartbeat",
]);

/**
 * What a hub also serves besides the scanner API: the read-only dashboard (same pages and URLs as
 * the VM, so the UI code is shared) and the supervisor's manual admit. Routes that do not exist
 * on a hub (issuance, setup, cancellation) answer 404 from their own handlers.
 */
const HUB_DASHBOARD = [
  /^\/$/,
  /^\/login$/,
  /^\/events(\/.*)?$/,
  /^\/api\/auth\/(logout|me)$/,
  /^\/api\/hub\/pull$/,
  /^\/api\/events$/,
  /^\/api\/events\/\d+(\/(stats|conflicts|devices|tickets|admit|overrides|hub-setup(\/checks)?))?$/,
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const scannerApi = SCANNER_API.has(pathname);

  if (
    process.env.APP_MODE === "hub" &&
    !scannerApi &&
    !HUB_DASHBOARD.some((re) => re.test(pathname))
  ) {
    return new NextResponse(
      JSON.stringify({ error: { code: "not_found", message: "not found" } }),
      {
        status: 404,
        headers: { "content-type": "application/json" },
      },
    );
  }
  if (!scannerApi) return NextResponse.next();

  if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: CORS });
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

export const config = {
  // Static assets, the scanner shell and its service worker are never intercepted.
  matcher: ["/api/:path*", "/", "/login", "/events/:path*"],
};
