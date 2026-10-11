import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The renderer is DOM code; happy-dom is enough for it and starts an order
    // of magnitude faster than jsdom. yaml/prune tests are environment-neutral.
    environment: "happy-dom",
  },
});
