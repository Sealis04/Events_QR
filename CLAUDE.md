# Events_QR

Offline QR ticketing for 500–5,000-person events. Signed, encrypted QR tickets; a venue hub enforces one-time entry with no internet.

- Plan (source of truth for scope and stack): `plans/offline-qr-ticketing/plan.md`
- Spec (formats, rules, SQL): `docs/spec.md` (exported from https://claude.ai/artifact/FWS1zsJVNcFkvLe8wwf2Q7) — where it differs from the plan, the plan wins.

## Stack

Next.js (App Router, TypeScript strict), MariaDB on a self-hosted VM, SQLite on the venue hub, Drizzle ORM, libsodium + WebCrypto, Vitest. Package manager and runner: **bun** (workspaces).

```
packages/core   token lib, setup-QR codec, entry/claim rules, zod schemas, Drizzle schema
apps/web        Next.js app: server mode, hub mode, admin + scanner routes
apps/worker     email queue, sync loops, retention job
docker/         compose files for the VM and the hub
```

## Commands

```
bun install
bun run lint          # ESLint + Prettier check
bunx tsc --noEmit     # typecheck (root tsconfig with project references)
bun run test          # Vitest across all workspaces
bun dev               # Next.js dev server on :3000 (from M2 on)
setup.bat             # Windows: guided setup (web app or hub, dev or prod), writes .env
```

Test copy on the VM (separate Docker project `events-qr-test`, Mailpit instead of Gmail, red TEST banner): `docker/compose.test.yml`, `scripts/test-reset.ts`, `docs/test-setup.md` (section 5: on a Windows PC behind a Cloudflare Tunnel, `--profile tunnel`).

## Conventions

- `packages/core` must run in Node and browsers: no `fs`, `crypto` (Node), `Buffer` or other Node-only imports. Use `Uint8Array`, WebCrypto and libsodium-wrappers.
- Binary layouts follow the spec byte for byte (big-endian integers). Every format change bumps `version`.
- Times: store Unix seconds UTC. Event-local times (time slots) are minutes from 00:00 local on the event's first day, as in the spec.
- No secrets in the repo: signing key file, passphrases, Gmail service-account JSON, Cloudflare token and DB passwords come from env or mounted files. `.env*` is gitignored except `.env.demo`.
- Each change keeps lint, typecheck and tests green.
- Roles in this app: staff, supervisor, admin. Scanner devices have a role of entry, exit or both.

## Sandbox / Claude-on-the-web setup

`scripts/ccr-session-init.sh` prepares a session: installs bun deps, starts MariaDB if installed, and writes `.env` from `.env.demo`. This project does **not** use SQL Server or Prisma; skip any step that mentions them. There are no demo-account seeds until M2.

## Agent Team Protocol

One builder (builder-1), sequential mode, plus the reviewer. Builder-3 is NOT USED.

- Each milestone gets a feature branch from `main` named `mN-<slug>` (e.g. `m1-core-tokens`), created by the planner.
- `plans/<branch>/INBOX.md` — active builders and the reviewer's report (`## reviewer`) and notes to the planner (`## planner`).
- `plans/<branch>/inbox/builder-1.md` — builder-1's tasks, status, owned files, summary and fix requests.
- `plans/<branch>/PROJECT_STATE.md`, `plans/<branch>/HANDOFF.md` — context; read only for builders.
- Builder-1 works directly on `<branch>`. `<branch>--builder-1` exists only as the conflict fallback.
- Inbox convention: statuses are PENDING, DONE, BLOCKED, FALLBACK, NOT USED. Use `git add -f` for files under `plans/`.
- Push procedure: `git pull --rebase origin <branch>`, rerun `bunx tsc --noEmit`, `git push origin <branch>`; repeat if rejected as non-fast-forward.
- When the reviewer approves a milestone it opens a PR from `<branch>` to `main`. The planner sets up the next milestone's branch and fires builder-1 again.
