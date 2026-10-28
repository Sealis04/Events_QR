"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog, FormDialog } from "../../_components/Dialog";
import { Menu, type MenuItem } from "../../_components/Menu";
import { Notice, Shell } from "../../_components/Shell";
import { api, formatTime } from "../../_lib/client";
import { RANK, type Me, type Role } from "../../_lib/types";

interface StaffItem {
  id: string;
  name: string;
  role: Role;
  status: "active" | "must_change_pin" | "deactivated";
  events: { id: number; name: string }[];
  created_at: number | null;
  changed_at: number | null;
}
interface StaffList {
  staff: StaffItem[];
  active_admins: number;
}
interface LogEntry {
  id: number;
  at: number;
  actor: { id: string; name: string } | null;
  action: string;
  target: { kind: string; id: string; name: string | null };
  detail: Record<string, string | number | boolean | null> | null;
}
interface LogPage {
  entries: LogEntry[];
  next_before: number | null;
}

type Filter = "all" | "active" | "deactivated";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "deactivated", label: "Deactivated" },
];
const ROLES: Role[] = ["staff", "supervisor", "admin"];
const PIN_RULE: Record<Role, string> = {
  staff: "At least 6 characters.",
  supervisor: "At least 8 digits.",
  admin: "At least 8 digits.",
};
const STATUS = {
  active: { label: "Active", tone: "ok" },
  must_change_pin: { label: "Must change PIN", tone: "warn" },
  deactivated: { label: "Deactivated", tone: "bad" },
} as const;

function describe(e: LogEntry): string {
  const who = e.target.name ?? "an account";
  const d = e.detail ?? {};
  switch (e.action) {
    case "staff.created":
      return `created ${who} as ${d.role ?? "staff"}`;
    case "staff.role_changed":
      return `changed ${who} from ${d.from} to ${d.to}`;
    case "staff.pin_reset":
      return `reset the PIN of ${who}`;
    case "staff.deactivated":
      return `deactivated ${who}`;
    case "staff.reactivated":
      return `reactivated ${who}`;
    case "staff.recovered":
      return `recovered ${who}${d.was_deactivated ? " (reactivated)" : ""}`;
    default:
      return `${e.action} on ${who}`;
  }
}

type Action =
  | { kind: "role"; who: StaffItem }
  | { kind: "pin"; who: StaffItem }
  | { kind: "deactivate"; who: StaffItem }
  | { kind: "create" };

function StaffPage({ me }: { me: Me }) {
  const [list, setList] = useState<StaffList>();
  const [log, setLog] = useState<LogPage>();
  const [filter, setFilter] = useState<Filter>("all");
  const [action, setAction] = useState<Action>();
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string }>();

  const load = useCallback(async () => {
    try {
      const [l, g] = await Promise.all([
        api<StaffList>("/api/staff"),
        api<LogPage>("/api/staff/log"),
      ]);
      setList(l);
      setLog(g);
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed to load" });
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function more() {
    if (!log?.next_before) return;
    try {
      const next = await api<LogPage>(`/api/staff/log?before=${log.next_before}`);
      setLog({ entries: [...log.entries, ...next.entries], next_before: next.next_before });
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed to load" });
    }
  }

  async function patch(who: StaffItem, body: unknown, done: string) {
    await api(`/api/staff/${who.id}`, { method: "PATCH", body });
    setMsg({ tone: "ok", text: done });
    await load();
  }

  const rows = (list?.staff ?? [])
    .filter((s) => filter === "all" || (filter === "deactivated") === (s.status === "deactivated"))
    .sort(
      (a, b) =>
        Number(a.status === "deactivated") - Number(b.status === "deactivated") ||
        a.name.localeCompare(b.name),
    );

  function menuFor(s: StaffItem): MenuItem[] {
    if (s.status === "deactivated")
      return [
        {
          label: "Reactivate",
          onSelect: () =>
            void patch(s, { active: true }, `${s.name} can log in again.`).catch((err) =>
              setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" }),
            ),
        },
      ];
    const isSelf = s.id === me.id;
    const lastAdmin = s.role === "admin" && list?.active_admins === 1;
    const why = isSelf
      ? "You cannot do this to your own account."
      : lastAdmin
        ? "This is the only active admin."
        : undefined;
    return [
      {
        label: "Change role",
        onSelect: () => setAction({ kind: "role", who: s }),
        disabled: !!why,
        reason: why,
      },
      { label: "Reset PIN", onSelect: () => setAction({ kind: "pin", who: s }) },
      {
        label: "Deactivate",
        danger: true,
        onSelect: () => setAction({ kind: "deactivate", who: s }),
        disabled: !!why,
        reason: why,
      },
    ];
  }

  return (
    <>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {list?.active_admins === 1 && (
        <div className="notice warn" role="status" data-testid="one-admin">
          <div className="between" style={{ flexWrap: "wrap", gap: 8 }}>
            <span>
              Only one admin. If they forget their PIN, recovery needs server access (setup guide
              1.7). Add a second admin.
            </span>
            <button
              type="button"
              className="small"
              style={{ whiteSpace: "nowrap" }}
              onClick={() => setAction({ kind: "create" })}
            >
              Add an admin
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="between">
          <h3>Accounts</h3>
          <button type="button" onClick={() => setAction({ kind: "create" })}>
            Create account
          </button>
        </div>
        <p className="muted">
          One account works on every event. Assign people to an event on that event&apos;s Setup
          tab.
        </p>
        <div className="chips" role="group" aria-label="Show accounts">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className="chip"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table data-testid="staff-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Events</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} data-testid="staff-row" data-name={s.name}>
                  <td>
                    {s.name}
                    {s.id === me.id && <span className="muted"> (you)</span>}
                  </td>
                  <td>{s.role}</td>
                  <td>
                    <span className={`tag ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
                  </td>
                  <td title={s.events.map((e) => e.name).join(", ")}>
                    {s.events.length === 0
                      ? "none"
                      : s.events.length === 1
                        ? s.events[0]!.name
                        : `${s.events.length} events`}
                  </td>
                  <td>
                    <Menu label={`Actions for ${s.name}`} items={menuFor(s)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>History</h3>
        {log?.entries.length === 0 && <p className="muted">Nothing logged yet.</p>}
        <ul className="plain" data-testid="staff-log">
          {log?.entries.map((e) => (
            <li key={e.id} className="small">
              <span className="muted">{formatTime(e.at)}</span>{" "}
              <strong>{e.actor?.name ?? "server command"}</strong> {describe(e)}
            </li>
          ))}
        </ul>
        {log?.next_before && (
          <button type="button" className="secondary" onClick={() => void more()}>
            Show older
          </button>
        )}
      </div>

      {action?.kind === "create" && (
        <CreateDialog
          onClose={() => setAction(undefined)}
          onCreated={(name) => {
            setMsg({ tone: "ok", text: `Created ${name}. Their PIN works right away.` });
            return load();
          }}
        />
      )}
      {action?.kind === "role" && (
        <FormDialog
          title={`Change role of ${action.who.name}`}
          submitLabel="Change role"
          onClose={() => setAction(undefined)}
          onSubmit={(f) =>
            patch(
              action.who,
              { role: String(f.get("role")) },
              `Role of ${action.who.name} changed.`,
            )
          }
        >
          <label className="field">
            Role
            <select name="role" defaultValue={action.who.role} aria-label="New role">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            A supervisor or admin PIN has at least 8 digits; if {action.who.name}&apos;s PIN is
            shorter they are asked to choose a new one at their next login.
          </p>
        </FormDialog>
      )}
      {action?.kind === "pin" && (
        <FormDialog
          title={`Reset PIN of ${action.who.name}`}
          submitLabel="Reset PIN"
          onClose={() => setAction(undefined)}
          onSubmit={(f) =>
            patch(
              action.who,
              { reset_pin: String(f.get("pin")) },
              `Temporary PIN set for ${action.who.name}.`,
            )
          }
        >
          <p className="muted">
            Type a temporary PIN and give it to {action.who.name}. At their next login they must
            choose a new PIN of their own before they can do anything else.
          </p>
          <label className="field">
            Temporary PIN
            <input
              name="pin"
              type="password"
              required
              autoComplete="new-password"
              aria-label="Temporary PIN"
              inputMode={action.who.role === "staff" ? undefined : "numeric"}
            />
            <span className="hint">{PIN_RULE[action.who.role]}</span>
          </label>
        </FormDialog>
      )}
      {action?.kind === "deactivate" && (
        <ConfirmDialog
          title={`Deactivate ${action.who.name}?`}
          confirmLabel="Deactivate"
          danger
          onClose={() => setAction(undefined)}
          onConfirm={() =>
            patch(action.who, { active: false }, `${action.who.name} was deactivated.`)
          }
        >
          <p>
            {action.who.name} loses dashboard and scanner access within about 10 seconds. Their
            tickets, scans and event assignments stay, and you can reactivate them later.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => Promise<void>;
}) {
  const [role, setRole] = useState<Role>("staff");
  return (
    <FormDialog
      title="Create account"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={async (f: FormData) => {
        const name = String(f.get("name")).trim();
        await api("/api/staff", { body: { name, pin: String(f.get("pin")), role } });
        await onCreated(name);
      }}
    >
      <label className="field">
        Name
        <input name="name" required aria-label="Name" />
      </label>
      <label className="field">
        Role
        <select
          name="role"
          value={role}
          aria-label="Role"
          onChange={(e) => setRole(e.target.value as Role)}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        PIN
        <input
          name="pin"
          type="password"
          required
          autoComplete="new-password"
          aria-label="PIN"
          inputMode={role === "staff" ? undefined : "numeric"}
        />
        <span className="hint">{PIN_RULE[role]} It works right away; no change is forced.</span>
      </label>
    </FormDialog>
  );
}

export default function Staff() {
  return (
    <Shell title="Staff" back={{ href: "/", label: "Events" }}>
      {(me) =>
        me.mode === "server" && RANK[me.role] >= RANK.admin ? (
          <StaffPage me={me} />
        ) : (
          <Notice tone="warn">Only admins on the main server can manage staff accounts.</Notice>
        )
      }
    </Shell>
  );
}
