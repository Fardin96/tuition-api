import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ["./src/tests/global-setup.ts"],
    setupFiles: ["./src/tests/setup.ts"],
    pool: "threads",
    fileParallelism: false,
  },
});
