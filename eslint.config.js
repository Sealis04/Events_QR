import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "packages/core/drizzle/**",
    ],
  },
  {
    // The scanner's service worker is plain browser JS served as-is.
    files: ["apps/web/public/scan-sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        self: "readonly",
        caches: "readonly",
        fetch: "readonly",
        Response: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "fs", "path", "crypto", "buffer", "os", "child_process"],
              message: "core must run in browsers: no Node-only imports.",
            },
          ],
        },
      ],
      "no-restricted-globals": ["error", { name: "Buffer", message: "Use Uint8Array." }],
    },
  },
);
