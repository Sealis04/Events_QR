import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, both for the scanner PWA:
 *
 * 1. CORS on the scanner-facing API. The phone loads the page from one server (usually the hub)
 *    and also calls the other (the VM) when the hub does not answer, so the calls are cross-origin.
 *    They carry a bearer token and no cookies, so any origin may call them.
 * 2. On a venue hub (`APP_MODE=hub`), everything else answers 404: the admin pages and the
 *    issuance, staff and sync routes that need the signing key or MariaDB. The hub serves the
 *    scanner and the scanner-facing API only.
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
]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const scannerApi = SCANNER_API.has(pathname);

  if (process.env.APP_MODE === "hub" && !scannerApi) {
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
