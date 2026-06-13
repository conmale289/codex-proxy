import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import { getDataDir } from "../paths.js";

let db: Database.Database | null = null;
let insertUsageStmt: Database.Statement | null = null;

function getDb() {
  if (db) return { db, insertUsageStmt: insertUsageStmt! };

  const dbPath = resolve(getDataDir(), "analytics.sqlite");

  if (!existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  db = new Database(dbPath);

  // Initialize schema
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      client_ip TEXT
    )
  `);

  insertUsageStmt = db.prepare(`
    INSERT INTO token_usage (model, input_tokens, output_tokens, cached_tokens, client_ip)
    VALUES (?, ?, ?, ?, ?)
  `);

  return { db, insertUsageStmt };
}

export function recordUsage(model: string, inputTokens: number, outputTokens: number, cachedTokens: number, clientIp: string) {
  try {
    const { insertUsageStmt } = getDb();
    insertUsageStmt.run(model, inputTokens, outputTokens, cachedTokens, clientIp);
  } catch (err) {
    console.error("[Analytics] Failed to record usage:", err);
  }
}
