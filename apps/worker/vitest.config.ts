import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// DB_* come from the repo-root .env (as for the app); the suite makes its own throwaway databases.
const envFile = resolve(import.meta.dirname, "../../.env");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {},
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
