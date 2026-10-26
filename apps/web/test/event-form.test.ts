/** Pure helpers behind the new-event / Setup form: zone maths and ticket-type drafts. */
import { describe, expect, it } from "vitest";
import { eventDays, offsetLabel, unixFromZoned, zonedFromUnix } from "../src/app/_lib/client";
import { eventStatus } from "../src/app/_lib/status";
import {
  describeType,
  draftToInput,
  emptyDraft,
  typeToDraft,
} from "../src/app/_components/TypeFields";

describe("zone maths", () => {
  it("reads a typed date and time in the event's zone", () => {
    expect(unixFromZoned("2026-11-06T18:00", "Asia/Manila")).toBe(
      Date.UTC(2026, 10, 6, 10, 0) / 1000,
    );
    expect(unixFromZoned("2026-11-06T18:00", "UTC")).toBe(Date.UTC(2026, 10, 6, 18, 0) / 1000);
    expect(unixFromZoned("nonsense", "UTC")).toBeNaN();
  });
  it("round-trips, also across a DST change", () => {
    for (const tz of ["Asia/Manila", "America/New_York", "Europe/London"]) {
      for (const v of ["2026-03-29T12:30", "2026-11-01T23:45", "2026-06-15T00:00"]) {
        expect(zonedFromUnix(unixFromZoned(v, tz), tz)).toBe(v);
      }
    }
  });
  it("labels offsets and lists the event's days", () => {
    const at = Date.UTC(2026, 10, 6) / 1000;
    expect(offsetLabel("Asia/Manila", at)).toBe("UTC+8");
    expect(offsetLabel("Asia/Kolkata", at)).toBe("UTC+5:30");
    expect(offsetLabel("America/New_York", at)).toBe("UTC-5");
    const start = unixFromZoned("2026-11-06T18:00", "Asia/Manila");
    const end = unixFromZoned("2026-11-08T23:00", "Asia/Manila");
    expect(eventDays(start, end, "Asia/Manila").map((d) => d.label)).toEqual([
      "Fri 6 Nov",
      "Sat 7 Nov",
      "Sun 8 Nov",
    ]);
  });
});

describe("event status", () => {
  const ev = { starts_at: 1000, ends_at: 2000, ticket_type_count: 1 };
  it("tells setup, soon, live and ended apart", () => {
    expect(eventStatus({ ...ev, ticket_type_count: 0 }, 1500).key).toBe("setup");
    expect(eventStatus(ev, 1500).key).toBe("live");
    expect(eventStatus(ev, 1000 - 7 * 86400).label).toBe("IN 7 DAYS");
    expect(eventStatus(ev, 3000).key).toBe("ended");
  });
});

describe("ticket type drafts", () => {
  const days = [
    { day: 0, label: "Fri 6 Nov" },
    { day: 1, label: "Sat 7 Nov" },
  ];
  it("turns day + clock rows into minutes from the first day, and back", () => {
    const d = { ...emptyDraft(2), name: "VIP", slots: [{ day: 1, from: "18:00", until: "23:00" }] };
    const built = draftToInput(d);
    expect(built.ok && built.value.slots).toEqual([{ start: 1440 + 1080, end: 1440 + 1380 }]);
    const back = typeToDraft(
      {
        idx: 0,
        name: "VIP",
        capacity: null,
        issued: 0,
        entry_rule: { mode: "single", max_admits: null },
        gate_mask: 0,
        slots: [{ start: 2520, end: 2820 }],
        early_entry_min: 15,
      },
      2,
    );
    expect(back.slots).toEqual([{ day: 1, from: "18:00", until: "23:00" }]);
  });
  it("treats an until before the from as after midnight, and a blank until as the event end", () => {
    const night = draftToInput({
      ...emptyDraft(1),
      name: "N",
      slots: [{ day: 0, from: "22:00", until: "02:00" }],
    });
    expect(night.ok && night.value.slots).toEqual([{ start: 1320, end: 1560 }]);
    const open = draftToInput({
      ...emptyDraft(1),
      name: "O",
      slots: [{ day: 0, from: "10:00", until: "" }],
    });
    expect(open.ok && open.value.slots).toEqual([{ start: 600, end: 0xffff }]);
  });
  it("names the field that is wrong", () => {
    expect(draftToInput({ ...emptyDraft(1), name: "" })).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(draftToInput({ ...emptyDraft(1), name: "A", capacity: "0" })).toMatchObject({
      field: "capacity",
    });
    expect(
      draftToInput({ ...emptyDraft(1), name: "A", mode: "limited", maxAdmits: "1" }),
    ).toMatchObject({
      field: "maxAdmits",
    });
    expect(draftToInput({ ...emptyDraft(1), name: "A", early: "5" })).toMatchObject({
      field: "early",
    });
  });
  it("writes the sentence the editor previews", () => {
    const d = {
      ...emptyDraft(3),
      name: "VIP",
      gates: [true, false, true],
      slots: [{ day: 0, from: "18:00", until: "23:00" }],
    };
    expect(describeType(d, ["Main entrance", "North gate", "VIP lane"], days)).toBe(
      "VIP ticket gets the holder in once, through Main entrance or VIP lane, on Fri 6 Nov from 17:45 to 23:00.",
    );
  });
});
