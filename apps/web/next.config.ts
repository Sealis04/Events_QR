import { resolve } from "node:path";
import type { NextConfig } from "next";

// Settings come from the environment. `bun dev` passes the repo-root .env to Node
// (--env-file-if-exists), and compose sets them on the VM.
const config: NextConfig = {
  output: "standalone",
  // The repo lints with `bun run lint` (ESLint + Prettier), not `next lint`.
  eslint: { ignoreDuringBuilds: true },
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  transpilePackages: ["@events-qr/core"],
  async headers() {
    return [
      {
        // The worker must always be re-checked so a new deploy reaches phones.
        source: "/scan-sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
  // Native / WASM packages stay outside the bundle and load at runtime.
  serverExternalPackages: [
    "libsodium-wrappers",
    "libsodium",
    "mysql2",
    "@node-rs/argon2",
    "qrcode",
  ],
};

export default config;
