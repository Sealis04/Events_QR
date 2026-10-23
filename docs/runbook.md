# Event-day runbook

Print this page and tick the boxes with a pen. It is written for the event team and the supervisor on the day, not for developers. The two quick cards at the end are made to be printed on their own and taped to a gate.

**Words used here**

- **VM**: the server in the office or cloud. It makes tickets and holds the master copy of everything. Its address looks like `https://tickets.example.org`.
- **Hub**: the small box at the venue. During the event it decides whether a ticket may enter, even with no internet. Its address looks like `https://hub.example.org`.
- **Phone**: a staff phone running the scanner page (`/scan`). It is set up for one gate and one role (Entry, Exit, or Entry and exit).
- **Dashboard**: the staff web pages (`/`). It opens on the VM before and after the event, and on the hub during it.
- **Supervisor**: a staff account with a PIN of 8 or more digits. Supervisors can open the Devices and Conflicts tabs, move phones, and admit people by hand. **Admin** is the same, plus setup and ticket changes.

**What the phone's top-right pill means** (it also shows how many scans are still waiting to be sent, for example `Hub · 0 queued`)

| Pill                  | Meaning                                                                                                                            | What you do                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Hub** (green)       | The hub answered. Normal.                                                                                                          | Nothing.                                                          |
| **Cloud-only** (blue) | The hub did not answer in time; the VM did. Safe, but the hub is not seeing this phone's scans live.                               | Tell the supervisor. Check the phone's Wi-Fi and the hub.         |
| **Offline** (orange)  | Neither answered. The phone still admits by itself and shows an orange `OFFLINE` bar; scans are saved on the phone and sent later. | Tell the supervisor. Fix the connection (see "During the event"). |

**What the phone screen means**

| Screen                                                        | Meaning                                                                                         | What you do                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Green, holder's name, `Entry 1 of 3`                          | Admitted. It clears by itself after 1.5 seconds.                                                | Wave them through.                                                                 |
| Blue, `Exit recorded`                                         | Exit logged. Clears by itself.                                                                  | Nothing.                                                                           |
| Grey, `No re-entry on this ticket`                            | A single-entry ticket was scanned at an exit.                                                   | Tell them they cannot come back in.                                                |
| Red, `Already used` / `Already inside`                        | The ticket was already admitted. The screen says where and when.                                | Do not admit. See "Already used" below.                                            |
| Red, `Use Gate B` (or other gate names)                       | Wrong gate for this ticket.                                                                     | Send them to the gate named on the screen.                                         |
| Red, `Too early – slot starts 18:00` / `Slot ended at 22:00`  | Outside the ticket's time slot.                                                                 | Ask them to come back at the time shown, or call the supervisor.                   |
| Red, `Cancelled`                                              | The ticket was cancelled.                                                                       | Do not admit. Call the supervisor.                                                 |
| Red, `Invalid / forged`, `Not an event ticket`, `Wrong event` | The code is not a real ticket for this event.                                                   | Do not admit. Call the supervisor.                                                 |
| Amber, `Valid signature, not in list – call supervisor`       | A real ticket that was made after this phone last updated.                                      | Call the supervisor (see "Amber").                                                 |
| Red, `Not allowed offline here`                               | The phone is offline and the event only lets offline phones admit tickets limited to this gate. | Call the supervisor.                                                               |
| Orange, `No connection`                                       | The ticket was **not** checked.                                                                 | Scan again when the pill is green or blue; call the supervisor if it stays orange. |

Red and amber screens stay until you tap them.

---

## T−7 days: a week before

Hub and VM, with internet.

- [ ] The hub is plugged into a normal network with internet. This renews its certificate. Phones refuse an expired certificate. (Admin or IT: check the expiry date as in `docs/deploy-hub.md` section 4.)
- [ ] Open the VM dashboard, log in, open the event. Under **Setup**, **Staff on this event**: everyone working the event shows **Add** or **Remove** correctly, with the right role.
- [ ] Every supervisor and admin PIN is **8 or more digits**. Anyone with a shorter one is asked to choose a new PIN the next time they log in. Make them do it now, not at the gate.
- [ ] Under **Setup**: the event name, venue and end time are right. The **Gates** list is final: the order cannot change once tickets exist, and new gates can only be added at the end.
- [ ] Under **Setup**, **Ticket types**: names, capacity, entry rule (`Single entry`, `Unlimited re-entry` or `Up to N entries`), gates and time slots are final.
- [ ] Decide whether phones that are offline should only admit tickets limited to their own gate (the box "Offline phones admit only tickets whose signed gates include their gate" under **Setup**). Click **Save event** if you change it.
- [ ] Under **QR generator**: make a test ticket with your own email address in the Email box and press **Generate**. You should see "Email queued to …". The email arrives within a few minutes. If it does not, tell IT now.
- [ ] Optional: run the field test (`docs/field-test.md`) at least once before this event type is used for real.

## T−24 hours: the day before

Do this with internet, at the office or at the venue.

**On the VM dashboard, open the event, then the Devices tab.**

- [ ] For every phone, under **Add a scanner**: pick the **Gate**, pick the **Role**, type a **Label** such as "Gate A – phone 2", press **Show setup QR**. The code works for 10 minutes and once only.
- [ ] On the phone, open `https://hub.example.org/scan` (use your own address). Press **Set up for event** and scan the code. If the camera will not work, allow camera access for the page in the browser settings and try again, or set this phone up with a printed hub setup code. The dashboard shows the setup code only as a picture, so there is no text to type or paste.
- [ ] The phone shows **Staff login**. Type the name and **PIN**, press **Log in**.
- [ ] **Ready screen check:** the top of the screen reads the right gate and role, for example `Gate A · Entry`, with the staff name and phone label underneath. A phone set to Entry and exit reads `Gate A · Entry / Exit` and shows **Entry** and **Exit** buttons. The pill reads **Hub** (green) and `0 queued`.
- [ ] Install the page as an app if the phone offers it (**Install app** button).
- [ ] Under **Devices**, the phone appears in the table as **Online**, with the right gate and role. A phone set up wrongly is fixed with **Move** (pick the gate and role, **Save**); the phone follows within a few seconds.
- [ ] Make a batch of spare codes for phones that need setting up at the venue with no internet. In the card **Batch codes for the venue hub**, pick a **Gate** and **Role**, set **How many** (for example 10), press **Make hub setup codes**. Press **Print** at once: the codes are shown only this one time. Each works once and stays valid until the event ends. Repeat for each gate and role you may need. Keep the printouts with the hub.

**Tickets on the hub and the standby hub**

- [ ] Hub: open `https://hub.example.org/api/health`. `last_cloud_sync_at` is within the last minute and `pending_scans` is `0`. To make the hub fetch the latest tickets straight away, restart its sync worker: `docker compose -f docker/compose.hub.yml restart worker`, then reload the health page.
- [ ] Standby hub: same check on its address, with the standby on its own network (it must **not** be on the venue network at the same time as the main hub).
- [ ] Make one last ticket on the VM and scan it on a phone showing **Hub**. It should go green. (If it says "ticket not found", the hub has not pulled yet: wait 30 seconds, try again.)

**Test scans**

- [ ] For **each ticket type** and **each gate**: scan one test ticket at the Entry phone. It goes green and says `Entry 1 of …` where it has a limit.
- [ ] Scan the same ticket again: red `Already used` or `Already inside`.
- [ ] At an Exit phone (or an Entry and exit phone switched to **Exit**), scan a re-entry ticket: blue `Exit recorded`. Then scan it at Entry: green again. Scan a single-entry ticket at Exit: grey `No re-entry on this ticket`.
- [ ] A gate-restricted ticket at the wrong gate: red `Use Gate …`.
- [ ] A time-slot ticket outside its slot: red `Too early…` or `Slot ended…`.
- [ ] Cancel one test ticket (VM dashboard, **Tickets** tab, **Cancel**) and scan it: red `Cancelled` (within a minute).
- [ ] **PIN login on every phone:** press **Sign out**, then log in again with a staff PIN. Do it once with the venue Wi-Fi only (no internet) if you can.
- [ ] Reset the test tickets: after the tests, cancel the test tickets, or use a separate "test" ticket type that you remove, so test admits do not count as real ones.

## T−2 hours: venue set-up

- [ ] Power on the router, then the access points, then the hub. The hub needs about two minutes. Plug the hub into the UPS.
- [ ] Open `https://hub.example.org/api/health` on a phone connected to the venue Wi-Fi. It shows `"mode":"hub"` and a padlock, with no warning.
- [ ] Every phone is on the venue Wi-Fi and its pill is **Hub** (green). Walk each gate and look.
- [ ] **Forced ticket pull:** if the internet is up, restart the hub's sync worker (`docker compose -f docker/compose.hub.yml restart worker`) and check `last_cloud_sync_at` in the health page is within the last minute. If the internet is down, skip: the hub keeps the tickets it already has.
- [ ] **Dashboard on the hub:** open `https://hub.example.org/` on the supervisor's phone or laptop and log in with the supervisor name and PIN. You see the event, **Live stats**, **Devices**, **Conflicts** and **Attendees & overrides**. The grey tabs (**QR generator**, **Setup**) are VM-only.
- [ ] Power banks at every gate, plugged in.
- [ ] Spare phones charged and signed in, and the printed hub setup codes at hand.

## T−15 minutes: just before doors

- [ ] Final pull: restart the sync worker as above (internet up), and read `last_cloud_sync_at` and `pending_scans` on the health page. `pending_scans` should be `0`.
- [ ] Decide on **door sales**. If the hub has no internet, tickets sold from now on will show **amber** until the hub's next sync. Either stop issuing tickets now, or agree that amber means "supervisor admits by hand". Tell the supervisors which.
- [ ] The test tickets from T−24 h are gone or cancelled.
- [ ] Supervisor has the hub dashboard open on the **Devices** tab.

## Doors

**Supervisor**

- [ ] Keep the **Devices** tab open. It refreshes by itself every 5 seconds. A row turns red and shows **Offline** or **Never seen** when a phone has not reported for more than 2 minutes; **Quiet** (yellow) means 1 to 2 minutes.
- [ ] Fix or replace any phone that is **Offline** or **Never seen** within a couple of minutes: check its Wi-Fi and battery, or hand the gate a spare phone. If a phone is gone for good, **Move** another phone to that gate and role, or set up a spare with a printed hub code.
- [ ] Glance at **Live stats** now and then: **Checked in**, **Inside now**, **Conflicts**, per gate and per ticket type.
- [ ] Glance at **Conflicts**: a number above 0 needs a look after the doors close, not during.

**How to admit someone by hand** (a code will not scan, or the screen says amber)

1. On the phone, press **Manual search**. Type the name or the last 6 characters printed under the QR (the phone only searches its own list).
2. Tap the person. At an Entry phone press **Admit (supervisor PIN)**; type the **Supervisor name** and **Supervisor PIN** and press **Admit**. At an Exit phone press **Record exit**.
3. The supervisor can also do it from the dashboard: **Attendees & overrides**, type at least 2 letters in **Find an attendee**, press **Admit**, type your PIN, press **Confirm admit**.
4. Every manual admit is logged as an override, with who did it. **Overrides by staff** on the same page lists them.

**Screens at the gate**

- **Amber (`Valid signature, not in list – call supervisor`).** The code is genuine but this phone does not have the ticket yet (made very recently). Supervisor: check the name on a printed list or the dashboard, then press **Supervisor override** on the phone, type **Supervisor name** and **Supervisor PIN**, press **Admit**. The phone does not have to be online for this.
- **Wrong gate (`Use Gate B`).** Send them to that gate. Do not override unless a supervisor decides to.
- **Too early.** Politely ask them to wait. The screen says when their slot starts. Supervisors may admit by hand (override) for a late or early guest.
- **Slot ended.** The supervisor decides. If admitted, use an override.
- **Already used / Already inside.** The screen says which gate and time the ticket was used, and on which device. Ask the holder if they already came in. If they say a friend used a screenshot, do not admit. Call the supervisor. Never admit the second person without a supervisor.
- **Cancelled.** Do not admit. Supervisor checks with the organiser. The ticket's holder may have a replacement ticket.
- **Invalid / forged, Not an event ticket, Wrong event.** Do not admit. A photo of the real ticket on a cracked screen sometimes fails: ask them to hold still in better light, or use **Manual search**.

## During the event: when something fails

| What happened                              | What you see                                                                                                                                                  | What to do                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Internet down**                          | Nothing on the phones. On the hub, `last_cloud_sync_at` stops moving.                                                                                         | Do nothing. Entry and exit continue. New tickets made on the VM show amber until the internet is back.                                                                                                          |
| **Hub down** (box off, crashed, unplugged) | Phone pills turn **Cloud-only** (blue) if the VM is reachable, otherwise **Offline** (orange). Scans slow by up to a second. The hub dashboard does not open. | Check the hub's power and network cable. If it does not come back in a few minutes, switch on the **standby hub**: see "Standby hub" below. Phones keep admitting meanwhile.                                    |
| **One access point down**                  | Phones at that gate turn **Offline** (orange) with an `OFFLINE` bar. They admit by themselves. The **Devices** row goes red.                                  | Restart or replace the access point. Small chance of the same ticket being admitted at two gates before everyone is back online; the **Conflicts** tab shows it after.                                          |
| **A phone dies**                           | Its row on **Devices** turns red. Scans it had not sent yet stay safe on the phone.                                                                           | Give the gate a spare phone (set up with a printed code or **Move** a phone). Charge the dead phone. When it turns on and gets a connection, it sends its scans.                                                |
| **A code will not scan**                   | The camera does not find the code, or shows `Invalid / forged`.                                                                                               | Better light, hold still, wipe the screen, brighten the sender's screen. Then **Manual search** by name or the last 6 characters, and admit by hand.                                                            |
| **A phone is lost or stolen**              | —                                                                                                                                                             | Supervisor: **Devices** tab, find the phone, press **Revoke and rotate**, confirm. The phone stops working at once. Everyone on the event (you too) must choose a new PIN the next time they log in. See below. |
| **Phone shows Cloud-only for a while**     | Blue pill.                                                                                                                                                    | The hub is not answering this phone: check the phone's Wi-Fi name, the signal at that gate, then the hub.                                                                                                       |
| **Phone shows "Staff login" suddenly**     | Login page.                                                                                                                                                   | Log in again. If login fails with a new PIN message, a "Revoke and rotate" happened: choose a new PIN on the dashboard first.                                                                                   |

**Lost or stolen phone: step by step**

1. Supervisor opens the **Devices** tab on the **VM** (the hub's panel is read-only), finds the phone by its label.
2. Press **Revoke and rotate** and confirm the box. The message lists the people who must choose a new PIN.
3. Give the gate a spare phone: **Show setup QR** (VM) or a printed hub code.
4. Everyone on the list logs in once at the dashboard to choose a new PIN before using a phone again.

**Standby hub**

- [ ] Switch on the standby hub and put it on the venue network with the main hub's address, or point the router's `hub.example.org` entry at the standby (IT does this; steps in `docs/deploy-hub.md` section 7.1).
- [ ] Make sure the main hub is off or unplugged. Two hubs on at once would each decide "first scan" alone.
- [ ] Phones need no change. Check one phone shows **Hub** (green) again.
- [ ] Phones set up at the old hub after its last sync with the VM must be set up again.

## After doors close

- [ ] Keep the internet up and the hub powered. Watch the phones' pill: every phone should read `Hub · 0 queued` (or `Cloud-only · 0 queued`).
- [ ] On the hub health page, `pending_scans` falls to `0`. This means every scan reached the VM. Do not power the hub down before this.
- [ ] On the VM dashboard, compare **Checked in** (**Live stats**) with the hub's number.
- [ ] Open the **Conflicts** tab on the **VM**. Each card shows the scan that stays valid (first) and the flagged scan (later), with gate, device, staff and time. Talk to the staff involved, then press **Mark reviewed** on each.
- [ ] Open **Attendees & overrides** and read **Overrides by staff**: does each override make sense?

## After the event

- [ ] Wipe the phones: on each, press **Revoke** on the VM's **Devices** tab; the phone wipes itself the next time it is online. **Set up again** only returns the phone to the setup screen and does not wipe it. If a phone cannot get online, clear the browser's site data for the scanner address by hand. Close the browser tabs.
- [ ] Power down the hub and the standby. IT wipes the hub's data (`docker compose -f docker/compose.hub.yml down -v`) and revokes its link to the VM, as in `docs/deploy-hub.md` section 8.
- [ ] Export the ticket list if you need it: VM, **Tickets** tab, **Export CSV** (admins).
- [ ] Nothing else to delete by hand. Holder names, emails and phone numbers are cleared automatically a year after the event, and scan records three years after it.
- [ ] Note what went wrong and what slowed the doors, and give it to the person who runs the next event.

---

<div style="page-break-before: always"></div>

# Quick card: door staff

**Your phone shows your gate and role at the top, for example `Gate A · Entry`.** If it is wrong, call the supervisor.

**Scan**

- Hold the phone 20–30 cm from the code. Hold still. The screen answers in under a second.
- **Green** (name, `Entry 1 of 3`): let them in.
- **Blue** (`Exit recorded`): let them out.
- **Anything red, grey or amber stays on the screen until you tap it.**

| Screen                                | You say / do                                    |
| ------------------------------------- | ----------------------------------------------- |
| Red `Use Gate B`                      | "Please use Gate B."                            |
| Red `Too early` / `Slot ended`        | "Your time starts at …" or call the supervisor. |
| Red `Already used` / `Already inside` | Do **not** admit. Call the supervisor.          |
| Red `Cancelled` / `Invalid / forged`  | Do **not** admit. Call the supervisor.          |
| Amber `not in list – call supervisor` | Call the supervisor. They enter their own PIN.  |
| Grey `No re-entry on this ticket`     | "This ticket does not allow coming back in."    |
| Orange `No connection`                | Scan again. If it stays, call the supervisor.   |

**Code will not scan?** Better light, hold still, clean the screen. Then press **Manual search**, type the name or the last 6 characters under the code, tap the person, and call the supervisor to enter their PIN.

**Pill at the top right:** green `Hub` is good. Blue `Cloud-only` or orange `Offline`: tell the supervisor, keep scanning.

**Phone dying?** Plug in the power bank. Tell the supervisor.

---

<div style="page-break-before: always"></div>

# Quick card: supervisor

**Open at doors:** the dashboard on the hub (`https://hub.example.org/`), **Devices** tab. It updates every 5 seconds.

**Watch for**

- A red row, **Offline** or **Never seen** for more than 2 minutes: fix the phone or its access point, or hand the gate a spare. **Quiet** (yellow) is 1 to 2 minutes: watch it.
- A **Cloud-only** phone: the hub is not answering that phone.
- Many phones at once going red: probably the hub or the router. Check power and cable first, then switch to the standby hub.

**Admit by hand**

- On the phone: **Manual search**, tap the person, **Admit (supervisor PIN)**, your name and PIN, **Admit**.
- Or on the dashboard: **Attendees & overrides**, **Find an attendee**, **Admit**, your PIN, **Confirm admit**.

**Amber on a phone:** check the name is real, then use the override on the phone with your name and PIN.

**Lost phone:** on the **VM**, **Devices** tab, **Revoke and rotate**. Everyone then picks a new PIN at their next login, you too. Give the gate a spare phone.

**Do not**

- Do not admit an `Already used` / `Already inside` ticket for a second person without checking who the real holder is.
- Do not switch two hubs on at the same time.
- Do not power the hub off before `pending_scans` is `0` after the doors close.

**After doors:** `pending_scans` = 0 on `/api/health`, then **Conflicts** on the VM: **Mark reviewed** on each card.
