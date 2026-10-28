# Project state — m14-hub-setup-page

- M1–M13 merged (#1, #3, #4, #6, #7, #10, #13, #14, #15, #16, #17, #18, #27).
- Today a hub is linked only by `scripts/hub-enroll.ts <VM URL> <code>` (run by hand or by `setup.bat`'s `:enroll_hub`). It calls `linkHubToVm` (`apps/web/src/hub/link.ts`), which stores `vm_url`, `hub_device_id`, `hub_token` and `bundle` in `hub_state`, then does a first pull and push.
- An unlinked hub serves its pages but has no staff, so nobody can log in; `/api/enroll` answers `hub_not_linked`; the worker (`apps/worker/src/hubMain.ts`) waits for a link.
- The hub dashboard is supervisors and admins only (`hub/dashboard.ts`), with staff and PIN hashes mirrored from the VM. The middleware (`apps/web/src/middleware.ts`) 404s everything on a hub that is not the scanner API or `HUB_DASHBOARD`.
- Wiping a hub today is `docker compose ... down -v`, and revoking its credential on the VM is a manual SQL update (`docs/deploy-hub.md` section 8).
- User decisions 2026-10-28: see the M14 section of the plan. The plan file is the source of truth.
