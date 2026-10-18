// Minimal D1Database shim on Node's built-in SQLite, running the real migration file.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const norm = (params: unknown[]) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
const plain = (r: unknown) => (r ? { ...(r as object) } : null);

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params);
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = plain(this.db.prepare(this.sql).get(...(norm(this.params) as never[])));
    if (!row) return null;
    return (col ? (row as Record<string, unknown>)[col] : row) as T;
  }
  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...(norm(this.params) as never[])).map(plain);
    return { results: rows as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(norm(this.params) as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function createTestD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const migration = readFileSync(fileURLToPath(new URL("../../migrations/0001_init.sql", import.meta.url)), "utf8");
  db.exec(migration);
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
