import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

interface PackageManifest {
  name: string;
  version: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  await readFile(join(__dirname, "..", "package.json"), "utf8"),
) as PackageManifest;
const USER_AGENT = `${pkg.name}/${pkg.version}`;
const databasePath = join(__dirname, "..", "critical-packages.db");
const gzPath = join(__dirname, "..", "critical-packages.db.gz");

/** Repository metadata as `GET /packages/critical` serves it -- every field optional. */
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
}

/** The registry host a package came from, as nested in the API's package objects. */
export interface ApiHost {
  name?: string | null;
}

export interface ApiAdvisory {
  uuid: string;
  url?: string | null;
  title?: string | null;
  description?: string | null;
  severity?: string | null;
  published_at?: string | null;
  cvss_score?: number | null;
}

/**
 * A package from `GET /packages/critical`.
 *
 * Only the fields this package stores are declared; the API sends more. The names are
 * the API's, not the schema's -- `latest_release_number` lands in
 * `packages.latest_version`.
 */
export interface ApiPackage {
  id: number;
  ecosystem: string;
  name: string;
  purl?: string | null;
  namespace?: string | null;
  description?: string | null;
  homepage?: string | null;
  repository_url?: string | null;
  licenses?: string | null;
  normalized_licenses?: string[] | null;
  latest_release_number?: string | null;
  versions_count?: number | null;
  downloads?: number | null;
  downloads_period?: string | null;
  dependent_packages_count?: number | null;
  dependent_repos_count?: number | null;
  first_release_published_at?: string | null;
  latest_release_published_at?: string | null;
  last_synced_at?: string | null;
  keywords_array?: string[] | null;
  advisories?: (ApiAdvisory | null | undefined)[] | null;
  repo_metadata?: ApiRepoMetadata | null;
  host?: ApiHost | null;
}

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

const API_BASE = "https://packages.ecosyste.ms/api/v1";
const PER_PAGE = 100;
const RATE_LIMIT_MS = 50;
const CONCURRENCY = 10;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });
      if (response.ok) return (await response.json()) as T;
      // 4xx is a client error - don't retry. 5xx is server-side; retry.
      if (response.status < 500) {
        throw new Error(`HTTP ${response.status}: ${url}`);
      }
      lastErr = new Error(`HTTP ${response.status}: ${url}`);
    } catch (err) {
      // Network errors (fetch throws TypeError) are retryable.
      const message = err instanceof Error ? err.message : undefined;
      if (message?.startsWith("HTTP ") && !message.match(/HTTP 5\d\d/)) throw err;
      lastErr = err;
    }
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastErr;
}

async function fetchAllCriticalPackages(onProgress?: ProgressReporter): Promise<ApiPackage[]> {
  const packages: ApiPackage[] = [];
  let page = 1;

  while (true) {
    const url = `${API_BASE}/packages/critical?per_page=${PER_PAGE}&page=${page}`;
    onProgress?.(`Fetching page ${page}...`);

    const batch = await fetchJson<ApiPackage[]>(url);
    if (batch.length === 0) break;

    packages.push(...batch);
    page++;

    await sleep(RATE_LIMIT_MS);
  }

  return packages;
}

async function fetchVersionNumbers(ecosystem: string, name: string): Promise<string[]> {
  const registry = ecosystemToRegistry(ecosystem);
  if (!registry) return [];

  const encodedName = encodeURIComponent(name);
  const url = `${API_BASE}/registries/${registry}/packages/${encodedName}/version_numbers`;

  try {
    return await fetchJson<string[]>(url);
  } catch {
    return [];
  }
}

function ecosystemToRegistry(ecosystem: string): string | null {
  const map: Record<string, string> = {
    npm: "npmjs.org",
    pypi: "pypi.org",
    rubygems: "rubygems.org",
    go: "proxy.golang.org",
    cargo: "crates.io",
    maven: "repo1.maven.org",
    nuget: "nuget.org",
    packagist: "packagist.org",
    hex: "hex.pm",
    pub: "pub.dev",
    hackage: "hackage.haskell.org",
    cocoapods: "cocoapods.org",
    conda: "anaconda.org",
    clojars: "clojars.org",
    puppet: "forge.puppet.com",
    homebrew: "formulae.brew.sh",
  };
  return map[ecosystem.toLowerCase()] ?? null;
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
  host: ApiHost | null | undefined,
): void {
  if (!repoMetadata) return;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO repo_metadata (
      package_id, owner, repo_name, full_name, host, language,
      stargazers_count, forks_count, open_issues_count, archived, fork
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    packageId,
    repoMetadata.owner ?? null,
    repoMetadata.name ?? null,
    repoMetadata.full_name ?? null,
    host?.name ?? null,
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
  } = options;

  await mkdir(dirname(dbPath) || ".", { recursive: true }).catch(() => {});
  await unlink(dbPath).catch(() => {});
  await unlink(`${dbPath}-wal`).catch(() => {});
  await unlink(`${dbPath}-shm`).catch(() => {});

  onProgress("Creating database...");
  const db = createDatabase(dbPath);

  onProgress("Fetching critical packages...");
  const packages = await fetchAllCriticalPackages(onProgress);
  onProgress(`Found ${packages.length} critical packages`);

  onProgress("Inserting packages...");
  db.exec("BEGIN");
  try {
    for (const pkg of packages) {
      insertPackage(db, pkg);
      insertRepoMetadata(db, pkg.id, pkg.repo_metadata, pkg.host);
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

    const processPackage = async (pkg: ApiPackage) => {
      const versions = await fetchVersionNumbers(pkg.ecosystem, pkg.name);
      await sleep(RATE_LIMIT_MS);
      return { pkg, versions };
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
  }

  updateBuildInfo(db);

  const info = db
    .prepare("SELECT * FROM build_info WHERE id = 1")
    .get() as unknown as BuildInfo;
  onProgress(
    `Build complete: ${info.package_count} packages, ${info.version_count} versions, ${info.advisory_count} advisories`,
  );

  db.close();
  return info;
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
};
