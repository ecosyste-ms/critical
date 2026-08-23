import { defineConfig } from "vitest/config";

/**
 * The default suite: everything runs against `lib/` sources, so it needs no build.
 * The packaged suite -- which checks what `npm pack` actually ships -- is excluded
 * here and run separately with `npm run test:packaged`.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/packaged/**"],
  },
});
