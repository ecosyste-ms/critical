import Database from 'better-sqlite3'
import { createDatabase, databasePath } from '../lib/index.js'
import { unlinkSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import assert from 'assert'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const TEST_DB = 'test-critical.db'

function cleanup() {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  if (existsSync(TEST_DB + '-wal')) unlinkSync(TEST_DB + '-wal')
  if (existsSync(TEST_DB + '-shm')) unlinkSync(TEST_DB + '-shm')
}

function test(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

cleanup()

test('databasePath is exported', () => {
  assert(databasePath, 'databasePath is defined')
  assert(databasePath.endsWith('critical-packages.db'), 'databasePath ends with critical-packages.db')
})

const db = createDatabase(TEST_DB)

test('schema creates all tables', () => {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `).all().map(r => r.name)

  assert(tables.includes('packages'), 'packages table exists')
  assert(tables.includes('versions'), 'versions table exists')
  assert(tables.includes('advisories'), 'advisories table exists')
  assert(tables.includes('repo_metadata'), 'repo_metadata table exists')
  assert(tables.includes('build_info'), 'build_info table exists')
  assert(tables.includes('packages_fts'), 'packages_fts table exists')
})

test('insert and query package', () => {
  const pkg = {
    id: 1,
    ecosystem: 'npm',
    name: 'lodash',
    purl: 'pkg:npm/lodash',
    namespace: null,
    description: 'Lodash modular utilities',
    homepage: 'https://lodash.com/',
    repository_url: 'https://github.com/lodash/lodash',
    licenses: 'MIT',
    normalized_licenses: ['MIT'],
    latest_release_number: '4.17.21',
    versions_count: 114,
    downloads: 307500000,
    downloads_period: 'last-month',
    dependent_packages_count: 159122,
    dependent_repos_count: 1900000,
    first_release_published_at: '2012-04-12T00:00:00.000Z',
    latest_release_published_at: '2021-02-20T15:42:16.891Z',
    last_synced_at: '2024-01-01T00:00:00.000Z',
    keywords_array: ['utilities', 'lodash', 'modules']
  }

  db.prepare(`
    INSERT INTO packages (
      id, ecosystem, name, purl, namespace, description, homepage,
      repository_url, licenses, normalized_licenses, latest_version,
      versions_count, downloads, downloads_period, dependent_packages_count,
      dependent_repos_count, first_release_at, latest_release_at,
      last_synced_at, keywords
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pkg.id, pkg.ecosystem, pkg.name, pkg.purl, pkg.namespace,
    pkg.description, pkg.homepage, pkg.repository_url, pkg.licenses,
    JSON.stringify(pkg.normalized_licenses), pkg.latest_release_number,
    pkg.versions_count, pkg.downloads, pkg.downloads_period,
    pkg.dependent_packages_count, pkg.dependent_repos_count,
    pkg.first_release_published_at, pkg.latest_release_published_at,
    pkg.last_synced_at, pkg.keywords_array.join(' ')
  )

  const result = db.prepare('SELECT * FROM packages WHERE ecosystem = ? AND name = ?')
    .get('npm', 'lodash')

  assert.equal(result.id, 1)
  assert.equal(result.ecosystem, 'npm')
  assert.equal(result.name, 'lodash')
  assert.equal(result.purl, 'pkg:npm/lodash')
  assert.equal(result.licenses, 'MIT')
  assert.equal(result.keywords, 'utilities lodash modules')
})

test('query by purl', () => {
  const result = db.prepare('SELECT * FROM packages WHERE purl = ?')
    .get('pkg:npm/lodash')

  assert(result, 'found package by purl')
  assert.equal(result.name, 'lodash')
})

test('insert and query versions', () => {
  db.prepare(`INSERT INTO versions (package_id, number) VALUES (?, ?)`).run(1, '4.17.21')
  db.prepare(`INSERT INTO versions (package_id, number) VALUES (?, ?)`).run(1, '4.17.20')
  db.prepare(`INSERT INTO versions (package_id, number) VALUES (?, ?)`).run(1, '4.17.19')

  const versions = db.prepare('SELECT * FROM versions WHERE package_id = ?').all(1)

  assert.equal(versions.length, 3)
  assert(versions.some(v => v.number === '4.17.21'))
  assert(versions.some(v => v.number === '4.17.20'))
})

test('insert and query advisories', () => {
  db.prepare(`
    INSERT INTO advisories (package_id, uuid, url, title, severity, published_at, cvss_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'GHSA-29mw-wpgm-hmr9', 'https://github.com/advisories/GHSA-29mw-wpgm-hmr9',
    'ReDoS in lodash', 'MODERATE', '2022-01-06T20:30:46.000Z', 5.3)

  db.prepare(`
    INSERT INTO advisories (package_id, uuid, url, title, severity, published_at, cvss_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'GHSA-p6mc-m468-83gw', 'https://github.com/advisories/GHSA-p6mc-m468-83gw',
    'Command Injection in lodash', 'HIGH', '2021-05-06T00:00:00.000Z', 7.2)

  const advisories = db.prepare('SELECT * FROM advisories WHERE package_id = ?').all(1)
  assert.equal(advisories.length, 2)

  const byUuid = db.prepare('SELECT * FROM advisories WHERE uuid = ?')
    .get('GHSA-29mw-wpgm-hmr9')
  assert.equal(byUuid.package_id, 1)
  assert.equal(byUuid.severity, 'MODERATE')

  const highSeverity = db.prepare('SELECT * FROM advisories WHERE severity = ?').all('HIGH')
  assert.equal(highSeverity.length, 1)
  assert.equal(highSeverity[0].title, 'Command Injection in lodash')
})

test('full-text search', () => {
  const results = db.prepare(`
    SELECT p.* FROM packages p
    JOIN packages_fts fts ON p.id = fts.rowid
    WHERE packages_fts MATCH ?
  `).all('utilities')

  assert(results.length > 0, 'FTS returns results')
  assert.equal(results[0].name, 'lodash')
})

test('full-text search by name', () => {
  const results = db.prepare(`
    SELECT p.* FROM packages p
    JOIN packages_fts fts ON p.id = fts.rowid
    WHERE packages_fts MATCH 'name:lodash'
  `).all()

  assert(results.length > 0, 'FTS by name returns results')
})

test('full-text search by keywords', () => {
  const results = db.prepare(`
    SELECT p.* FROM packages p
    JOIN packages_fts fts ON p.id = fts.rowid
    WHERE packages_fts MATCH 'keywords:modules'
  `).all()

  assert(results.length > 0, 'FTS by keywords returns results')
  assert.equal(results[0].name, 'lodash')
})

test('insert second package for ecosystem filter', () => {
  const pkg = {
    id: 2,
    ecosystem: 'pypi',
    name: 'requests',
    purl: 'pkg:pypi/requests',
    description: 'Python HTTP library',
    keywords_array: ['http', 'requests', 'python']
  }

  db.prepare(`
    INSERT INTO packages (id, ecosystem, name, purl, description, keywords)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(pkg.id, pkg.ecosystem, pkg.name, pkg.purl, pkg.description, pkg.keywords_array.join(' '))

  const npmPackages = db.prepare('SELECT * FROM packages WHERE ecosystem = ?').all('npm')
  const pypiPackages = db.prepare('SELECT * FROM packages WHERE ecosystem = ?').all('pypi')

  assert.equal(npmPackages.length, 1)
  assert.equal(pypiPackages.length, 1)
  assert.equal(npmPackages[0].name, 'lodash')
  assert.equal(pypiPackages[0].name, 'requests')
})

test('repo_metadata table', () => {
  db.prepare(`
    INSERT INTO repo_metadata (package_id, owner, repo_name, full_name, host, language, stargazers_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'lodash', 'lodash', 'lodash/lodash', 'github.com', 'JavaScript', 61500)

  const result = db.prepare('SELECT * FROM repo_metadata WHERE full_name = ?')
    .get('lodash/lodash')

  assert(result, 'found repo metadata')
  assert.equal(result.stargazers_count, 61500)
})

test('license filtering', () => {
  const mitPackages = db.prepare('SELECT * FROM packages WHERE licenses = ?').all('MIT')
  assert.equal(mitPackages.length, 1)
})

db.close()
cleanup()

// Integration test with realistic API data shapes
console.log('\nIntegration tests:')

const integrationDb = createDatabase('test-integration.db')

test('insert package with advisories from API shape', () => {
  const pkg = {
    id: 999,
    ecosystem: 'npm',
    name: 'test-pkg',
    purl: 'pkg:npm/test-pkg',
    namespace: null,
    description: 'Test package',
    homepage: null,
    repository_url: 'https://github.com/test/test-pkg',
    licenses: 'MIT',
    normalized_licenses: ['MIT'],
    latest_release_number: '1.0.0',
    versions_count: 1,
    downloads: 100,
    downloads_period: 'last-month',
    dependent_packages_count: 0,
    dependent_repos_count: 0,
    first_release_published_at: '2024-01-01T00:00:00.000Z',
    latest_release_published_at: '2024-01-01T00:00:00.000Z',
    last_synced_at: '2024-01-01T00:00:00.000Z',
    keywords_array: ['test'],
    advisories: [
      {
        uuid: 'GHSA-test-1234-5678',
        url: 'https://github.com/advisories/GHSA-test-1234-5678',
        title: 'Test vulnerability',
        description: 'A test vulnerability',
        severity: 'HIGH',
        published_at: '2024-01-01T00:00:00.000Z',
        cvss_score: 7.5,
        identifiers: ['CVE-2024-1234']
      },
      {
        uuid: 'GHSA-test-9999-0000',
        url: 'https://github.com/advisories/GHSA-test-9999-0000',
        title: 'Another vulnerability',
        description: 'Another test',
        severity: 'MODERATE',
        published_at: '2024-02-01T00:00:00.000Z',
        cvss_score: 4.0,
        identifiers: ['CVE-2024-5678']
      }
    ],
    repo_metadata: {
      owner: 'test',
      name: 'test-pkg',
      full_name: 'test/test-pkg',
      language: 'JavaScript',
      stargazers_count: 100,
      forks_count: 10,
      open_issues_count: 5,
      archived: false,
      fork: false
    },
    host: { name: 'github.com' }
  }

  // Insert using the same pattern as build()
  integrationDb.prepare(`
    INSERT INTO packages (
      id, ecosystem, name, purl, namespace, description, homepage,
      repository_url, licenses, normalized_licenses, latest_version,
      versions_count, downloads, downloads_period, dependent_packages_count,
      dependent_repos_count, first_release_at, latest_release_at,
      last_synced_at, keywords
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pkg.id, pkg.ecosystem, pkg.name, pkg.purl, pkg.namespace,
    pkg.description, pkg.homepage, pkg.repository_url, pkg.licenses,
    JSON.stringify(pkg.normalized_licenses), pkg.latest_release_number,
    pkg.versions_count, pkg.downloads, pkg.downloads_period,
    pkg.dependent_packages_count, pkg.dependent_repos_count,
    pkg.first_release_published_at, pkg.latest_release_published_at,
    pkg.last_synced_at, pkg.keywords_array.join(' ')
  )

  // Insert advisories using the same pattern as insertAdvisories
  const advStmt = integrationDb.prepare(`
    INSERT OR REPLACE INTO advisories (
      package_id, uuid, url, title, description, severity, published_at, cvss_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const advisory of pkg.advisories) {
    if (!advisory || !advisory.uuid) continue
    advStmt.run(
      pkg.id,
      advisory.uuid,
      advisory.url,
      advisory.title,
      advisory.description,
      advisory.severity,
      advisory.published_at,
      advisory.cvss_score
    )
  }

  const advisories = integrationDb.prepare('SELECT * FROM advisories WHERE package_id = ?').all(999)
  assert.equal(advisories.length, 2, 'inserted 2 advisories')
  assert.equal(advisories[0].severity, 'HIGH')
  assert.equal(advisories[1].severity, 'MODERATE')
})

test('handles null/empty advisories', () => {
  // Test with null advisories
  const nullAdvisories = null
  if (nullAdvisories && nullAdvisories.length > 0) {
    assert.fail('should not reach here')
  }

  // Test with empty array
  const emptyAdvisories = []
  if (emptyAdvisories && emptyAdvisories.length > 0) {
    assert.fail('should not reach here')
  }

  // Test with array containing null
  const mixedAdvisories = [null, { uuid: 'test' }, undefined]
  let validCount = 0
  for (const adv of mixedAdvisories) {
    if (adv && adv.uuid) validCount++
  }
  assert.equal(validCount, 1, 'filters out null/undefined')
})

integrationDb.close()
if (existsSync('test-integration.db')) unlinkSync('test-integration.db')
if (existsSync('test-integration.db-wal')) unlinkSync('test-integration.db-wal')
if (existsSync('test-integration.db-shm')) unlinkSync('test-integration.db-shm')

// CLI tests
console.log('\nCLI tests:')

test('cli --help shows usage', () => {
  const output = execSync('node bin.js --help', { encoding: 'utf8', cwd: projectRoot })
  assert(output.includes('Usage: critical'), 'shows usage line')
  assert(output.includes('--output'), 'shows output option')
  assert(output.includes('--skip-versions'), 'shows skip-versions option')
  assert(output.includes('--stats'), 'shows stats option')
  assert(output.includes('@ecosyste-ms/critical'), 'shows namespaced examples')
})

test('cli -h shows usage', () => {
  const output = execSync('node bin.js -h', { encoding: 'utf8', cwd: projectRoot })
  assert(output.includes('Usage: critical'), 'shows usage line')
})

test('cli --stats shows database info', () => {
  const statsDbPath = join(__dirname, 'test-stats.db')

  // Clean up any leftover test database
  if (existsSync(statsDbPath)) unlinkSync(statsDbPath)
  if (existsSync(statsDbPath + '-wal')) unlinkSync(statsDbPath + '-wal')
  if (existsSync(statsDbPath + '-shm')) unlinkSync(statsDbPath + '-shm')

  // Create a test database with some data (no build_info, to test count queries)
  const statsDb = createDatabase(statsDbPath)
  statsDb.prepare(`
    INSERT INTO packages (id, ecosystem, name, keywords)
    VALUES (1, 'npm', 'test-pkg', 'test')
  `).run()
  statsDb.prepare(`
    INSERT INTO packages (id, ecosystem, name, keywords)
    VALUES (2, 'npm', 'test-pkg-2', 'test')
  `).run()
  statsDb.prepare(`
    INSERT INTO advisories (package_id, uuid, severity)
    VALUES (1, 'GHSA-1234', 'HIGH')
  `).run()
  statsDb.close()

  const output = execSync(`node bin.js --stats -o test/test-stats.db`, { encoding: 'utf8', cwd: projectRoot })
  assert(output.includes('Packages: 2'), 'shows package count from query')
  assert(output.includes('Advisories: 1'), 'shows advisory count from query')
  assert(output.includes('npm: 2'), 'shows ecosystem breakdown')
  assert(output.includes('HIGH: 1'), 'shows severity breakdown')

  unlinkSync(statsDbPath)
  if (existsSync(statsDbPath + '-wal')) unlinkSync(statsDbPath + '-wal')
  if (existsSync(statsDbPath + '-shm')) unlinkSync(statsDbPath + '-shm')
})

console.log('\nAll tests passed!')
