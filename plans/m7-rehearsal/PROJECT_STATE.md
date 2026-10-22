# Project state — m7-rehearsal

- M1–M6 merged (#1, #3, #4, #6, #7, #10). The whole v1 app exists: VM server + worker, scanner PWA, venue hub, offline mode, dashboard on VM and hub, retention job.
- M6 notes: existing supervisors/admins are flagged for a PIN check after upgrade; Revoke and rotate forces PIN changes for everyone tied to the event; hub attendee search is by name / last 6 hex only; conflict review is VM-only.
- Never yet tested for real: Docker images, Let's Encrypt via Cloudflare DNS-01, router DNS override, Gmail delivery, timing on real phones. The field test and M8's setup guide cover these.
- This branch: runbook, field test, rehearsal seed script. Next: M8 step-by-step setup guide.
