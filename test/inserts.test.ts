import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiAdvisory, ApiPackage } from "../lib/index.js";
import {
  insertAdvisories,
  insertPackage,
  insertRepoMetadata,
  insertVersions,
} from "../lib/index.js";
import { createTempDatabase, type TempDatabase } from "./helpers/db.js";

let fixture: TempDatabase;
let db: DatabaseSync;

beforeEach(() => {
  fixture = createTempDatabase();
  db = fixture.db;
});

afterEach(() => {
  fixture.cleanup();
});

/** A package as `GET /packages/critical` serves it, advisories and repo metadata included. */
const API_PACKAGE: ApiPackage = {
  id: 999,
  ecosystem: "npm",
  name: "test-pkg",
  purl: "pkg:npm/test-pkg",
  namespace: null,
  description: "Test package",
  homepage: null,
  repository_url: "https://github.com/test/test-pkg",
  licenses: "MIT",
  normalized_licenses: ["MIT"],
  latest_release_number: "1.0.0",
  versions_count: 1,
  downloads: 100,
  downloads_period: "last-month",
  dependent_packages_count: 0,
  dependent_repos_count: 0,
  first_release_published_at: "2024-01-01T00:00:00.000Z",
  latest_release_published_at: "2024-01-01T00:00:00.000Z",
  last_synced_at: "2024-01-01T00:00:00.000Z",
  keywords_array: ["test"],
  advisories: [
    {
      uuid: "GHSA-test-1234-5678",
      url: "https://github.com/advisories/GHSA-test-1234-5678",
      title: "Test vulnerability",
      description: "A test vulnerability",
      severity: "HIGH",
      published_at: "2024-01-01T00:00:00.000Z",
      cvss_score: 7.5,
    },
    {
      uuid: "GHSA-test-9999-0000",
      url: "https://github.com/advisories/GHSA-test-9999-0000",
      title: "Another vulnerability",
      description: "Another test",
      severity: "MODERATE",
      published_at: "2024-02-01T00:00:00.000Z",
      cvss_score: 4.0,
    },
  ],
  repo_metadata: {
    owner: "test",
    name: "test-pkg",
    full_name: "test/test-pkg",
    language: "JavaScript",
    stargazers_count: 100,
    forks_count: 10,
    open_issues_count: 5,
    archived: false,
    fork: false,
  },
  host: { name: "github.com" },
};

describe("insertPackage", () => {
  it("maps the API's field names onto the schema's columns", () => {
    insertPackage(db, API_PACKAGE);

    const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(999);

    expect(row).toMatchObject({
      id: 999,
      ecosystem: "npm",
      name: "test-pkg",
      purl: "pkg:npm/test-pkg",
      licenses: "MIT",
      // The three renames the API-to-schema mapping performs.
      latest_version: "1.0.0",
      first_release_at: "2024-01-01T00:00:00.000Z",
      latest_release_at: "2024-01-01T00:00:00.000Z",
      // keywords_array is flattened to a space-joined string for FTS.
      keywords: "test",
    });
  });

  it("stores normalized_licenses as JSON", () => {
    insertPackage(db, API_PACKAGE);

    const row = db.prepare("SELECT normalized_licenses FROM packages WHERE id = ?").get(999);

    expect(JSON.parse(String(row?.normalized_licenses))).toEqual(["MIT"]);
  });

  it("binds a package that carries only its required fields", () => {
    // node:sqlite rejects undefined bindings, so every optional field has to reach the
    // bind as null. A package with nothing but the three required fields is the shape
    // that catches a missed `?? null`.
    const bare: ApiPackage = { id: 500, ecosystem: "pypi", name: "bare" };

    expect(() => insertPackage(db, bare)).not.toThrow();

    const row = db.prepare("SELECT * FROM packages WHERE id = ?").get(500);

    expect(row).toMatchObject({
      name: "bare",
      purl: null,
      keywords: null,
      normalized_licenses: null,
    });
  });
});

describe("insertAdvisories", () => {
  beforeEach(() => {
    insertPackage(db, API_PACKAGE);
  });

  it("inserts each advisory against its package", () => {
    insertAdvisories(db, API_PACKAGE.id, API_PACKAGE.advisories);

    const advisories = db
      .prepare("SELECT * FROM advisories WHERE package_id = ? ORDER BY id")
      .all(999);

    expect(advisories).toHaveLength(2);
    expect(advisories.map((row) => row.severity)).toEqual(["HIGH", "MODERATE"]);
    expect(advisories[0]).toMatchObject({
      uuid: "GHSA-test-1234-5678",
      title: "Test vulnerability",
      cvss_score: 7.5,
    });
  });

  it("skips the holes the API leaves in the list", () => {
    // null, empty lists and lists with holes all arrive from the API, and none of them
    // may reach a bind.
    const holey: (ApiAdvisory | null | undefined)[] = [
      null,
      { uuid: "GHSA-real-0000-0000" },
      undefined,
    ];

    expect(() => insertAdvisories(db, 999, null)).not.toThrow();
    expect(() => insertAdvisories(db, 999, [])).not.toThrow();
    expect(() => insertAdvisories(db, 999, holey)).not.toThrow();

    const advisories = db.prepare("SELECT * FROM advisories WHERE package_id = ?").all(999);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ uuid: "GHSA-real-0000-0000", severity: null });
  });

  it("is idempotent on the package/uuid pair", () => {
    // The build re-runs from scratch, but idx_advisories_package_uuid is what makes a
    // repeated advisory replace rather than duplicate.
    insertAdvisories(db, API_PACKAGE.id, API_PACKAGE.advisories);
    insertAdvisories(db, API_PACKAGE.id, API_PACKAGE.advisories);

    expect(db.prepare("SELECT * FROM advisories WHERE package_id = ?").all(999)).toHaveLength(
      2,
    );
  });
});

describe("insertVersions", () => {
  beforeEach(() => {
    insertPackage(db, API_PACKAGE);
  });

  it("stores every version number against its package", () => {
    insertVersions(db, API_PACKAGE.id, ["1.0.0", "0.9.0", "0.8.0"]);

    const numbers = db
      .prepare("SELECT number FROM versions WHERE package_id = ?")
      .all(999)
      .map((row) => row.number);

    expect(numbers).toEqual(expect.arrayContaining(["1.0.0", "0.9.0", "0.8.0"]));
  });

  it("inserts nothing for an empty or missing list", () => {
    insertVersions(db, API_PACKAGE.id, null);
    insertVersions(db, API_PACKAGE.id, []);

    expect(db.prepare("SELECT * FROM versions WHERE package_id = ?").all(999)).toEqual([]);
  });

  it("is idempotent on the package/number pair", () => {
    insertVersions(db, API_PACKAGE.id, ["1.0.0"]);
    insertVersions(db, API_PACKAGE.id, ["1.0.0"]);

    expect(db.prepare("SELECT * FROM versions WHERE package_id = ?").all(999)).toHaveLength(1);
  });
});

describe("insertRepoMetadata", () => {
  it("stores metadata with its host", () => {
    db.prepare(
      "INSERT INTO packages (id, ecosystem, name) VALUES (999, 'npm', 'test-pkg')",
    ).run();

    insertRepoMetadata(db, 999, API_PACKAGE.repo_metadata, API_PACKAGE.host);

    const row = db.prepare("SELECT * FROM repo_metadata WHERE package_id = ?").get(999);

    expect(row).toMatchObject({
      owner: "test",
      repo_name: "test-pkg",
      full_name: "test/test-pkg",
      host: "github.com",
      language: "JavaScript",
      stargazers_count: 100,
      archived: 0,
      fork: 0,
    });
  });

  it("handles partial metadata with no name and no host", () => {
    // Real-world API shape: ~10% of critical packages have repo_metadata with full_name
    // but no name field, and no host object at all. node:sqlite rejects undefined
    // bindings, so these must be coerced to null.
    db.prepare(`
      INSERT INTO packages (id, ecosystem, name, purl)
      VALUES (998, 'pypi', 'pytest-asyncio', 'pkg:pypi/pytest-asyncio')
    `).run();

    const repoMetadata = {
      full_name: "pytest-dev/pytest-asyncio",
      owner: "pytest-dev",
      archived: false,
      fork: false,
      stargazers_count: 1398,
      open_issues_count: 52,
      forks_count: 145,
      // note: no `name`, no `language` -- and host is undefined below
    };

    expect(() => insertRepoMetadata(db, 998, repoMetadata, undefined)).not.toThrow();

    const row = db.prepare("SELECT * FROM repo_metadata WHERE package_id = ?").get(998);

    expect(row).toMatchObject({
      owner: "pytest-dev",
      full_name: "pytest-dev/pytest-asyncio",
      repo_name: null,
      host: null,
      language: null,
      stargazers_count: 1398,
    });
  });

  it("inserts nothing when there is no metadata", () => {
    insertRepoMetadata(db, 997, null, { name: "github.com" });

    expect(db.prepare("SELECT * FROM repo_metadata WHERE package_id = ?").get(997)).toBe(
      undefined,
    );
  });
});
