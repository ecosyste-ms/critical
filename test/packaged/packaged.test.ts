import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The runtime export surface. Losing one silently breaks every consumer, so this list is
 * exhaustive rather than a subset: adding an export is a deliberate edit here too.
 *
 * The seven 1.1.0 shipped, plus `insertAdvisories` / `insertPackage` / `insertVersions`,
 * exported in 1.2.0 so the tests can drive them instead of retyping their SQL, plus
 * `registryFor`, exported in 1.3.0 when registry routing moved to the SDK.
 */
const EXPECTED_EXPORTS = [
  "build",
  "createDatabase",
  "databasePath",
  "extractDatabase",
  "fetchAllCriticalPackages",
  "fetchVersionNumbers",
  "insertAdvisories",
  "insertPackage",
  "insertRepoMetadata",
  "insertVersions",
  "registryFor",
];

let workDir: string;
let packageDir: string;
let tarballPath: string;
let consumerDir: string;

/**
 * Installs the packed tarball into a fresh consumer project and returns its root.
 *
 * The package has a dependency, so an unpacked tarball has no `node_modules` to resolve
 * it from. Installing is also the path a real consumer takes.
 */
function installTarball(prefix: string): string {
  const consumerDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.0.0", private: true }),
  );
  execSync(`npm install --no-save --no-audit --no-fund --ignore-scripts "${tarballPath}"`, {
    cwd: consumerDir,
    stdio: "pipe",
  });
  return consumerDir;
}
// biome-ignore lint/suspicious/noExplicitAny: the entrypoint is loaded from a tarball, not typed source.
let entrypoint: any;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "critical-packaged-"));

  // Relative filenames throughout: git-bash tar reads a `C:/...` argument to -f as a
  // remote host and fails.
  execSync(`npm pack --pack-destination "${workDir}"`, { cwd: projectRoot, stdio: "pipe" });
  const tarball = readdirSync(workDir).find((f) => f.endsWith(".tgz"));
  expect(tarball, "npm pack produced a tarball").toBeTruthy();
  tarballPath = join(workDir, tarball as string);

  consumerDir = installTarball("critical-consumer-");
  packageDir = join(consumerDir, "node_modules", "@ecosyste-ms", "critical");
  entrypoint = await import(pathToFileURL(join(packageDir, "dist", "index.js")).href);
}, 120_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(consumerDir, { recursive: true, force: true });
});

describe("the published entrypoint", () => {
  it("loads from the path the exports map points at", () => {
    expect(entrypoint).toBeTruthy();
  });

  it("still exports everything consumers import", () => {
    expect(Object.keys(entrypoint).sort()).toEqual(EXPECTED_EXPORTS);
  });

  it("resolves databasePath inside the installed package", () => {
    expect(entrypoint.databasePath).toBe(join(packageDir, "critical-packages.db"));
  });
});

describe("the published bin", () => {
  const runBin = (args: string[]) =>
    execFileSync("node", [join(packageDir, "dist", "bin.js"), ...args], {
      cwd: packageDir,
      encoding: "utf8",
    });

  it("shows usage for --help", () => {
    const output = runBin(["--help"]);

    expect(output).toContain("Usage: critical");
    expect(output).toContain("--output");
    expect(output).toContain("--skip-versions");
    expect(output).toContain("--stats");
    expect(output).toContain("@ecosyste-ms/critical");
  });

  it("shows usage for -h", () => {
    expect(runBin(["-h"])).toContain("Usage: critical");
  });

  it("reports statistics for a database", () => {
    // Built with the packaged createDatabase, so the schema under test is the shipped one.
    const statsDb = join(workDir, "stats.db");
    const db = entrypoint.createDatabase(statsDb);
    db.prepare(
      "INSERT INTO packages (id, ecosystem, name, keywords) VALUES (1, 'npm', 'a', 't')",
    ).run();
    db.prepare(
      "INSERT INTO packages (id, ecosystem, name, keywords) VALUES (2, 'npm', 'b', 't')",
    ).run();
    db.prepare(
      "INSERT INTO advisories (package_id, uuid, severity) VALUES (1, 'GHSA-1234', 'HIGH')",
    ).run();
    db.close();

    const output = runBin(["--stats", "-o", statsDb]);

    expect(output).toContain("Packages: 2");
    expect(output).toContain("Advisories: 1");
    expect(output).toContain("npm: 2");
    expect(output).toContain("HIGH: 1");
  });
});

/**
 * Installs the tarball the way a consumer does, rather than reading files out of it.
 * The tests above import `dist/index.js` by path and run `node dist/bin.js` directly,
 * so neither goes through the `exports` map or the `bin` mapping; these do.
 *
 * Note this does NOT catch a malformed `bin` path -- npm links from the tarball's own
 * package.json, which keeps whatever was written. That is the manifest suite below.
 */
describe("the installed package", () => {
  const isWindows = process.platform === "win32";
  const binName = isWindows ? "critical.cmd" : "critical";
  let link: string;

  beforeAll(() => {
    link = join(consumerDir, "node_modules", ".bin", binName);
  });

  it("links the critical bin", () => {
    expect(existsSync(link), `npm did not link ${link}`).toBe(true);
  });

  it("runs the linked bin", () => {
    const output = isWindows
      ? execFileSync("cmd", ["/c", link, "--help"], { encoding: "utf8" })
      : execFileSync(link, ["--help"], { encoding: "utf8" });

    expect(output).toContain("Usage: critical");
  });

  it("resolves the bare specifier through the exports map", () => {
    const resolved = execFileSync(
      "node",
      ["-e", "process.stdout.write(require.resolve('@ecosyste-ms/critical'))"],
      { cwd: consumerDir, encoding: "utf8" },
    );

    expect(resolved).toBe(
      join(consumerDir, "node_modules", "@ecosyste-ms", "critical", "dist", "index.js"),
    );
  });
});

/**
 * The tarball is not the whole contract: `npm publish` normalises the manifest it sends
 * to the registry, and silently drops fields it considers malformed -- a leading `./` on
 * a `bin` path is enough to lose the entry, while the tarball's own package.json keeps
 * it. Nothing else in this suite can see that, because nothing else publishes.
 */
describe("the published manifest", () => {
  it("needs no corrections from npm", () => {
    // npm reports corrections on stderr, so both streams have to be read.
    // One shell string, not an args array: node refuses to spawn npm.cmd without a
    // shell on Windows, and `shell` plus an args array is deprecated (DEP0190).
    // --tag avoids npm comparing against the registry's published "latest": this
    // repo's version and the daily-published version on npm are allowed to diverge,
    // and without --tag npm refuses to dry-run publish once they do.
    const result = spawnSync("npm publish --dry-run --access public --tag ci-dry-run", {
      cwd: projectRoot,
      encoding: "utf8",
      shell: true,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output, "npm rewrote the manifest it would publish").not.toContain("auto-corrected");
  });
});

/**
 * Importing the package extracts the bundled `.gz` into the package root, and
 * `@ecosyste-ms/mcp` relies on exactly that side effect (`test-helpers/warm-db.js`).
 * It resolves through `__dirname/..`, so moving the entrypoint from `lib/` to `dist/`
 * is precisely the change that could break it -- and it is invisible to every other
 * test here, because the repo tree has no `.gz` to extract.
 */
describe("the bundled database", () => {
  it("extracts on first import", async () => {
    // A fresh install rather than a copy of packageDir, which would have no
    // node_modules to resolve the dependency from.
    const bundledDir = installTarball("critical-bundled-");
    const installed = join(bundledDir, "node_modules", "@ecosyste-ms", "critical");
    try {
      const dbPath = join(installed, "critical-packages.db");
      const gzPath = `${dbPath}.gz`;

      // A real database, gzipped where the published tarball would carry it.
      const seed = join(bundledDir, "seed.db");
      entrypoint.createDatabase(seed).close();
      await pipeline(createReadStream(seed), createGzip(), createWriteStream(gzPath));
      expect(existsSync(dbPath), "no database before the import").toBe(false);

      // A fresh URL, so this is a real first import rather than the module cache.
      const url = `${pathToFileURL(join(installed, "dist", "index.js")).href}?bundled`;
      const mod = await import(url);

      expect(existsSync(dbPath), "import did not extract the bundled database").toBe(true);
      expect(mod.databasePath).toBe(dbPath);
      new DatabaseSync(dbPath, { readOnly: true }).close();
    } finally {
      rmSync(bundledDir, { recursive: true, force: true });
    }
  });
});
