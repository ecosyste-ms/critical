import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApiPackage, type BuildOptions, build } from "../lib/index.js";

/**
 * `build()` driven by a fake client rather than the network.
 *
 * The fetch loop swallows per-package failures by design, so the only thing standing
 * between a rate-limited run and a published database missing half its versions is the
 * failure-rate threshold. Nothing else exercises it.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "critical-build-"));
  dbPath = join(dir, "build.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePackages(count: number): ApiPackage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    ecosystem: "npm",
    name: `pkg-${i + 1}`,
    purl: `pkg:npm/pkg-${i + 1}`,
  })) as ApiPackage[];
}

/** A client whose `getVersionNumbers` throws for the first `failures` calls it sees. */
function fakeClient(packages: ApiPackage[], failures = 0) {
  const registries: string[] = [];
  let seen = 0;

  return {
    registries,
    async listCriticalPackages() {
      return packages as never;
    },
    async getVersionNumbers(registry: string, name: string) {
      registries.push(registry);
      seen++;
      if (seen <= failures) throw new Error(`HTTP 429: ${name}`);
      return ["1.0.0", "1.1.0"];
    },
  };
}

function run(options: BuildOptions) {
  const messages: string[] = [];
  return {
    messages,
    result: build({ dbPath, onProgress: (m) => messages.push(m), ...options }),
  };
}

describe("build", () => {
  it("stores packages and their versions", async () => {
    const packages = makePackages(3);
    const client = fakeClient(packages);

    const info = await build({ dbPath, client, onProgress: () => {} });

    expect(info.package_count).toBe(3);
    expect(info.version_count).toBe(6);
    // Routed through the purl, so every call went to the npm registry rather than to a
    // path built from the raw ecosystem string.
    expect(new Set(client.registries)).toEqual(new Set(["npmjs.org"]));

    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 6 });
    db.close();
  });

  it("skips the version fetch entirely when asked to", async () => {
    const client = fakeClient(makePackages(3));

    const info = await build({
      dbPath,
      client,
      fetchVersionsData: false,
      onProgress: () => {},
    });

    expect(info.package_count).toBe(3);
    expect(info.version_count).toBe(0);
    expect(client.registries).toEqual([]);
  });

  it("tolerates a failure rate under the threshold, and says so", async () => {
    // 1 of 40 = 2.5%, under the 5% limit: the build publishes, and reports the loss.
    const packages = makePackages(40);
    const { messages, result } = run({ client: fakeClient(packages, 1) });
    const info = await result;

    expect(info.package_count).toBe(40);
    expect(info.version_count).toBe(78);
    expect(messages.some((m) => m.includes("version fetch failed for 1/40"))).toBe(true);
    expect(messages.some((m) => m.includes("HTTP 429"))).toBe(true);
  });

  it("throws rather than publish a build that lost too many versions", async () => {
    // 8 of 40 = 20%, over the limit.
    const packages = makePackages(40);

    await expect(
      build({ dbPath, client: fakeClient(packages, 8), onProgress: () => {} }),
    ).rejects.toThrow(/20\.0% of packages/);
  });

  it("counts an unroutable ecosystem as zero versions, not as a failure", async () => {
    // No purl and a name the registry table does not know: there is nothing to ask, so
    // the package contributes no versions and the build still succeeds.
    const packages = [
      { id: 1, ecosystem: "fakesystem", name: "orphan" },
      { id: 2, ecosystem: "npm", name: "lodash", purl: "pkg:npm/lodash" },
    ] as ApiPackage[];
    const client = fakeClient(packages);

    const info = await build({ dbPath, client, onProgress: () => {} });

    expect(info.version_count).toBe(2);
    expect(client.registries).toEqual(["npmjs.org"]);
  });
});
