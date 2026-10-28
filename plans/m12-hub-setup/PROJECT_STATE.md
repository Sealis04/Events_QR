# Project state — m12-hub-setup

- M1–M11 merged (#1, #3, #4, #6, #7, #10, #13, #14, #15, #16, #17). M11 refreshed the UI (mockups in `plans/m11-ui-refresh/mockups/`), made the phone login last until 05:00 event-local or event end, and rewrote setup guide 4.6 for any router (hub `dns` service, `HUB_DNS_BIND`).
- A hub is a `devices` row of kind `hub` for one event; it is linked with a hub setup code (`/api/hubs/setup`) and `scripts/hub-enroll.ts`.
- User decisions 2026-10-26: in-app hub setup checklist with live checks, for the IT person, in two parts (office with internet, venue Wi-Fi); fix the New event sticky bar to match the mockup.
