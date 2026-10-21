import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "packages/core/drizzle/**"] },
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
