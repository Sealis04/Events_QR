# Handoff — m1-core-tokens

Goal: build `packages/core`, the shared token, rule and schema library used by the server, the hub and the scanner, plus the monorepo scaffold.

Why it goes first: every later milestone imports these formats and rules. Getting the byte layout and claim rules right here (with test vectors) prevents drift between the server, hub and phones.

Read in order: `CLAUDE.md`, `plans/m1-core-tokens/inbox/builder-1.md`, the M1 section of `plans/offline-qr-ticketing/plan.md`, then the sections of `docs/spec.md` named in the inbox.

Next after approval: the planner opens `m2-cloud-issuance` (server issuance on the VM).
