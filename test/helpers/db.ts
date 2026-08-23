import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../../lib/index.js";

export interface TempDatabase {
  db: DatabaseSync;
  path: string;
  dir: string;
  /** Closes the handle and removes the directory, WAL and shm files included. */
  cleanup: () => void;
}

/**
 * A `createDatabase()` fixture in its own temp directory.
 *
 * Per-directory rather than per-file names because the suite runs files in parallel and
 * WAL leaves `-wal`/`-shm` siblings behind; removing the directory takes all three.
 */
export function createTempDatabase(name = "critical.db"): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), "critical-test-"));
  const path = join(dir, name);
  const db = createDatabase(path);

  return {
    db,
    path,
    dir,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A `createDatabase()` fixture held in memory.
 *
 * The same schema, without the temp directory a per-test on-disk fixture pays for in
 * mkdtemp, WAL creation and the recursive remove. Use this wherever a test only
 * exercises SQL; `createTempDatabase` is for tests that need a real file.
 */
export function createMemoryDatabase(): DatabaseSync {
  return createDatabase(":memory:");
}
