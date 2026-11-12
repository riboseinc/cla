import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
      "packages/kernel/**/*.test.ts",
      "packages/kernel/test/**/*.test.ts",
    ],
  },
});
