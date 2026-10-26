# Project state — m11-ui-refresh

- M1–M10 merged (#1, #3, #4, #6, #7, #10, #13, #14, #15, #16). v1 is complete, with a test copy (VM or a Windows PC through a Cloudflare Tunnel).
- This branch starts with one planner commit: `.dockerignore` now keeps `.secrets-test` and `test-output` out of Docker images (it missed the M10 merge).
- User feedback from the test copy (2026-10-26): re-login on phones is painful; "Revoke and rotate" made the admin change their PIN (worked as designed, but too easy to hit); the UI looks rough and breaks on phones; the venue router is a TP-Link of unknown model.
- Decisions: phone login lasts until sign-out or the end of the event day, no idle timeout or biometrics for now; one Revoke with a "lost or stolen" checkbox; mobile UI has no scrollbars; hub DNS must work with any router. All four UI groups from the review (gate phone, dashboard on phones, tickets list, polish) plus the new event/ticket type redesign are in scope.
