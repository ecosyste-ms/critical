import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import {
  createEcosystemsClient,
  type EcosystemsClient,
  type PackageWithRegistry,
  PURL_TYPE_TO_REGISTRY,
  parsePurl,
  purlToRegistry,
} from "@ecosyste-ms/ecosystems-ts";

interface PackageManifest {
  name: string;
  version: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  await readFile(join(__dirname, "..", "package.json"), "utf8"),
) as PackageManifest;
const databasePath = join(__dirname, "..", "critical-packages.db");
const gzPath = join(__dirname, "..", "critical-packages.db.gz");

/**
 * Every field optional and nullable.
 *
 * The OpenAPI spec marks most package fields required and non-null; the API omits them
 * and sends explicit nulls. Modelling what actually arrives is what keeps the runtime
 * guards below honest instead of looking redundant.
 */
type Loose<T> = { [K in keyof T]?: T[K] | null };

/**
 * Repository metadata as `GET /packages/critical` serves it -- every field optional.
 *
 * The API sends `full_name` ("owner/repo") but never `name`, and nests the host here
 * rather than on the package. Both were previously read from the wrong place, which left
 * `repo_metadata.repo_name` and `repo_metadata.host` NULL in every published build.
 */
export interface ApiRepoMetadata {
  owner?: string | null;
  name?: string | null;
  full_name?: string | null;
  language?: string | null;
  stargazers_count?: number | null;
  forks_count?: number | null;
  open_issues_count?: number | null;
  archived?: boolean | null;
  fork?: boolean | null;
  host?: ApiHost | null;
}

/** The registry host, as nested inside `repo_metadata`. */
export interface ApiHost {
  name?: string | null;
}

/**
 * An advisory as the API nests it in a package.
 *
 * Derived from the package schema rather than the SDK's top-level `Advisory`: the two
 * specs describe the same objects differently -- `advisories.ecosyste.ms` types the
 * optional fields `string | undefined`, while the copy embedded in a package uses
 * `string | null`, which is what the API actually sends.
 */
type PackageAdvisory = NonNullable<PackageWithRegistry["advisories"]>[number];
export type ApiAdvisory = Loose<PackageAdvisory>;

/**
 * A package from `GET /packages/critical`, as the SDK types it.
 *
 * `repo_metadata` is overridden: the OpenAPI spec types it `Record<string, never>` -- a
 * known-opaque object -- while this package reads nine fields out of it. Everything else
 * is the generated shape.
 *
 * The spec is stricter than the API. It declares `normalized_licenses`, `purl` and
 * `keywords_array` required and non-null; they are not always sent. Every runtime guard
 * below stays regardless of what these types claim.
 */
export type ApiPackage = Loose<Omit<PackageWithRegistry, "repo_metadata" | "advisories">> &
  Pick<PackageWithRegistry, "id" | "ecosystem" | "name"> & {
    advisories?: (ApiAdvisory | null)[] | null;
    repo_metadata?: ApiRepoMetadata | null;
  };

/** The single `build_info` row, written at the end of every build. */
export interface BuildInfo {
  built_at: string;
  package_count: number;
  version_count: number;
  advisory_count: number;
}

export type ProgressReporter = (message: string) => void;

export interface BuildOptions {
  dbPath?: string;
  fetchVersionsData?: boolean;
  onProgress?: ProgressReporter;
  /**
   * The API client. Defaults to the shared one; a substitute lets the tests drive the
   * fetch loop's failure accounting without a network.
   */
  client?: Pick<EcosystemsClient, "listCriticalPackages" | "getVersionNumbers">;
}

// Extract via a uniquely named temp file, then rename into place. rename(2) is atomic
// within a filesystem, so concurrent importers see either no database or a complete
// one. Streaming straight to databasePath let them interleave and produce a file
// SQLite rejects with "database disk image is malformed" -- permanently, since the
// corrupt file then satisfies the existsSync check on every subsequent run.
async function extractDatabase(source: string, destination: string): Promise<void> {
  const tmpPath = `${destination}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await pipeline(createReadStream(source), createGunzip(), createWriteStream(tmpPath));
    await rename(tmpPath, destination);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    // Another importer finished first and holds the destination open; on Windows that
    // makes the rename fail. A complete database is there either way, so this is a win.
    if (!existsSync(destination)) throw err;
  }
}

if (!existsSync(databasePath) && existsSync(gzPath)) {
  await extractDatabase(gzPath, databasePath);
}

const CONCURRENCY = 10;

/** Above this share of failed version fetches the build throws instead of publishing. */
const MAX_VERSION_FAILURE_RATE = 0.05;

/**
 * The mailto that moves the build off the anonymous rate-limit tier.
 *
 * Anonymous is 5,000 requests/hour and a full build makes ~9,700, so an unidentified
 * build gets throttled partway through. With a contact address the tier is "polite",
 * 15,000.
 */
const CONTACT_EMAIL = process.env.ECOSYSTEMS_MAILTO?.trim() || undefined;

let client: EcosystemsClient | undefined;

/** The SDK client, created once. Owns retries, backoff, 429/Retry-After and pagination. */
function ecosystemsClient(): EcosystemsClient {
  if (!client) {
    client = createEcosystemsClient({
      userAgent: `${pkg.name}/${pkg.version}`,
      from: CONTACT_EMAIL,
    });
  }
  return client;
}

/**
 * The ecosyste.ms registry for a package, or null when there is nothing to query.
 *
 * Routed through the PURL where there is one: the SDK's table is keyed by PURL type, and
 * that is the vocabulary the API sends.
 *
 * `ecosystem` is the fallback for a package with no PURL, translated through
 * `ECOSYSTEM_TO_PURL_TYPE` first -- the two vocabularies disagree for four of the
 * ecosystems here (`rubygems` vs `gem`, `go` vs `golang`, `packagist` vs `composer`,
 * `homebrew` vs `brew`), and an unresolved registry means zero versions fetched with the
 * build still reporting success.
 */
const ECOSYSTEM_TO_PURL_TYPE: Record<string, string> = {
  rubygems: "gem",
  go: "golang",
  packagist: "composer",
  homebrew: "brew",
};

function registryFor(pkg: { ecosystem?: string | null; purl?: string | null }): string | null {
  if (pkg.purl) {
    try {
      return purlToRegistry(parsePurl(pkg.purl));
    } catch {
      // Malformed PURL: fall through to the ecosystem string.
    }
  }
  const ecosystem = pkg.ecosystem?.toLowerCase();
  if (!ecosystem) return null;
  const key = ECOSYSTEM_TO_PURL_TYPE[ecosystem] ?? ecosystem;
  // Object.hasOwn, not a bare lookup: "constructor" is a valid key and would otherwise
  // return Object itself -- truthy, typed string, and interpolated into a URL path.
  const registry = Object.hasOwn(PURL_TYPE_TO_REGISTRY, key)
    ? PURL_TYPE_TO_REGISTRY[key]
    : undefined;
  return registry || null;
}

async function fetchAllCriticalPackages(
  onProgress?: ProgressReporter,
  api: Pick<EcosystemsClient, "listCriticalPackages"> = ecosystemsClient(),
): Promise<ApiPackage[]> {
  onProgress?.("Fetching critical packages...");
  const packages = await api.listCriticalPackages();
  return packages as ApiPackage[];
}

/** Version numbers for a package, or `[]` when there is no registry to ask. Throws on
 * transport failure -- the caller decides whether one package's loss is tolerable. */
async function fetchVersionNumbers(ecosystem: string, name: string): Promise<string[]> {
  const registry = registryFor({ ecosystem });
  if (!registry) return [];
  return await ecosystemsClient().getVersionNumbers(registry, name);
}

function createDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE packages (
      id INTEGER PRIMARY KEY,
      ecosystem TEXT NOT NULL,
      name TEXT NOT NULL,
      purl TEXT,
      namespace TEXT,
      description TEXT,
      homepage TEXT,
      repository_url TEXT,
      licenses TEXT,
      normalized_licenses TEXT,
      latest_version TEXT,
      versions_count INTEGER,
      downloads INTEGER,
      downloads_period TEXT,
      dependent_packages_count INTEGER,
      dependent_repos_count INTEGER,
      first_release_at TEXT,
      latest_release_at TEXT,
      last_synced_at TEXT,
      keywords TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX idx_packages_ecosystem_name ON packages(ecosystem, name);
    CREATE INDEX idx_packages_purl ON packages(purl);
    CREATE INDEX idx_packages_licenses ON packages(licenses);
    CREATE INDEX idx_packages_ecosystem ON packages(ecosystem);

    CREATE TABLE versions (
      package_id INTEGER NOT NULL,
      number TEXT NOT NULL,
      PRIMARY KEY (package_id, number),
      FOREIGN KEY (package_id) REFERENCES packages(id)
    );

    CREATE TABLE advisories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      uuid TEXT NOT NULL,
      url TEXT,
      title TEXT,
      description TEXT,
      severity TEXT,
      published_at TEXT,
      cvss_score REAL,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    );

    CREATE INDEX idx_advisories_package_id ON advisories(package_id);
    CREATE INDEX idx_advisories_uuid ON advisories(uuid);
    CREATE INDEX idx_advisories_severity ON advisories(severity);
    CREATE UNIQUE INDEX idx_advisories_package_uuid ON advisories(package_id, uuid);

    CREATE TABLE repo_metadata (
      package_id INTEGER PRIMARY KEY,
      owner TEXT,
      repo_name TEXT,
      full_name TEXT,
      host TEXT,
      language TEXT,
      stargazers_count INTEGER,
      forks_count INTEGER,
      open_issues_count INTEGER,
      archived INTEGER,
      fork INTEGER,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    );

    CREATE INDEX idx_repo_full_name ON repo_metadata(full_name);
    CREATE INDEX idx_repo_owner ON repo_metadata(owner);

    CREATE VIRTUAL TABLE packages_fts USING fts5(
      ecosystem,
      name,
      description,
      keywords,
      content=packages,
      content_rowid=id
    );

    CREATE TRIGGER packages_ai AFTER INSERT ON packages BEGIN
      INSERT INTO packages_fts(rowid, ecosystem, name, description, keywords)
      VALUES (new.id, new.ecosystem, new.name, new.description, new.keywords);
    END;

    CREATE TRIGGER packages_ad AFTER DELETE ON packages BEGIN
      INSERT INTO packages_fts(packages_fts, rowid, ecosystem, name, description, keywords)
      VALUES ('delete', old.id, old.ecosystem, old.name, old.description, old.keywords);
    END;

    CREATE TRIGGER packages_au AFTER UPDATE ON packages BEGIN
      INSERT INTO packages_fts(packages_fts, rowid, ecosystem, name, description, keywords)
      VALUES ('delete', old.id, old.ecosystem, old.name, old.description, old.keywords);
      INSERT INTO packages_fts(rowid, ecosystem, name, description, keywords)
      VALUES (new.id, new.ecosystem, new.name, new.description, new.keywords);
    END;

    CREATE TABLE build_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      built_at TEXT NOT NULL,
      package_count INTEGER,
      version_count INTEGER,
      advisory_count INTEGER
    );
  `);

  return db;
}

function insertPackage(db: DatabaseSync, pkg: ApiPackage): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO packages (
      id, ecosystem, name, purl, namespace, description, homepage,
      repository_url, licenses, normalized_licenses, latest_version,
      versions_count, downloads, downloads_period, dependent_packages_count,
      dependent_repos_count, first_release_at, latest_release_at,
      last_synced_at, keywords
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  const keywords = Array.isArray(pkg.keywords_array) ? pkg.keywords_array.join(" ") : null;
  // Not JSON.stringify alone: it returns undefined for undefined, which node:sqlite
  // refuses to bind, and the literal string "null" for null.
  const normalizedLicenses = Array.isArray(pkg.normalized_licenses)
    ? JSON.stringify(pkg.normalized_licenses)
    : null;

  stmt.run(
    pkg.id,
    pkg.ecosystem,
    pkg.name,
    pkg.purl ?? null,
    pkg.namespace ?? null,
    pkg.description ?? null,
    pkg.homepage ?? null,
    pkg.repository_url ?? null,
    pkg.licenses ?? null,
    normalizedLicenses,
    pkg.latest_release_number ?? null,
    pkg.versions_count ?? null,
    pkg.downloads ?? null,
    pkg.downloads_period ?? null,
    pkg.dependent_packages_count ?? null,
    pkg.dependent_repos_count ?? null,
    pkg.first_release_published_at ?? null,
    pkg.latest_release_published_at ?? null,
    pkg.last_synced_at ?? null,
    keywords,
  );

  return pkg.id;
}

function insertRepoMetadata(
  db: DatabaseSync,
  packageId: number,
  repoMetadata: ApiRepoMetadata | null | undefined,
  host?: ApiHost | null,
): void {
  if (!repoMetadata) return;

  // The explicit argument stays for callers that have a host from somewhere else.
  const hostName = host?.name ?? repoMetadata.host?.name ?? null;
  const repoName = repoMetadata.name ?? repoMetadata.full_name?.split("/").pop() ?? null;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO repo_metadata (
      package_id, owner, repo_name, full_name, host, language,
      stargazers_count, forks_count, open_issues_count, archived, fork
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    packageId,
    repoMetadata.owner ?? null,
    repoName,
    repoMetadata.full_name ?? null,
    hostName,
    repoMetadata.language ?? null,
    repoMetadata.stargazers_count ?? null,
    repoMetadata.forks_count ?? null,
    repoMetadata.open_issues_count ?? null,
    repoMetadata.archived ? 1 : 0,
    repoMetadata.fork ? 1 : 0,
  );
}

function insertAdvisories(
  db: DatabaseSync,
  packageId: number,
  advisories: (ApiAdvisory | null | undefined)[] | null | undefined,
): void {
  if (!advisories || advisories.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO advisories (
      package_id, uuid, url, title, description, severity, published_at, cvss_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const advisory of advisories) {
    if (!advisory?.uuid) continue;
    stmt.run(
      packageId,
      advisory.uuid,
      advisory.url ?? null,
      advisory.title ?? null,
      advisory.description ?? null,
      advisory.severity ?? null,
      advisory.published_at ?? null,
      advisory.cvss_score ?? null,
    );
  }
}

function insertVersions(
  db: DatabaseSync,
  packageId: number,
  versionNumbers: string[] | null | undefined,
): void {
  if (!versionNumbers || versionNumbers.length === 0) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO versions (package_id, number) VALUES (?, ?)
  `);

  for (const number of versionNumbers) {
    stmt.run(packageId, number);
  }
}

/** `SELECT COUNT(*)`, narrowed: node:sqlite hands back `Record<string, SQLOutputValue>`. */
function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
  return Number(row?.count ?? 0);
}

function updateBuildInfo(db: DatabaseSync): void {
  db.prepare(`
    INSERT OR REPLACE INTO build_info (id, built_at, package_count, version_count, advisory_count)
    VALUES (1, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    countRows(db, "packages"),
    countRows(db, "versions"),
    countRows(db, "advisories"),
  );
}

async function build(options: BuildOptions = {}): Promise<BuildInfo> {
  const {
    dbPath = "critical-packages.db",
    fetchVersionsData = true,
    onProgress = console.log,
    client: api = ecosystemsClient(),
  } = options;

  await mkdir(dirname(dbPath) || ".", { recursive: true }).catch(() => {});
  await unlink(dbPath).catch(() => {});
  await unlink(`${dbPath}-wal`).catch(() => {});
  await unlink(`${dbPath}-shm`).catch(() => {});

  onProgress("Creating database...");
  const db = createDatabase(dbPath);

  // Otherwise every throw below leaks the handle, which on Windows locks the file the
  // caller is about to clean up. The version-failure threshold makes that a reachable
  // path, not just a corrupt-data one.
  try {
    onProgress("Fetching critical packages...");
    const packages = await fetchAllCriticalPackages(onProgress, api);
    onProgress(`Found ${packages.length} critical packages`);

    onProgress("Inserting packages...");
    db.exec("BEGIN");
    try {
      for (const pkg of packages) {
        insertPackage(db, pkg);
        insertRepoMetadata(db, pkg.id, pkg.repo_metadata);
        insertAdvisories(db, pkg.id, pkg.advisories);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    if (fetchVersionsData) {
      onProgress("Fetching versions...");
      let completed = 0;
      const total = packages.length;

      // One package failing is tolerable; a pattern of failures means the run was
      // throttled. Count them and report at the end rather than swallowing each one.
      let failed = 0;
      let firstError: unknown;

      const processPackage = async (pkg: ApiPackage) => {
        const registry = registryFor(pkg);
        if (!registry) return { pkg, versions: [] as string[] };
        try {
          const versions = await api.getVersionNumbers(registry, pkg.name);
          return { pkg, versions };
        } catch (err) {
          failed++;
          firstError ??= err;
          return { pkg, versions: [] as string[] };
        }
      };

      // Process in batches with concurrency limit
      for (let i = 0; i < packages.length; i += CONCURRENCY) {
        const batch = packages.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(processPackage));

        db.exec("BEGIN");
        try {
          for (const { pkg, versions } of results) {
            if (versions.length > 0) {
              insertVersions(db, pkg.id, versions);
            }
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }

        completed += batch.length;
        onProgress(`Fetched versions for ${completed}/${total} packages`);
      }

      if (failed > 0) {
        const share = ((failed / total) * 100).toFixed(1);
        const reason = firstError instanceof Error ? firstError.message : String(firstError);
        onProgress(`WARNING: version fetch failed for ${failed}/${total} packages (${share}%)`);
        onProgress(`  first failure: ${reason}`);
        // A run that loses this much is not a build worth publishing.
        if (failed / total > MAX_VERSION_FAILURE_RATE) {
          throw new Error(
            `version fetch failed for ${share}% of packages (limit ${(
              MAX_VERSION_FAILURE_RATE * 100
            ).toFixed(0)}%); first failure: ${reason}`,
          );
        }
      }
    }

    updateBuildInfo(db);

    const info = db
      .prepare("SELECT * FROM build_info WHERE id = 1")
      .get() as unknown as BuildInfo;
    onProgress(
      `Build complete: ${info.package_count} packages, ${info.version_count} versions, ${info.advisory_count} advisories`,
    );

    return info;
  } finally {
    // The success path returns through here too, and close() is not idempotent.
    db.close();
  }
}

export {
  build,
  createDatabase,
  databasePath,
  extractDatabase,
  fetchAllCriticalPackages,
  fetchVersionNumbers,
  insertAdvisories,
  insertPackage,
  insertRepoMetadata,
  insertVersions,
  registryFor,
};
