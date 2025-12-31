import Database from 'better-sqlite3'
import { mkdir, unlink, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf8'))
const USER_AGENT = `${pkg.name}/${pkg.version}`
const databasePath = join(__dirname, '..', 'critical-packages.db')

const API_BASE = 'https://packages.ecosyste.ms/api/v1'
const PER_PAGE = 1000
const RATE_LIMIT_MS = 50
const CONCURRENCY = 10

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`)
  }
  return response.json()
}

async function fetchAllCriticalPackages(onProgress) {
  const packages = []
  let page = 1

  while (true) {
    const url = `${API_BASE}/packages/critical?per_page=${PER_PAGE}&page=${page}`
    onProgress?.(`Fetching page ${page}...`)

    const batch = await fetchJson(url)
    if (batch.length === 0) break

    packages.push(...batch)
    page++

    await sleep(RATE_LIMIT_MS)
  }

  return packages
}

async function fetchVersionNumbers(ecosystem, name) {
  const registry = ecosystemToRegistry(ecosystem)
  if (!registry) return []

  const encodedName = encodeURIComponent(name)
  const url = `${API_BASE}/registries/${registry}/packages/${encodedName}/version_numbers`

  try {
    return await fetchJson(url)
  } catch (err) {
    return []
  }
}

function ecosystemToRegistry(ecosystem) {
  const map = {
    'npm': 'npmjs.org',
    'pypi': 'pypi.org',
    'rubygems': 'rubygems.org',
    'go': 'proxy.golang.org',
    'cargo': 'crates.io',
    'maven': 'repo1.maven.org',
    'nuget': 'nuget.org',
    'packagist': 'packagist.org',
    'hex': 'hex.pm',
    'pub': 'pub.dev',
    'hackage': 'hackage.haskell.org',
    'cocoapods': 'cocoapods.org',
    'conda': 'anaconda.org',
    'clojars': 'clojars.org',
    'puppet': 'forge.puppet.com',
    'homebrew': 'formulae.brew.sh',
  }
  return map[ecosystem.toLowerCase()] || null
}

function createDatabase(dbPath) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

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
  `)

  return db
}

function insertPackage(db, pkg) {
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
  `)

  const keywords = Array.isArray(pkg.keywords_array) ? pkg.keywords_array.join(' ') : null

  stmt.run(
    pkg.id,
    pkg.ecosystem,
    pkg.name,
    pkg.purl,
    pkg.namespace,
    pkg.description,
    pkg.homepage,
    pkg.repository_url,
    pkg.licenses,
    JSON.stringify(pkg.normalized_licenses),
    pkg.latest_release_number,
    pkg.versions_count,
    pkg.downloads,
    pkg.downloads_period,
    pkg.dependent_packages_count,
    pkg.dependent_repos_count,
    pkg.first_release_published_at,
    pkg.latest_release_published_at,
    pkg.last_synced_at,
    keywords
  )

  return pkg.id
}

function insertRepoMetadata(db, packageId, repoMetadata, host) {
  if (!repoMetadata) return

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO repo_metadata (
      package_id, owner, repo_name, full_name, host, language,
      stargazers_count, forks_count, open_issues_count, archived, fork
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    packageId,
    repoMetadata.owner,
    repoMetadata.name,
    repoMetadata.full_name,
    host?.name,
    repoMetadata.language,
    repoMetadata.stargazers_count,
    repoMetadata.forks_count,
    repoMetadata.open_issues_count,
    repoMetadata.archived ? 1 : 0,
    repoMetadata.fork ? 1 : 0
  )
}

function insertAdvisories(db, packageId, advisories) {
  if (!advisories || advisories.length === 0) return

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO advisories (
      package_id, uuid, url, title, description, severity, published_at, cvss_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const advisory of advisories) {
    if (!advisory || !advisory.uuid) continue
    stmt.run(
      packageId,
      advisory.uuid,
      advisory.url,
      advisory.title,
      advisory.description,
      advisory.severity,
      advisory.published_at,
      advisory.cvss_score
    )
  }
}

function insertVersions(db, packageId, versionNumbers) {
  if (!versionNumbers || versionNumbers.length === 0) return

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO versions (package_id, number) VALUES (?, ?)
  `)

  for (const number of versionNumbers) {
    stmt.run(packageId, number)
  }
}

function updateBuildInfo(db) {
  const packageCount = db.prepare('SELECT COUNT(*) as count FROM packages').get().count
  const versionCount = db.prepare('SELECT COUNT(*) as count FROM versions').get().count
  const advisoryCount = db.prepare('SELECT COUNT(*) as count FROM advisories').get().count

  db.prepare(`
    INSERT OR REPLACE INTO build_info (id, built_at, package_count, version_count, advisory_count)
    VALUES (1, ?, ?, ?, ?)
  `).run(new Date().toISOString(), packageCount, versionCount, advisoryCount)
}

async function build(options = {}) {
  const {
    dbPath = 'critical-packages.db',
    fetchVersionsData = true,
    onProgress = console.log
  } = options

  await mkdir(dirname(dbPath) || '.', { recursive: true }).catch(() => {})
  await unlink(dbPath).catch(() => {})
  await unlink(dbPath + '-wal').catch(() => {})
  await unlink(dbPath + '-shm').catch(() => {})

  onProgress('Creating database...')
  const db = createDatabase(dbPath)

  onProgress('Fetching critical packages...')
  const packages = await fetchAllCriticalPackages(onProgress)
  onProgress(`Found ${packages.length} critical packages`)

  const insertAll = db.transaction((pkgs) => {
    for (const pkg of pkgs) {
      insertPackage(db, pkg)
      insertRepoMetadata(db, pkg.id, pkg.repo_metadata, pkg.host)
      insertAdvisories(db, pkg.id, pkg.advisories)
    }
  })

  onProgress('Inserting packages...')
  insertAll(packages)

  if (fetchVersionsData) {
    onProgress('Fetching versions...')
    let completed = 0
    const total = packages.length

    const processPackage = async (pkg) => {
      const versions = await fetchVersionNumbers(pkg.ecosystem, pkg.name)
      await sleep(RATE_LIMIT_MS)
      return { pkg, versions }
    }

    // Process in batches with concurrency limit
    for (let i = 0; i < packages.length; i += CONCURRENCY) {
      const batch = packages.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(processPackage))

      db.transaction(() => {
        for (const { pkg, versions } of results) {
          if (versions.length > 0) {
            insertVersions(db, pkg.id, versions)
          }
        }
      })()

      completed += batch.length
      onProgress(`Fetched versions for ${completed}/${total} packages`)
    }
  }

  updateBuildInfo(db)

  const info = db.prepare('SELECT * FROM build_info WHERE id = 1').get()
  onProgress(`Build complete: ${info.package_count} packages, ${info.version_count} versions, ${info.advisory_count} advisories`)

  db.close()
  return info
}

export { build, createDatabase, fetchAllCriticalPackages, fetchVersionNumbers, databasePath }
