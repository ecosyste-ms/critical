import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databasePath } from "../lib/index.js";
import { createTempDatabase, type TempDatabase } from "./helpers/db.js";

let fixture: TempDatabase;
let db: DatabaseSync;

const LODASH = {
  id: 1,
  ecosystem: "npm",
  name: "lodash",
  purl: "pkg:npm/lodash",
  namespace: null,
  description: "Lodash modular utilities",
  homepage: "https://lodash.com/",
  repository_url: "https://github.com/lodash/lodash",
  licenses: "MIT",
  normalized_licenses: ["MIT"],
  latest_release_number: "4.17.21",
  versions_count: 114,
  downloads: 307500000,
  downloads_period: "last-month",
  dependent_packages_count: 159122,
  dependent_repos_count: 1900000,
  first_release_published_at: "2012-04-12T00:00:00.000Z",
  latest_release_published_at: "2021-02-20T15:42:16.891Z",
  last_synced_at: "2024-01-01T00:00:00.000Z",
  keywords_array: ["utilities", "lodash", "modules"],
};

beforeAll(() => {
  fixture = createTempDatabase();
  db = fixture.db;

  db.prepare(`
    INSERT INTO packages (
      id, ecosystem, name, purl, namespace, description, homepage,
      repository_url, licenses, normalized_licenses, latest_version,
      versions_count, downloads, downloads_period, dependent_packages_count,
      dependent_repos_count, first_release_at, latest_release_at,
      last_synced_at, keywords
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    LODASH.id,
    LODASH.ecosystem,
    LODASH.name,
    LODASH.purl,
    LODASH.namespace,
    LODASH.description,
    LODASH.homepage,
    LODASH.repository_url,
    LODASH.licenses,
    JSON.stringify(LODASH.normalized_licenses),
    LODASH.latest_release_number,
    LODASH.versions_count,
    LODASH.downloads,
    LODASH.downloads_period,
    LODASH.dependent_packages_count,
    LODASH.dependent_repos_count,
    LODASH.first_release_published_at,
    LODASH.latest_release_published_at,
    LODASH.last_synced_at,
    LODASH.keywords_array.join(" "),
  );

  db.prepare(`
    INSERT INTO packages (id, ecosystem, name, purl, description, keywords)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    2,
    "pypi",
    "requests",
    "pkg:pypi/requests",
    "Python HTTP library",
    "http requests python",
  );

  const version = db.prepare("INSERT INTO versions (package_id, number) VALUES (?, ?)");
  version.run(1, "4.17.21");
  version.run(1, "4.17.20");
  version.run(1, "4.17.19");

  const advisory = db.prepare(`
    INSERT INTO advisories (package_id, uuid, url, title, severity, published_at, cvss_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  advisory.run(
    1,
    "GHSA-29mw-wpgm-hmr9",
    "https://github.com/advisories/GHSA-29mw-wpgm-hmr9",
    "ReDoS in lodash",
    "MODERATE",
    "2022-01-06T20:30:46.000Z",
    5.3,
  );
  advisory.run(
    1,
    "GHSA-p6mc-m468-83gw",
    "https://github.com/advisories/GHSA-p6mc-m468-83gw",
    "Command Injection in lodash",
    "HIGH",
    "2021-05-06T00:00:00.000Z",
    7.2,
  );

  db.prepare(`
    INSERT INTO repo_metadata (package_id, owner, repo_name, full_name, host, language, stargazers_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, "lodash", "lodash", "lodash/lodash", "github.com", "JavaScript", 61500);
});

afterAll(() => {
  fixture.cleanup();
});

describe("module surface", () => {
  it("exports databasePath", () => {
    expect(databasePath).toBeTruthy();
    expect(databasePath.endsWith("critical-packages.db")).toBe(true);
  });
});

describe("createDatabase", () => {
  it("creates every table the schema declares", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "packages",
        "versions",
        "advisories",
        "repo_metadata",
        "build_info",
        "packages_fts",
      ]),
    );
  });
});

describe("packages", () => {
  it("round-trips a package", () => {
    const row = db
      .prepare("SELECT * FROM packages WHERE ecosystem = ? AND name = ?")
      .get("npm", "lodash");

    expect(row).toMatchObject({
      id: 1,
      ecosystem: "npm",
      name: "lodash",
      purl: "pkg:npm/lodash",
      licenses: "MIT",
      keywords: "utilities lodash modules",
    });
  });

  it("finds a package by purl", () => {
    const row = db.prepare("SELECT * FROM packages WHERE purl = ?").get("pkg:npm/lodash");

    expect(row?.name).toBe("lodash");
  });

  it("filters by ecosystem", () => {
    const npm = db.prepare("SELECT * FROM packages WHERE ecosystem = ?").all("npm");
    const pypi = db.prepare("SELECT * FROM packages WHERE ecosystem = ?").all("pypi");

    expect(npm.map((row) => row.name)).toEqual(["lodash"]);
    expect(pypi.map((row) => row.name)).toEqual(["requests"]);
  });

  it("filters by license", () => {
    const mit = db.prepare("SELECT * FROM packages WHERE licenses = ?").all("MIT");

    expect(mit).toHaveLength(1);
  });
});

describe("versions", () => {
  it("stores every version number for a package", () => {
    const versions = db
      .prepare("SELECT * FROM versions WHERE package_id = ?")
      .all(1)
      .map((row) => row.number);

    expect(versions).toHaveLength(3);
    expect(versions).toEqual(expect.arrayContaining(["4.17.21", "4.17.20", "4.17.19"]));
  });
});

describe("advisories", () => {
  it("stores every advisory for a package", () => {
    const advisories = db.prepare("SELECT * FROM advisories WHERE package_id = ?").all(1);

    expect(advisories).toHaveLength(2);
  });

  it("finds an advisory by uuid", () => {
    const row = db
      .prepare("SELECT * FROM advisories WHERE uuid = ?")
      .get("GHSA-29mw-wpgm-hmr9");

    expect(row).toMatchObject({ package_id: 1, severity: "MODERATE" });
  });

  it("filters by severity", () => {
    const high = db.prepare("SELECT * FROM advisories WHERE severity = ?").all("HIGH");

    expect(high).toHaveLength(1);
    expect(high[0]?.title).toBe("Command Injection in lodash");
  });
});

describe("repo_metadata", () => {
  it("finds repository metadata by full name", () => {
    const row = db
      .prepare("SELECT * FROM repo_metadata WHERE full_name = ?")
      .get("lodash/lodash");

    expect(row?.stargazers_count).toBe(61500);
  });
});

describe("packages_fts", () => {
  const search = (match: string) =>
    db
      .prepare(`
        SELECT p.* FROM packages p
        JOIN packages_fts fts ON p.id = fts.rowid
        WHERE packages_fts MATCH ?
      `)
      .all(match);

  it("matches on description", () => {
    const results = search("utilities");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe("lodash");
  });

  it("matches on a name column filter", () => {
    expect(search("name:lodash").length).toBeGreaterThan(0);
  });

  it("matches on a keywords column filter", () => {
    const results = search("keywords:modules");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe("lodash");
  });
});
