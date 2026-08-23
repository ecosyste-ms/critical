import { defineConfig } from "vitest/config";

/**
 * Packs the tarball and exercises it: the entrypoint the `exports` map points at, and
 * the `bin` that ships from `dist/`. Needs a build, so it is not in the default suite.
 */
export default defineConfig({
  test: {
    include: ["test/packaged/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
