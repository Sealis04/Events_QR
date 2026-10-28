/**
 * The hub setup checklist (M12): one pure evaluator per step. Each takes the evidence a check
 * collected (a browser fetch, a DNS answer, a device row, counts) and returns pass / warn / fail
 * with a stable `code`. The code maps to the fix text shown on the page (`fixFor`), so what is
 * stored stays small and the wording can improve without touching old rows. No Node imports: the
 * browser evaluates the steps it runs itself (steps 1 and 5) with the same functions.
 */
import type { HUB_CHECK_RESULTS, HUB_CHECK_STEPS } from "../db/shared";
import { classifyAddress } from "./address";

export * from "./address";

export type HubCheckStep = (typeof HUB_CHECK_STEPS)[number];
export type HubCheckResult = (typeof HUB_CHECK_RESULTS)[number];
export type CheckDetails = Record<string, string | number | boolean | null>;

export interface CheckOutcome {
  result: HubCheckResult;
  /** Why it failed, warned or was skipped; null on a clean pass. */
  code: string | null;
  summary: string;
  details: CheckDetails;
}

const outcome = (
  result: HubCheckResult,
  code: string | null,
  summary: string,
  details: CheckDetails = {},
): CheckOutcome => ({ result, code, summary, details });

const SETUP_GUIDE = "https://github.com/Sealis04/Events_QR/blob/main/docs/setup-guide.md";
export const SETUP_GUIDE_SECTIONS = {
  "4.2": "42-tell-the-vm-about-the-hub-and-get-the-code",
  "4.3": "43-start-the-hub-and-bind-it-to-the-event",
  "4.4": "44-cloudflare-record-for-the-hub-dns-only",
  "4.5": "45-https-on-the-hub-certificate-by-dns-01-and-renewal",
  "4.6": "46-make-hubdomain-resolve-with-no-internet",
  "5.5": "55-set-up-a-phone",
  "5.7": "57-pull-the-internet-cable-and-scan-again",
} as const;
export type GuideSection = keyof typeof SETUP_GUIDE_SECTIONS;

export interface Fix {
  text: string;
  section: GuideSection | null;
  /** Link to the matching section of docs/setup-guide.md. */
  url: string | null;
}

const fix = (text: string, section: GuideSection | null): Fix => ({
  text,
  section,
  url: section ? `${SETUP_GUIDE}#${SETUP_GUIDE_SECTIONS[section]}` : null,
});

const FIXES: Record<string, Fix> = {
  hub_unreachable: fix(
    "Three usual causes: the hub stack is not up (run `docker compose --env-file .env -f docker/compose.hub.yml ps` on the hub machine and start it), the address is wrong (check the hub address above, including http or https and the port), or this browser is not on the same network as the hub (join the hub's Wi-Fi or LAN, or use the VM's network).",
    "4.3",
  ),
  hub_bad_status: fix(
    "The hub answered with an error. Look at the hub's logs (`docker compose -f docker/compose.hub.yml logs app`) and check that the migrate service finished.",
    "4.3",
  ),
  not_hub_mode: fix(
    "That address answers as the VM, not as a hub. Point the hub address at the hub machine (the one running with APP_MODE=hub).",
    "4.3",
  ),
  dns_no_record: fix(
    "No DNS record for the hub name. In Cloudflare add an A record for the hub name pointing to the hub's LAN address (for example 192.168.50.10), with the cloud grey (DNS only).",
    "4.4",
  ),
  dns_cloudflare_proxy: fix(
    "Proxied by Cloudflare: turn the cloud grey. In Cloudflare DNS edit the hub record and switch Proxy status to DNS only, then run the check again (it can take a minute).",
    "4.4",
  ),
  dns_public_address: fix(
    "The record points to a public address. The hub record must point to the hub's private LAN address (10.x, 172.16-31.x or 192.168.x).",
    "4.4",
  ),
  dns_lookup_failed: fix(
    "The VM could not ask the public DNS server (timeout or network error). Check that the VM has internet access, then run the check again.",
    null,
  ),
  dns_ip_address: fix(
    "The hub address is an IP address, so there is no name to look up. Use the hub's name (https://hub.<domain>) as the hub address.",
    "4.4",
  ),
  cert_not_trusted: fix(
    "The hub's certificate is not trusted. Issue the Let's Encrypt certificate for the hub name (DNS-01) and attach it to the hub's proxy host.",
    "4.5",
  ),
  cert_unverified: fix(
    "Neither the VM nor your browser could open the hub over HTTPS. Run step 1 with the hub's https:// address first, and check that the proxy on the hub is up on port 443.",
    "4.5",
  ),
  cert_expired: fix(
    "The certificate has expired. Renew it in Nginx Proxy Manager (renewal needs internet), then run the check again.",
    "4.5",
  ),
  cert_expiring: fix(
    "The certificate expires soon. Renew it while the hub still has internet; Nginx Proxy Manager normally does this by itself 30 days before expiry.",
    "4.5",
  ),
  cert_expiry_unknown: fix(
    "The certificate is trusted, but the hub cannot report its expiry date. Run `openssl s_client -connect hub.<domain>:443 -servername hub.<domain> </dev/null | openssl x509 -noout -enddate` from any machine that can reach the hub, or set HUB_CERT_PATH on the hub to the certificate file so the page can read it.",
    "4.5",
  ),
  hub_not_linked: fix(
    "No hub is linked to this event. Make a setup code here and run the hub-enroll command on the hub machine.",
    "4.2",
  ),
  hub_revoked: fix(
    "The only hub of this event is revoked. Make a new setup code and run the hub-enroll command again.",
    "4.2",
  ),
  hub_not_seen: fix(
    "The hub is linked but has not contacted the VM in the last 2 minutes. Check that the hub's worker container is running and that the hub can reach the VM (`docker compose -f docker/compose.hub.yml logs worker`).",
    "4.3",
  ),
  hub_never_pulled: fix(
    "The hub is linked but has not pulled tickets yet. Check that the hub's worker container is running (`docker compose -f docker/compose.hub.yml logs worker`).",
    "4.3",
  ),
  local_dns_unreachable: fix(
    "The name did not answer from here. If the internet is unplugged, the venue router (or the hub's `dns` service) must answer for the hub name. Test it with `nslookup hub.<domain> <router-ip>`; if this laptop uses another DNS server (VPN, mobile data), switch it to the venue Wi-Fi.",
    "4.6",
  ),
  local_dns_wrong_target: fix(
    "The name answers, but not from a hub. It probably still resolves to the VM or an old address. Fix the router's DNS entry (or the hub's `dns` service) so the hub name points to the hub's LAN address.",
    "4.6",
  ),
  needs_vm: fix(
    "This step needs the VM and cannot run while the hub is offline. Run it again when the venue has internet, or from the VM's page.",
    null,
  ),
  run_on_hub: fix(
    "This step looks at what the hub holds. Open this page on the hub's own dashboard (its address ends in the hub name) and run it there.",
    null,
  ),
  data_never_pulled: fix(
    "The hub has never pulled from the VM. Check that the hub's worker container is running.",
    "4.3",
  ),
  data_stale: fix(
    "The counts differ and the hub has not pulled recently. Press “Pull tickets now” on the hub's dashboard, and check the worker container.",
    "4.3",
  ),
  data_mismatch: fix(
    "The hub holds different data than the VM (it has more tickets or staff than the VM, or fewer after a recent pull). Press “Pull tickets now” and run the check again; if it persists, re-bind the hub with a new setup code.",
    "4.3",
  ),
  no_phones: fix(
    "No phone is set up for this event yet. Make a phone setup code on the Devices tab and scan it with the phone while it is on the venue Wi-Fi.",
    "5.5",
  ),
  phone_quiet: fix(
    "No phone has reported through the hub in the last 5 minutes. Open the scanner on a phone that is on the venue Wi-Fi and scan one ticket, or check that the phone's setup address is the hub.",
    "5.5",
  ),
  offline_not_tested: fix(
    "Press “Start the offline test”, unplug the hub's uplink, wait one minute, scan the rehearsal test ticket, plug the uplink back in, then run the check.",
    "5.7",
  ),
  offline_no_outage: fix(
    "The hub did not notice the uplink going down since the test started. Unplug the cable between the hub's router and the internet (not the hub's own cable), wait one minute, and scan again.",
    "5.7",
  ),
  offline_no_scan: fix(
    "The uplink was down, but no scan reached the hub during that time. Scan the test ticket on a phone that is on the venue Wi-Fi while the uplink is unplugged.",
    "5.7",
  ),
  offline_not_delivered: fix(
    "The scan is on the hub but the VM has not received it yet. Plug the uplink back in and run the check again after a minute.",
    "5.7",
  ),
};

/** The fix text for a failure or warning code, or undefined for a clean pass. */
export const fixFor = (code: string | null): Fix | undefined => (code ? FIXES[code] : undefined);
export const HUB_FIX_CODES: readonly string[] = Object.keys(FIXES);

// ---- Step 1 and step 5: a browser fetches the hub's health -----------------------------------

/** What the browser saw when it fetched `<hub address>/api/health`. */
export interface HealthFetch {
  url: string;
  reached: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

function healthDetails(f: HealthFetch): CheckDetails {
  const body = (f.body ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    url: f.url,
    mode: typeof body.mode === "string" ? body.mode : null,
    last_cloud_sync_at: num(body.last_cloud_sync_at),
    pending_scans: num(body.pending_scans),
    cert_expires_at: num(body.cert_expires_at),
  };
}

/** Step 1: the hub answers at its address, in hub mode. */
export function evaluateHubRunning(f: HealthFetch): CheckOutcome {
  const details = healthDetails(f);
  if (!f.reached)
    return outcome("fail", "hub_unreachable", `No answer from ${f.url}.`, {
      ...details,
      error: f.error ?? null,
    });
  if (f.status !== undefined && (f.status < 200 || f.status > 299))
    return outcome("fail", "hub_bad_status", `${f.url} answered with status ${f.status}.`, details);
  if (details.mode !== "hub")
    return outcome(
      "fail",
      "not_hub_mode",
      `${f.url} answered, but in ${details.mode ?? "an unknown"} mode, not as a hub.`,
      details,
    );
  return outcome("pass", null, `The hub answers at ${f.url}.`, details);
}

/** Step 5: the hub's name answers in hub mode from the venue Wi-Fi. */
export function evaluateLocalDns(f: HealthFetch): CheckOutcome {
  const details = healthDetails(f);
  if (!f.reached)
    return outcome("fail", "local_dns_unreachable", `${f.url} did not answer from this network.`, {
      ...details,
      error: f.error ?? null,
    });
  if (f.status !== undefined && (f.status < 200 || f.status > 299))
    return outcome(
      "fail",
      "local_dns_wrong_target",
      `${f.url} answered with status ${f.status}.`,
      details,
    );
  if (details.mode !== "hub")
    return outcome(
      "fail",
      "local_dns_wrong_target",
      `${f.url} answered, but in ${details.mode ?? "an unknown"} mode, not as a hub.`,
      details,
    );
  return outcome("pass", null, `${f.url} answers in hub mode on this network.`, details);
}

// ---- Step 2: DNS record -----------------------------------------------------------------------

export interface DnsLookup {
  host: string;
  /** The public resolver's answer; empty when none. */
  addresses: string[];
  /** `nxdomain` (no such name or no records), or another resolver error such as a timeout. */
  error?: string;
  resolver?: string;
}

export function evaluateDnsRecord(l: DnsLookup): CheckOutcome {
  const details: CheckDetails = {
    host: l.host,
    addresses: l.addresses.join(", ") || null,
    resolver: l.resolver ?? null,
  };
  if (l.addresses.length === 0) {
    if (l.error && l.error !== "nxdomain")
      return outcome(
        "fail",
        "dns_lookup_failed",
        `Could not look up ${l.host} (${l.error}).`,
        details,
      );
    return outcome("fail", "dns_no_record", `No record for ${l.host}.`, details);
  }
  const kinds = l.addresses.map(classifyAddress);
  if (kinds.includes("cloudflare"))
    return outcome(
      "fail",
      "dns_cloudflare_proxy",
      `${l.host} answers with a Cloudflare address (${l.addresses.join(", ")}): the record is proxied.`,
      details,
    );
  if (kinds.every((k) => k === "private"))
    return outcome(
      "pass",
      null,
      `${l.host} resolves to the private address ${l.addresses.join(", ")}.`,
      details,
    );
  return outcome(
    "fail",
    "dns_public_address",
    `${l.host} resolves to ${l.addresses.join(", ")}, which is not a private address.`,
    details,
  );
}

// ---- Step 3: certificate ----------------------------------------------------------------------

export const CERT_WARN_DAYS = 30;

export interface CertEvidence {
  now: number;
  /** The VM opened a TLS connection to the hub's name; undefined when it could not try or reach it. */
  vmTls?: { authorized: boolean; expiresAt: number | null; error?: string };
  /** The browser fetched the hub's health over https (a trusted certificate) and what the hub said about its certificate. */
  browser?: { reachedOverHttps: boolean; certExpiresAt: number | null };
}

export function evaluateCertificate(e: CertEvidence): CheckOutcome {
  const vm = e.vmTls;
  const browser = e.browser;
  const expiresAt = vm?.expiresAt ?? browser?.certExpiresAt ?? null;
  const details: CheckDetails = {
    expires_at: expiresAt,
    days_left: expiresAt === null ? null : Math.floor((expiresAt - e.now) / 86_400),
    checked_by: vm ? "vm" : browser?.reachedOverHttps ? "browser" : null,
  };
  if (vm && !vm.authorized)
    return outcome("fail", "cert_not_trusted", "The hub's certificate is not trusted.", details);
  const trusted = vm?.authorized === true || browser?.reachedOverHttps === true;
  if (!trusted)
    return outcome(
      "fail",
      "cert_unverified",
      "The hub could not be reached over HTTPS from the VM or from your browser.",
      details,
    );
  if (expiresAt === null)
    return outcome(
      "warn",
      "cert_expiry_unknown",
      "The certificate is trusted; its expiry date is not known.",
      details,
    );
  const days = details.days_left as number;
  if (days < 0) return outcome("fail", "cert_expired", "The certificate has expired.", details);
  if (days < CERT_WARN_DAYS)
    return outcome(
      "warn",
      "cert_expiring",
      `The certificate is trusted and expires in ${days} day${days === 1 ? "" : "s"}.`,
      details,
    );
  return outcome(
    "pass",
    null,
    `The certificate is trusted and valid for ${days} more days.`,
    details,
  );
}

// ---- Step 4: link the hub ---------------------------------------------------------------------

/** A hub is "seen" when it contacted the VM within this many seconds. */
export const HUB_SEEN_SECONDS = 120;

export interface HubDeviceView {
  id: string;
  label: string | null;
  revoked: boolean;
  lastSeenAt: number | null;
  lastPullAt: number | null;
}

export function evaluateLinkHub(e: { now: number; hubs: HubDeviceView[] }): CheckOutcome {
  if (e.hubs.length === 0)
    return outcome("fail", "hub_not_linked", "No hub is linked to this event yet.");
  const active = e.hubs.filter((h) => !h.revoked);
  if (active.length === 0)
    return outcome("fail", "hub_revoked", "Every hub linked to this event is revoked.", {
      hubs: e.hubs.length,
    });
  // The most recently seen hub decides: an older, replaced one must not hide a healthy new one.
  const hub = [...active].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0]!;
  const details: CheckDetails = {
    device_id: hub.id,
    label: hub.label,
    last_seen_at: hub.lastSeenAt,
    last_pull_at: hub.lastPullAt,
  };
  if (hub.lastSeenAt === null || e.now - hub.lastSeenAt > HUB_SEEN_SECONDS)
    return outcome(
      "fail",
      "hub_not_seen",
      "The hub is linked but was not seen in the last 2 minutes.",
      details,
    );
  if (hub.lastPullAt === null)
    return outcome(
      "fail",
      "hub_never_pulled",
      "The hub is linked but has not pulled tickets yet.",
      details,
    );
  return outcome(
    "pass",
    null,
    `The hub${hub.label ? ` "${hub.label}"` : ""} is linked, was seen ${Math.max(0, e.now - hub.lastSeenAt)} s ago and has pulled tickets.`,
    details,
  );
}

// ---- Step 6: data match -----------------------------------------------------------------------

export interface DataCounts {
  tickets: { valid: number; used_up: number; cancelled: number };
  staff: number;
}

const total = (c: DataCounts) => c.tickets.valid + c.tickets.used_up + c.tickets.cancelled;

export function evaluateDataMatch(e: {
  now: number;
  hub: DataCounts;
  vm: DataCounts;
  lastPullAt: number | null;
  pullIntervalSeconds: number;
}): CheckOutcome {
  const details: CheckDetails = {
    hub_tickets: total(e.hub),
    vm_tickets: total(e.vm),
    hub_valid: e.hub.tickets.valid,
    vm_valid: e.vm.tickets.valid,
    hub_used_up: e.hub.tickets.used_up,
    vm_used_up: e.vm.tickets.used_up,
    hub_cancelled: e.hub.tickets.cancelled,
    vm_cancelled: e.vm.tickets.cancelled,
    hub_staff: e.hub.staff,
    vm_staff: e.vm.staff,
    last_pull_at: e.lastPullAt,
  };
  const same =
    e.hub.tickets.valid === e.vm.tickets.valid &&
    e.hub.tickets.used_up === e.vm.tickets.used_up &&
    e.hub.tickets.cancelled === e.vm.tickets.cancelled &&
    e.hub.staff === e.vm.staff;
  if (same)
    return outcome(
      "pass",
      null,
      `The hub and the VM agree: ${total(e.hub)} ticket${total(e.hub) === 1 ? "" : "s"}, ${e.hub.staff} staff.`,
      details,
    );
  if (e.lastPullAt === null)
    return outcome(
      "fail",
      "data_never_pulled",
      "The counts differ and the hub has never pulled.",
      details,
    );
  const age = e.now - e.lastPullAt;
  details.pull_age_seconds = age;
  // One pull interval of slack (plus a little for the pull itself): changes made on the VM since
  // the last pull are not on the hub yet, and that is normal.
  if (age > e.pullIntervalSeconds + 10)
    return outcome(
      "fail",
      "data_stale",
      `The counts differ and the hub last pulled ${age} s ago.`,
      details,
    );
  const behind = total(e.vm) - total(e.hub);
  if (e.hub.staff <= e.vm.staff && behind >= 0)
    return outcome(
      "pass",
      null,
      `The hub is ${behind} ticket${behind === 1 ? "" : "s"} behind the VM, less than one pull interval (last pull ${age} s ago).`,
      details,
    );
  return outcome("fail", "data_mismatch", "The hub holds different data than the VM.", details);
}

// ---- Step 7: a phone through the hub ----------------------------------------------------------

export const PHONE_RECENT_SECONDS = 300;

export function evaluatePhoneViaHub(e: {
  now: number;
  phones: { label: string | null; gate: string; lastSeenAt: number | null }[];
}): CheckOutcome {
  if (e.phones.length === 0)
    return outcome("fail", "no_phones", "No phone is set up for this event.");
  const recent = e.phones
    .filter((p) => p.lastSeenAt !== null && e.now - p.lastSeenAt <= PHONE_RECENT_SECONDS)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  const newest = e.phones.reduce<number | null>(
    (m, p) => (p.lastSeenAt !== null && (m === null || p.lastSeenAt > m) ? p.lastSeenAt : m),
    null,
  );
  const details: CheckDetails = {
    phones: e.phones.length,
    recent: recent.length,
    last_seen_at: newest,
  };
  if (recent.length === 0)
    return outcome(
      "fail",
      "phone_quiet",
      "No phone has reported through the hub in the last 5 minutes.",
      details,
    );
  const first = recent[0]!;
  return outcome(
    "pass",
    null,
    `${recent.length} phone${recent.length === 1 ? "" : "s"} reported through the hub in the last 5 minutes (latest: ${first.label ?? first.gate}).`,
    { ...details, phone: first.label ?? first.gate },
  );
}

// ---- Step 8: offline scan ---------------------------------------------------------------------

export interface Outage {
  from: number;
  /** null while the uplink is still down. */
  to: number | null;
}

export function evaluateOfflineScan(e: {
  now: number;
  /** When the person pressed "Start the offline test"; null if they did not. */
  startedAt: number | null;
  outages: Outage[];
  /** Scans the hub received (its own clock) and when the VM acknowledged them (null: not yet). */
  scans: { receivedAt: number; ackedAt: number | null }[];
}): CheckOutcome {
  const details: CheckDetails = { started_at: e.startedAt };
  if (e.startedAt === null)
    return outcome("fail", "offline_not_tested", "The offline test has not been started.", details);
  const since = e.startedAt;
  const outages = e.outages.filter((o) => (o.to ?? Infinity) >= since);
  if (outages.length === 0)
    return outcome(
      "fail",
      "offline_no_outage",
      "The hub did not see its uplink go down since the test started.",
      details,
    );
  const last = outages[outages.length - 1]!;
  details.outage_from = last.from;
  details.outage_to = last.to;
  // A scan made with the uplink down is received inside the outage and only reaches the VM after
  // it ended; one the VM already had before then was taken while the link still worked.
  const offline = e.scans.filter((s) =>
    outages.some(
      (o) =>
        s.receivedAt >= Math.max(o.from, since) &&
        s.receivedAt <= (o.to ?? Infinity) &&
        (s.ackedAt === null || s.ackedAt >= (o.to ?? 0)),
    ),
  );
  if (offline.length === 0)
    return outcome(
      "fail",
      "offline_no_scan",
      "The uplink was down, but no scan reached the hub during that time.",
      details,
    );
  const delivered = offline.filter((s) => s.ackedAt !== null);
  const scan = delivered[0] ?? offline[0]!;
  details.scan_received_at = scan.receivedAt;
  details.vm_received_at = scan.ackedAt;
  if (delivered.length === 0)
    return outcome(
      "fail",
      "offline_not_delivered",
      "The scan is on the hub, but the VM has not received it yet.",
      details,
    );
  return outcome(
    "pass",
    null,
    `A scan reached the hub with the uplink down and the VM received it ${Math.max(0, scan.ackedAt! - scan.receivedAt)} s later.`,
    details,
  );
}

/** A step that cannot run here: a hub without the VM, or the VM looking at hub-only data. */
export const skipped = (code: "needs_vm" | "run_on_hub", summary: string): CheckOutcome =>
  outcome("skipped", code, summary);
