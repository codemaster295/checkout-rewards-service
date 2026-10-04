import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { applySchema } from "./schema";

export type Db = Database.Database;

/**
 * Opens (and creates if needed) the SQLite database and applies the schema.
 *
 * Pragmas:
 *  - journal_mode=WAL      readers never block the single writer; required for
 *                          sane behaviour when several processes share the file.
 *  - busy_timeout=5000     when another connection holds the write lock, wait
 *                          (up to 5 s) instead of failing with SQLITE_BUSY. This
 *                          is what turns "two processes check out at once" into
 *                          "they are serialised" rather than "one crashes".
 *  - foreign_keys=ON       SQLite does not enforce FKs unless asked.
 *  - synchronous=NORMAL    safe with WAL; avoids an fsync on every commit.
 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  applySchema(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
