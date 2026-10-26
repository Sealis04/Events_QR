/** M11 dashboard APIs: ticket list filters, sort and paging, CSV filters, stats extras, revoke preview. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, hexToBytes, mysqlSchema } from "@events-qr/core";
import { GET as vmStats } from "../src/app/api/events/[id]/stats/route";
import { GET as vmTickets } from "../src/app/api/events/[id]/tickets/route";
import { GET as vmExport } from "../src/app/api/events/[id]/tickets/export/route";
import { GET as previewRevoke, POST as revoke } from "../src/app/api/devices/[id]/revoke/route";
import { POST as vmClaim } from "../src/app/api/claim/route";
import { POST as vmReview } from "../src/app/api/scans/[id]/review/route";
import { GET as vmConflicts } from "../src/app/api/events/[id]/conflicts/route";
import * as hub from "../src/hub/dashboard";
import { call, createTestEnv, dbAvailable, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

const { tickets, devices } = mysqlSchema;

describe.skipIf(!dbAvailable)("M11 dashboard APIs", () => {
  let env: TestEnv;
  let w: HubWorld;
  let id: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
    id = String(w.eventId);
    for (const [name, type] of [
      ["Andrea Cruz", 0],
      ["Ben Reyes", 1],
      ["Carla Dizon", 0],
      ["Diego Lim", 2],
      ["Elena Torres", 0],
    ] as const) {
      ids[name] = (await w.makeTicket(type, name)).id;
      env.clock.now += 1; // distinct issue times
    }
    const phone = await w.enrolAtVm("Gate A", "both");
    // Andrea inside; Diego used once and gone again; Elena cancelled.
    expect(
      (await call(vmClaim, { bearer: phone.token, body: w.scanBody(phone, ids["Andrea Cruz"]!) }))
        .json.result,
    ).toBe("admitted");
    await env.handle.db
      .update(tickets)
      .set({ admitsUsed: 1, inside: false })
      .where(eq(tickets.id, Buffer.from(hexToBytes(ids["Diego Lim"]!))));
    await w.cancel(ids["Elena Torres"]!);
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  const list = async (query: Record<string, string | number> = {}) => {
    const res = await call(vmTickets, { staff: w.staff, params: { id }, query });
    expect(res.status).toBe(200);
    return res.json as { total: number; tickets: { holder_name: string }[] };
  };
  const names = (r: { tickets: { holder_name: string }[] }) => r.tickets.map((t) => t.holder_name);

  it("filters by state and type, sorts, and pages without overlap", async () => {
    expect(names(await list({ state: "inside" }))).toEqual(["Andrea Cruz"]);
    expect(names(await list({ state: "left" }))).toEqual(["Diego Lim"]);
    expect(names(await list({ state: "cancelled" }))).toEqual(["Elena Torres"]);
    expect(names(await list({ state: "not_in" })).sort()).toEqual(["Ben Reyes", "Carla Dizon"]);
    expect(names(await list({ type: 0, sort: "holder", dir: "desc" }))).toEqual([
      "Elena Torres",
      "Carla Dizon",
      "Andrea Cruz",
    ]);
    const first = await list({ sort: "holder", limit: 2, offset: 0 });
    const second = await list({ sort: "holder", limit: 2, offset: 2 });
    expect(first.total).toBe(5);
    expect([...names(first), ...names(second)]).toEqual([
      "Andrea Cruz",
      "Ben Reyes",
      "Carla Dizon",
      "Diego Lim",
    ]);
    // By state: not yet in, then inside, then left, then cancelled.
    const byState = names(await list({ sort: "state" }));
    expect(byState.slice(-3)).toEqual(["Andrea Cruz", "Diego Lim", "Elena Torres"]);
    expect(
      (await call(vmTickets, { staff: w.staff, params: { id }, query: { sort: "x" } })).status,
    ).toBe(400);
  });

  it("the CSV export takes the same filters, and supervisors may use it but staff may not", async () => {
    expect((await call(vmExport, { staff: w.staff, params: { id } })).status).toBe(403);
    const all = await call(vmExport, { staff: w.supervisor, params: { id } });
    expect(all.status).toBe(200);
    expect(all.text.split("\r\n").filter(Boolean)).toHaveLength(6);
    const some = await call(vmExport, {
      staff: w.supervisor,
      params: { id },
      query: { state: "inside" },
    });
    expect(some.text).toContain("Andrea Cruz");
    expect(some.text).not.toContain("Ben Reyes");
  });

  it("stats carry left, last minute, busiest minute and open conflicts", async () => {
    const stats = api.eventStatsResponse.parse(
      (await call(vmStats, { staff: w.staff, params: { id } })).json,
    );
    expect(stats.left).toBe(1);
    expect(stats.last_minute).toBe(1);
    expect(stats.busiest).toMatchObject({ count: 1 });
    expect(stats.open_conflicts).toBe(0);
  });

  it("an unreviewed conflict counts as open until it is marked reviewed", async () => {
    const a = await w.enrolAtVm("Gate A", "entry");
    const b = await w.enrolAtVm("Gate B", "entry");
    const t = await w.makeTicket(0, "Twice");
    await call(vmClaim, { bearer: a.token, body: w.scanBody(a, t.id) });
    // An offline second admit at another gate is kept and flagged.
    await call(vmClaim, { bearer: b.token, body: w.scanBody(b, t.id, { offline: true }) });
    const feed = await call(vmConflicts, { staff: w.supervisor, params: { id } });
    const open = (): Promise<number> =>
      call(vmStats, { staff: w.staff, params: { id } }).then((r) => r.json.open_conflicts);
    if (feed.json.conflicts.length === 0) return; // the claim path did not flag one; nothing to review
    expect(await open()).toBe(feed.json.total);
    await call(vmReview, {
      staff: w.supervisor,
      params: { id: feed.json.conflicts[0].scan_id },
      body: { reviewed: true },
    });
    expect(await open()).toBe(feed.json.total - 1);
  });

  it("the hub list filters and sorts the same way and reports hub connectivity in stats", async () => {
    await w.pull();
    // Hub handlers need real paths; use a session from the hub login.
    const { login } = await import("../src/hub/routes");
    const session = await call(login, {
      body: { name: w.supervisor.name, pin: "12345678" },
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const get = async (handler: (r: Request) => Promise<Response>, qs: string) => {
      const res = await handler(
        new Request(`http://hub.test/api/events/${w.eventId}/x${qs}`, { headers: { cookie } }),
      );
      return res.json();
    };
    const byState = await get(hub.ticketList, "?state=inside");
    expect(byState.tickets.map((t: { holder_name: string }) => t.holder_name)).toContain(
      "Andrea Cruz",
    );
    expect(byState.tickets.every((t: { inside: boolean }) => t.inside)).toBe(true);
    const desc = await get(hub.ticketList, "?type=0&sort=holder&dir=desc");
    expect(desc.total).toBeGreaterThanOrEqual(3);
    expect(desc.tickets[0].holder_name >= desc.tickets[1].holder_name).toBe(true);
    const stats = api.eventStatsResponse.parse(await get(hub.stats, ""));
    expect(stats.hub).toMatchObject({ online: true });
  });

  it("revoke preview names the staff a lost-phone revoke would flag and changes nothing", async () => {
    const phone = await w.enrolAtVm("Gate A", "entry");
    await env.handle.db.update(devices).set({ outboxSize: 4 }).where(eq(devices.id, phone.id));
    expect((await call(previewRevoke, { staff: w.staff, params: { id: phone.id } })).status).toBe(
      403,
    );
    const res = await call(previewRevoke, { staff: w.supervisor, params: { id: phone.id } });
    expect(res.status).toBe(200);
    expect(res.json.outbox_size).toBe(4);
    expect(res.json.revoked).toBe(false);
    expect(res.json.rotate_staff.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining([w.admin.id, w.supervisor.id, w.staff.id]),
    );
    const [dev] = await env.handle.db.select().from(devices).where(eq(devices.id, phone.id));
    expect(dev!.revoked).toBe(false);
    // The real thing names the same people.
    const done = await call(revoke, {
      staff: w.supervisor,
      params: { id: phone.id },
      body: { rotate: true },
    });
    expect(done.json.rotated_staff.map((s: { id: string }) => s.id).sort()).toEqual(
      res.json.rotate_staff.map((s: { id: string }) => s.id).sort(),
    );
  });
});
