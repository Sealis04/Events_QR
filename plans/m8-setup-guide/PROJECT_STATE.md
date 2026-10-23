# Project state — m8-setup-guide

- M1–M7 merged (#1, #3, #4, #6, #7, #10, #13). The v1 app is complete; `docs/runbook.md`, `docs/field-test.md` and `scripts/rehearsal-seed.ts` exist.
- Still never tested for real: Docker image builds, Let's Encrypt via Cloudflare DNS-01, router DNS override, Gmail delivery, timing on real phones.
- User decisions 2026-10-23: "Set up again" must wipe the phone (follow-up to #12); add a "Pull tickets now" button to the hub dashboard instead of restarting the worker.
- This branch: those two fixes, then `docs/setup-guide.md` for a first install from zero.
