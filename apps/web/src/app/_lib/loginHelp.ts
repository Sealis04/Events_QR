/**
 * Why the login call worked but no session followed. Over plain http on anything but localhost
 * the browser drops the Secure session cookie (the hub's is Secure in production); otherwise a
 * venue hub only lets supervisors and admins in.
 */
export function noSessionMessage(location: { protocol: string; hostname: string }): string {
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol === "http:" && !local)
    return "Open this page with https:// — over plain http the browser drops the login.";
  return "This server only lets supervisors and admins into the dashboard.";
}
