# M11 mockups

Approved by the user on 2026-10-26. Exported from the design canvas https://claude.ai/artifact/5FmnJtFjb4RqeNZ28DDfq1 (private to the user; these files are the copy for builders).

Each `.dc.html` file is one screen as static HTML with inline styles (the `support.js` script and the `<x-dc>` / `data-dc-script` wrappers belong to the design tool; ignore them). Read the markup for layout, wording, sizes and colours. Names, venues, numbers and dates in them are sample data.

| File | Screen | Size |
|---|---|---|
| `Main.dc.html` | New event (and the look for Setup), desktop | page |
| `Phone.dc.html` | New event on a phone | 390 wide |
| `ScanReady.dc.html` | Gate phone, ready to scan | 390×844 |
| `ScanGreen.dc.html` | Gate phone, admitted | 390×844 |
| `ScanRed.dc.html` | Gate phone, refused (already used) | 390×844 |
| `ScanMenu.dc.html` | Gate phone ⋯ menu with the "set up again" confirm | 390×844 |
| `Events.dc.html` | Events list | page |
| `Tickets.dc.html` | Event page, Tickets tab with the row menu open | page |
| `TicketsPhone.dc.html` | Tickets on a phone (hub dashboard) | 390×844 |
| `Live.dc.html` | Live stats | page |
| `Devices.dc.html` | Devices tab with the revoke dialog | page |

Design tokens used throughout: font Inter (fall back to system-ui); page ground `#f4f5f7`; cards white, border `#e3e6eb`, radius 14; text `#111827`, muted `#5b6472`; primary `#2457d6`; chips `#eef2fb` / `#1e3a8a`; inputs 44 px tall, radius 10; danger `#b42318`. Scanner: ground `#0b0f17`, admitted `#0f7a3a`, refused `#a61b1b`.
