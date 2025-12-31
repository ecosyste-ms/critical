# @ecosyste-ms/critical

SQLite database of critical open source packages from [ecosyste.ms](https://packages.ecosyste.ms).

The database is rebuilt daily and published to npm and as a GitHub release. Versions use `MAJOR.MINOR.YYYYMMDD` where major/minor track schema changes and patch is the build date.

## Install

```bash
npm install @ecosyste-ms/critical
```

The package includes a pre-built `critical-packages.db` file:

```javascript
import { databasePath } from '@ecosyste-ms/critical'
import Database from 'better-sqlite3'

const db = new Database(databasePath)
const pkg = db.prepare('SELECT * FROM packages WHERE name = ?').get('lodash')
```

See [ecosyste-ms/mcp](https://github.com/ecosyste-ms/mcp) for a full example.

## Download

You can also grab the database directly from the [releases page](../../releases/latest):

- `critical-packages.db` - uncompressed SQLite
- `critical-packages.db.gz` - gzip compressed

## Building

To build the database yourself:

```javascript
import { build, createDatabase } from '@ecosyste-ms/critical'

await build({
  dbPath: 'critical-packages.db',
  fetchVersionsData: true,
  onProgress: console.log
})
```

From the command line:

```bash
npx @ecosyste-ms/critical                    # full build with versions
npx @ecosyste-ms/critical --skip-versions    # faster, packages only
npx @ecosyste-ms/critical -o my-db.db        # custom output path
npx @ecosyste-ms/critical --stats            # show database statistics
```

## Schema

### packages

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key from ecosyste.ms |
| ecosystem | TEXT | Package ecosystem (npm, pypi, rubygems, etc.) |
| name | TEXT | Package name |
| purl | TEXT | Package URL (pkg:npm/lodash) |
| namespace | TEXT | Package namespace if applicable |
| description | TEXT | Package description |
| homepage | TEXT | Project homepage URL |
| repository_url | TEXT | Source repository URL |
| licenses | TEXT | SPDX license identifier |
| normalized_licenses | TEXT | JSON array of normalized license identifiers |
| latest_version | TEXT | Latest release version number |
| versions_count | INTEGER | Total number of versions |
| downloads | INTEGER | Download count |
| downloads_period | TEXT | Period for download count (e.g., last-month) |
| dependent_packages_count | INTEGER | Number of packages depending on this |
| dependent_repos_count | INTEGER | Number of repositories depending on this |
| first_release_at | TEXT | ISO 8601 timestamp of first release |
| latest_release_at | TEXT | ISO 8601 timestamp of latest release |
| last_synced_at | TEXT | When ecosyste.ms last synced this package |
| keywords | TEXT | Space-separated keywords for FTS |

Indexes: `(ecosystem, name)` unique, `purl`, `licenses`, `ecosystem`

### versions

| Column | Type | Description |
|--------|------|-------------|
| package_id | INTEGER | Foreign key to packages |
| number | TEXT | Version number |

Primary key: `(package_id, number)`

### advisories

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment primary key |
| package_id | INTEGER | Foreign key to packages |
| uuid | TEXT | Advisory UUID (GHSA-xxxx-xxxx-xxxx) |
| url | TEXT | Advisory URL |
| title | TEXT | Advisory title |
| description | TEXT | Advisory description |
| severity | TEXT | Severity level (LOW, MODERATE, HIGH, CRITICAL) |
| published_at | TEXT | ISO 8601 publish timestamp |
| cvss_score | REAL | CVSS score |

Indexes: `package_id`, `uuid`, `severity`, `(package_id, uuid)` unique

### repo_metadata

| Column | Type | Description |
|--------|------|-------------|
| package_id | INTEGER | Primary key, foreign key to packages |
| owner | TEXT | Repository owner/organization |
| repo_name | TEXT | Repository name |
| full_name | TEXT | Full name (owner/repo) |
| host | TEXT | Host (github.com, gitlab.com, etc.) |
| language | TEXT | Primary language |
| stargazers_count | INTEGER | GitHub stars |
| forks_count | INTEGER | Fork count |
| open_issues_count | INTEGER | Open issues |
| archived | INTEGER | 1 if archived, 0 otherwise |
| fork | INTEGER | 1 if a fork, 0 otherwise |

Indexes: `full_name`, `owner`

### packages_fts

FTS5 virtual table for full-text search on `ecosystem`, `name`, `description`, and `keywords`.

### build_info

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Always 1 |
| built_at | TEXT | ISO 8601 build timestamp |
| package_count | INTEGER | Total packages |
| version_count | INTEGER | Total versions |
| advisory_count | INTEGER | Total advisories |

## Example Queries

SBOM enrichment by purl:

```sql
SELECT * FROM packages WHERE purl = 'pkg:npm/lodash';

-- Check if a specific version exists
SELECT * FROM versions v
JOIN packages p ON v.package_id = p.id
WHERE p.purl = 'pkg:npm/lodash' AND v.number = '4.17.21';
```

Find packages with known vulnerabilities:

```sql
SELECT p.ecosystem, p.name, a.uuid, a.severity, a.title
FROM packages p
JOIN advisories a ON p.id = a.package_id
WHERE a.severity IN ('HIGH', 'CRITICAL');
```

License audit:

```sql
SELECT ecosystem, name, licenses
FROM packages
WHERE licenses NOT IN ('MIT', 'Apache-2.0', 'BSD-3-Clause');
```

Full-text search:

```sql
SELECT p.* FROM packages p
JOIN packages_fts ON p.id = packages_fts.rowid
WHERE packages_fts MATCH 'http client';
```

Packages by ecosystem:

```sql
SELECT * FROM packages WHERE ecosystem = 'npm';
```

Most depended-on packages:

```sql
SELECT ecosystem, name, dependent_packages_count
FROM packages
ORDER BY dependent_packages_count DESC
LIMIT 100;
```

## License

CC-BY-SA-4.0
