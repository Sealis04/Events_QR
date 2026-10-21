import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/sqlite.ts",
  out: "./drizzle/sqlite",
});
