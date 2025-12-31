#!/usr/bin/env node
import { build, databasePath } from './lib/index.js'
import Database from 'better-sqlite3'
import { existsSync } from 'fs'

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: critical [options]

Options:
  --output, -o <path>   Output database path (default: critical-packages.db)
  --skip-versions       Skip fetching version data (faster)
  --stats               Show database statistics
  --help, -h            Show this help message

Examples:
  npx @ecosyste-ms/critical
  npx @ecosyste-ms/critical --skip-versions
  npx @ecosyste-ms/critical -o my-database.db
  npx @ecosyste-ms/critical --stats`)
  process.exit(0)
}

function getArg(flags) {
  for (const flag of flags) {
    const idx = args.indexOf(flag)
    if (idx !== -1 && args[idx + 1]) {
      return args[idx + 1]
    }
  }
  return null
}

const dbPath = getArg(['--output', '-o']) || 'critical-packages.db'

if (args.includes('--stats')) {
  const path = existsSync(dbPath) ? dbPath : databasePath
  if (!existsSync(path)) {
    console.error(`Database not found: ${path}`)
    process.exit(1)
  }
  const db = new Database(path, { readonly: true })
  const info = db.prepare('SELECT * FROM build_info WHERE id = 1').get()
  const packageCount = db.prepare('SELECT COUNT(*) as count FROM packages').get().count
  const versionCount = db.prepare('SELECT COUNT(*) as count FROM versions').get().count
  const advisoryCount = db.prepare('SELECT COUNT(*) as count FROM advisories').get().count
  const ecosystems = db.prepare(`
    SELECT ecosystem, COUNT(*) as count
    FROM packages
    GROUP BY ecosystem
    ORDER BY count DESC
  `).all()
  const severities = db.prepare(`
    SELECT severity, COUNT(*) as count
    FROM advisories
    GROUP BY severity
    ORDER BY count DESC
  `).all()

  console.log(`Database: ${path}`)
  console.log(`Built: ${info?.built_at || 'unknown'}`)
  console.log(`\nPackages: ${packageCount}`)
  console.log(`Versions: ${versionCount}`)
  console.log(`Advisories: ${advisoryCount}`)
  console.log(`\nBy ecosystem:`)
  for (const e of ecosystems) {
    console.log(`  ${e.ecosystem}: ${e.count}`)
  }
  console.log(`\nBy severity:`)
  for (const s of severities) {
    console.log(`  ${s.severity || 'unknown'}: ${s.count}`)
  }
  db.close()
  process.exit(0)
}

const skipVersions = args.includes('--skip-versions')

build({
  dbPath,
  fetchVersionsData: !skipVersions
})
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
