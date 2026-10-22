/**
 * `APP_MODE=hub` serves only the scanner-facing API from SQLite (src/hub). Read at call time, so
 * the same build runs either way and tests can switch it.
 */
export const isHubMode = (): boolean => process.env.APP_MODE === "hub";

type RouteHandler = (req: Request, routeCtx: never) => Promise<Response>;
type HubHandler = (req: Request) => Promise<Response>;

const notFoundResponse = () =>
  new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

/** Picks the VM or the hub implementation of one route when the request arrives. */
export function byMode<V extends RouteHandler>(vm: V, hub: () => Promise<HubHandler>): V {
  return (async (req: Request, routeCtx: never) =>
    isHubMode() ? (await hub())(req) : vm(req, routeCtx)) as V;
}

/** A route that exists only on a hub (the VM answers 404). */
export function hubModeOnly(hub: () => Promise<HubHandler>): HubHandler {
  return async (req) => (isHubMode() ? (await hub())(req) : notFoundResponse());
}
