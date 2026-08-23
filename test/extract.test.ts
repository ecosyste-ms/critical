import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase, extractDatabase } from "../lib/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "critical-extract-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// The corruption this guards against -- concurrent importers streaming into the same
// path -- needs the real 35MB database and separate processes to reproduce as torn
// bytes. What is asserted here instead is the invariant that makes it impossible:
// whenever the destination exists at all it is a complete, openable database, because
// it is only ever renamed into place whole.
it("publishes the destination atomically", async () => {
  const sourceDb = join(tmpDir, "source.db");
  const source = join(tmpDir, "fixture.db.gz");
  const destination = join(tmpDir, "fixture.db");

  // Large enough that the extraction spans several event loop turns, so the polling
  // below actually samples while it is in flight.
  const fixtureDb = createDatabase(sourceDb);
  const padding = "x".repeat(4096);
  const insert = fixtureDb.prepare(
    "INSERT INTO packages (id, ecosystem, name, description) VALUES (?, ?, ?, ?)",
  );
  // One transaction, not 2000: WAL fsyncs per commit, which costs ~90s row by row.
  fixtureDb.exec("BEGIN");
  for (let i = 0; i < 2000; i++) insert.run(i, "npm", `pkg-${i}`, padding);
  fixtureDb.exec("COMMIT");
  fixtureDb.close();
  await pipeline(createReadStream(sourceDb), createGzip(), createWriteStream(source));

  function readRowCount() {
    const db = new DatabaseSync(destination, { readOnly: true });
    try {
      return Number(db.prepare("SELECT COUNT(*) AS count FROM packages").get()?.count);
    } finally {
      db.close();
    }
  }

  let sawTemp = false;
  let destinationObservations = 0;
  let done = false;
  const extracting = extractDatabase(source, destination).finally(() => {
    done = true;
  });

  // The rename can land on disk a tick before its callback resolves the promise, so
  // seeing the destination here is expected. What must never happen is seeing it
  // half-written: every observation has to be a complete database.
  while (!done) {
    if (readdirSync(tmpDir).some((f) => f.startsWith("fixture.db.") && f.endsWith(".tmp"))) {
      sawTemp = true;
    }
    if (existsSync(destination)) {
      destinationObservations++;
      expect(readRowCount(), "destination is complete every time it is visible").toBe(2000);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await extracting;

  expect(sawTemp, "extraction went through a temp file (the window was sampled)").toBe(true);
  expect(destinationObservations).toBeGreaterThan(0);
  expect(readRowCount(), "extracted database is intact").toBe(2000);
  expect(
    readdirSync(tmpDir).filter((f) => f.endsWith(".tmp")),
    "no temp files left behind",
  ).toEqual([]);
});
