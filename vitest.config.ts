import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "json", "html"],
    },
    include: [
      "experiments/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "scripts/test/**/*.test.ts",
    ],
  },
});
