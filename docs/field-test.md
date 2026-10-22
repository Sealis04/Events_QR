# Field test

The field test proves the whole system with real phones, real gates and real staff before the first real event. It is also the rehearsal for the runbook (`docs/runbook.md`): use the same steps, the same words and the same people who will work the doors.

Run it once before the first live event, and again after any change to the app, the hub, the router or the phones. Put the results table (section 4) on paper and fill it in as you go.

## 1. What you need

- A **dev or staging VM** and a **hub** set up as in `docs/deploy-vm.md` and `docs/deploy-hub.md`. Never run this on the production VM: the test tickets would count as real ones.
- The venue, or a space with **at least two doors/gates** at the distance real gates will have, and the real Wi-Fi equipment (router, access points).
- **Phones**: the ones staff will really use, including at least one with a cracked screen and one old or slow model. Two or three spare phones.
- **Staff**: at least two door staff and one supervisor, who have never seen the test tickets. People who know the answers make the test too easy.
- **Printed test tickets** and a few **phone-screen tickets** (see section 2).
- A stopwatch (a second phone is fine), pen, this document, the runbook, the printed hub setup codes.
- A second person to cut cables and switch things off, so the observer can watch the screens.

## 2. Make the 50 test tickets

On a computer that can reach the dev or staging VM (the same folder as `.env`):

1. Make sure an admin exists (`bun scripts/create-admin.ts --name "Rehearsal admin"`).
2. Run the seed script:

   ```bash
   bun scripts/rehearsal-seed.ts --yes --out rehearsal-sheet.html
   ```

   It refuses to run without `--yes`, and refuses to run against the production address (see the top of the script for the `PRODUCTION_URL` setting). It creates an event called **Dress rehearsal** with two gates (**Gate A**, **Gate B**), the five ticket types below, and the 50 tickets. Running it again re-uses the event and the tickets and rewrites the sheet with the same QR codes.

3. Open `rehearsal-sheet.html` in a browser and print it (**Print**, or **Save as PDF**). Every QR has a caption: the holder's name, the ticket type, the scenario, and the last 6 characters of the ticket id. Print two copies of the first page: one on plain paper, one on ordinary paper at 50% size to test small codes.
4. Put a few tickets on phones: open the sheet on a second phone, or make a screenshot of a few QRs and send them to the staff's own phones. Turn the screen brightness down on some, and crack-test with the old phone.

The 50 tickets:

| Scenario (printed on the sheet) | How many | Ticket type          | What it tests                                                                  |
| ------------------------------- | -------- | -------------------- | ------------------------------------------------------------------------------ |
| `single`                        | 21       | General (single entry) | Normal entry once, then `Already inside`; exit then gives grey `No re-entry`. |
| `cancelled`                     | 1        | General              | Red `Cancelled`.                                                               |
| `transfer-old`                  | 1        | General              | Cancelled by a transfer: red `Cancelled`.                                      |
| `transfer-new`                  | 1        | General              | The new holder's ticket: green.                                                |
| `reentry-3`                     | 8        | Re-entry (up to 3 entries) | `Entry 1 of 3`, exit, `Entry 2 of 3`… then the third exit and fourth entry: red `Already used`. |
| `unlimited`                     | 6        | VIP (unlimited re-entry) | Many in and out cycles.                                                    |
| `gate-b-only`                   | 6        | Gate B only          | Green at Gate B; red `Use Gate B` at Gate A.                                   |
| `slot-open`                     | 3        | Timed                | Green now (its slot is open).                                                  |
| `slot-early`                    | 2        | Timed                | Red `Too early – slot starts …`.                                               |
| `slot-ended`                    | 1        | Timed                | Red `Slot ended at …`.                                                         |

The seed also makes the sheet's cancelled and transferred tickets for you, so you do not need to cancel or transfer anything by hand.

## 3. Setting up the test

1. On the VM dashboard, open the **Dress rehearsal** event. Under **Devices**, **Add a scanner**, set up one phone per gate and role, following the runbook's T−24 h steps: **Gate A** Entry, **Gate B** Entry, one Exit phone, and one phone as **Entry and exit**. Use staff logins with PINs.
2. Print a batch of hub setup codes (**Batch codes for the venue hub**) and set up one spare phone with a printed code **with the hub's uplink unplugged**. It must work.
3. Start with every phone showing **Hub** (green) and `0 queued`.
4. Open the **hub** dashboard (`https://hub.example.org/`) on the supervisor's device, **Devices** and **Live stats** tabs. Keep it open for the whole test.
5. Note the start time, the weather (glare matters), the venue and the phones used.

## 4. Scenarios and results table

For each row: scan the ticket, read the screen, write down what the screen said, how long it took from the code being in front of the camera to the screen changing (use the stopwatch, or video at 60 frames/s), and mark pass or fail. **Pass** means the actual screen is the expected one, and the time is under 1 second (the target is under 300 ms from frame to result; see section 7).

Copy this table onto paper. Add rows for each condition you try (cracked phone, dim, paper, screenshot, glare).

| #   | Scenario and condition                                               | Gate / phone      | Expected screen                                          | Actual screen | Time to result | Pass / fail |
| --- | -------------------------------------------------------------------- | ----------------- | -------------------------------------------------------- | ------------- | -------------- | ----------- |
| 1   | `single`, paper, good light                                          | Gate A, Entry     | Green, name, type                                        |               |                |             |
| 2   | Same ticket again                                                    | Gate A, Entry     | Red `Already inside`, with gate and time                 |               |                |             |
| 3   | Same ticket at the other gate                                        | Gate B, Entry     | Red `Already inside`                                     |               |                |             |
| 4   | Same ticket at Exit                                                  | Exit              | Grey `No re-entry on this ticket`                        |               |                |             |
| 5   | `single`, on a phone screen, dim                                     | Gate A, Entry     | Green                                                    |               |                |             |
| 6   | `single`, on a cracked phone screen                                  | Gate A, Entry     | Green                                                    |               |                |             |
| 7   | `single`, paper, small print                                         | Gate B, Entry     | Green                                                    |               |                |             |
| 8   | `single`, paper, in glare or bright sun                              | Gate B, Entry     | Green (or note how it failed and what staff did)         |               |                |             |
| 9   | `reentry-3`: entry, exit, entry                                      | Gate A, then Exit | Green `Entry 1 of 3`; blue `Exit recorded`; green `Entry 2 of 3` |      |                |             |
| 10  | `reentry-3`: second exit, third entry, fourth entry                   | Exit, Gate A      | Blue; green `Entry 3 of 3`; (exit) then red `Already used` |             |                |             |
| 11  | `unlimited`: five entry/exit cycles                                  | Entry and exit    | Green / blue each time                                   |               |                |             |
| 12  | `gate-b-only` at Gate A                                              | Gate A, Entry     | Red `Use Gate B`                                         |               |                |             |
| 13  | `gate-b-only` at Gate B                                              | Gate B, Entry     | Green                                                    |               |                |             |
| 14  | `slot-open`                                                          | Gate A, Entry     | Green                                                    |               |                |             |
| 15  | `slot-early`                                                         | Gate A, Entry     | Red `Too early – slot starts …`                          |               |                |             |
| 16  | `slot-ended`                                                         | Gate A, Entry     | Red `Slot ended at …`                                    |               |                |             |
| 17  | `cancelled`                                                          | Gate A, Entry     | Red `Cancelled`                                          |               |                |             |
| 18  | `transfer-old`                                                       | Gate A, Entry     | Red `Cancelled`                                          |               |                |             |
| 19  | `transfer-new`                                                       | Gate A, Entry     | Green                                                    |               |                |             |
| 20  | A QR code from some other source (a web link, a shop code)           | Gate A, Entry     | Red `Not an event ticket`                                |               |                |             |
| 21  | A ticket of another event (from another test event, if you have one) | Gate A, Entry     | Red `Wrong event`                                        |               |                |             |
| 22  | A ticket made **after** the phone last updated (make one on the VM and scan within 10 seconds, with the hub's uplink unplugged) | Gate A, Entry | Amber `Valid signature, not in list – call supervisor` |  |  |  |
| 23  | Supervisor override of #22                                           | Gate A, Entry     | Green `Override by supervisor`; the override shows under **Attendees & overrides** |  |  |  |
| 24  | Code that will not scan; **Manual search** by last 6 characters and admit with a supervisor PIN | Gate A | Green; logged as an override |  |  |  |
| 25  | Remaining tickets: scan each once, mixed gates and phones            | any               | As the printed scenario says                             |               |                |             |

By the end every one of the 50 tickets has been scanned at least once, and every phone has done at least five scans. Leave 2 or 3 tickets unscanned until the drills in section 5, to use during them.

**Staff observations.** Also write down, for each staff member: did they understand the screens without help? Where did they hesitate? Which words confused them? Fix the runbook wording where they stumble.

## 5. Offline drills

Do each drill with scanning going on. Between drills, restore everything and check that the pills are green and `0 queued`. For each, write the time you did it, what each phone's pill showed within 10 seconds, and what happened to scans.

1. **Pull the hub's uplink.** Unplug the router's internet cable.
   - Expected: nothing visible on the phones; pills stay **Hub**. Scanning keeps working at all gates. `last_cloud_sync_at` on the hub's health page stops moving.
   - While it is down: make one new ticket on the VM and scan it: amber (supervisor admits it). Restore the cable: within a minute the ticket is on the hub and scans green.
   - Check after: `pending_scans` goes to `0` on the hub health page, and **Checked in** on the VM matches the hub's.

2. **Switch off the hub.** Pull the hub's power.
   - Expected: within a few seconds each phone's pill turns **Cloud-only** (blue) if the VM is reachable, or **Offline** (orange) with the `OFFLINE` bar if not (also unplug the uplink to test this case). Scanning continues. Offline entries show `OFFLINE`.
   - Scan a ticket **already** admitted before the hub went off: red `Already inside (offline)` or `No entries left (offline)`.
   - Power the hub back: the pills return to **Hub** (green) on the next scan, queued scans drain to `0 queued`, and the hub's `pending_scans` returns to `0`.
   - Then switch to the **standby hub** and check it too, as in the runbook.

3. **Switch off one access point.** Pick the AP at one gate.
   - Expected: only that gate's phones turn **Offline**; the other gate stays **Hub**. The **Devices** row of the offline phones turns red after 2 minutes.
   - Scan at that gate: still admitted, with the `OFFLINE` bar. Scan the same ticket at the other gate while the first is offline: expect a possible double admit.
   - Restore the AP: the phones return to **Hub**; the double admit shows in **Conflicts** on the VM (the flagged one is the later scan).

4. **Airplane mode on one phone, then reconnect.**
   - Turn on airplane mode on one phone, scan 5 tickets, check the count shows `5 queued`. Turn airplane mode off.
   - Expected: `0 queued` within a minute; the 5 scans appear in **Live stats** and in **Checked in**.
   - Restart the browser (close and reopen the scanner page) with airplane mode **on** and scan once more: the queue must still be there and drain later.

5. **Phone dies.** Let a phone's battery run out, or turn it off during a scan session. Turn it on, log in, and check `0 queued` after a minute.

6. **Lost-phone drill.** On the VM, **Devices**, **Revoke and rotate** a spare phone. Check: the phone stops working, and staff on the list get "Choose a new PIN" at their next dashboard login. Set the PINs again afterwards.

## 6. The shared-screenshot test

This must show a conflict. It checks that two people cannot both get in with one ticket, and that the system shows who tried.

1. Choose one `single` ticket. Send a **screenshot** of its QR to a second phone.
2. Cut the hub's uplink and also switch off the hub, so that two gates are in **Offline** mode (airplane mode on the two door phones works too).
3. Scan the original at **Gate A** and the screenshot at **Gate B** within a minute of each other. Both show green with the `OFFLINE` bar. That is expected: with no hub, the phones cannot know.
4. Restore everything and wait for `0 queued` on both phones.
5. **Pass:** on the VM, the **Conflicts** tab shows this ticket with the earlier scan under **Stays valid (first)** and the later one under **Flagged (later)**, with gates, devices and times. **Conflicts** on **Live stats** is at least 1. Press **Mark reviewed**.
6. Then try the same with the hub on: scan the original at Gate A, then the screenshot at Gate B. Expected: red `Already inside`, no conflict.

## 7. Go-live criteria

All of these must be true. Write the date, the people, and any exceptions at the bottom of the results.

- [ ] Every row of the results table passed, including the cracked, dim, small-print and glare conditions, or each failure has a written workaround that the staff understood (for example "tilt the phone" or "use manual search").
- [ ] **Frame-to-result under 300 ms** on the target phones in normal light, and no scan slower than 1 second. (Measure on video at 60 frames per second, from the code filling the camera view to the screen changing. Median and worst, per phone model.)
- [ ] All five offline drills behaved as described. After each, **queued scans drained to 0** on every phone within one minute of the connection returning, and the hub's `pending_scans` fell to `0`.
- [ ] The VM's **Checked in** equals the hub's number, and equals the number of admits the observers counted.
- [ ] The shared-screenshot test **produced a conflict**, and the conflict showed on the VM's **Conflicts** tab with both scans.
- [ ] A phone set up at the venue **with no internet** from a printed hub code worked.
- [ ] The standby hub took over (drill 2) with no change on the phones.
- [ ] Staff could do everything on the quick cards without help; confusing words were fixed in the runbook.
- [ ] The test email from the runbook's T−7 days step arrived.
- [ ] The hub's certificate expiry date is more than 30 days away, and `hub.example.org` resolves with the uplink unplugged.
- [ ] The test event's scans, tickets and staff were removed, or kept clearly apart from the real event (the real event is a different event).

Signed off by: ______________________  Date: ____________  Notes: ______________________________________________
