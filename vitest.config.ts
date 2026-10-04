import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // Each test file opens its own in-memory (or temp-file) database, so files
    // can run in parallel safely.
    fileParallelism: true,
  },
});
