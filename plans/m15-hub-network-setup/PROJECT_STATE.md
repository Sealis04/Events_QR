# Project state — m15-hub-network-setup

- M1–M14 merged (… #27, #28). M14 added the hub's `/setup` page, `HUB_SERVER_URL`, Reset hub and revoke-self.
- `setup.bat` hub prod asks for `HUB_DOMAIN`/`HUB_LAN_IP` only if the user answers Y to "Run the hub's DNS service"; hub dev never asks; neither sets `HUB_DNS_BIND`, opens the firewall or checks DNS. Web app prod asks `HUB_URL` but allows blank; web app dev never asks.
- What went wrong in the user's test on 2026-10-28 (Windows 11, Docker Desktop, dev hub on :3100, NPM in Docker, TP-Link router, name `testhub.intramuros.gov.ph` → 192.168.0.10):
  1. `dns` failed with "ports are not available ... 0.0.0.0:53 ... Only one usage of each socket address" (Windows already holds 53 on a virtual adapter); fixed by `HUB_DNS_BIND=<LAN IP>`.
  2. Phone could not reach the PC: mobile data was on. Then Windows firewall / Public network profile for 53.
  3. Router: IP reservation was set but DHCP Primary DNS was not; phones used the router's DNS and failed with `DNS_PROBE_FINISHED_NO_INTERNET`.
  4. Login over `http://testhub...` failed silently: the hub's session cookie is Secure in production (`NODE_ENV=production` in the image); browsers only exempt `localhost`. The login page then showed "This server only lets supervisors and admins into the dashboard."
  5. NPM certificate failed with the HTTP challenge (`--authenticator webroot`); the DNS challenge (Cloudflare token) is required for a private-IP name.
  6. Phone setup looped: `HUB_URL` was empty on the web app, so the `DEV1:` QR carried `http://localhost:3000`; the code was exchanged at the hub but the first sync could reach neither "hub" (`localhost`) nor cloud (`host.docker.internal`), and the phone went back to the setup screen.
- User decisions 2026-10-28: see the M15 section of the plan. The plan file is the source of truth.
