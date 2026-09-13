import fs from "fs";
import path from "path";
import { neon } from "@neondatabase/serverless";
import { config } from "./config";
import { log } from "./vite";

/**
 * Snapshot persistence. The whole application state is a plain JSON document
 * that is written (debounced) after every mutation.
 *
 *  - DATABASE_URL set   -> stored in a single-row Postgres table (Neon free tier works)
 *  - otherwise          -> stored in DATA_FILE on disk
 *
 * Volumes for a prediction-market MVP are small, so this is simpler and more
 * robust than a full ORM layer while still surviving restarts/redeploys.
 */
export interface PersistenceBackend {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
  name: string;
}

class FileBackend implements PersistenceBackend {
  name = "file";
  constructor(private file: string) {}
  async load() {
    try {
      return await fs.promises.readFile(this.file, "utf8");
    } catch {
      return null;
    }
  }
  async save(json: string) {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, json);
    await fs.promises.rename(tmp, this.file);
  }
}

class PostgresBackend implements PersistenceBackend {
  name = "postgres";
  private sql;
  private ready: Promise<void>;
  constructor(url: string) {
    this.sql = neon(url);
    this.ready = this.sql`CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.then(
      () => undefined,
    );
  }
  async load() {
    await this.ready;
    const rows = (await this.sql`SELECT data FROM app_state WHERE id = 1`) as { data: unknown }[];
    if (!rows.length) return null;
    return JSON.stringify(rows[0].data);
  }
  async save(json: string) {
    await this.ready;
    await this.sql`INSERT INTO app_state (id, data, updated_at) VALUES (1, ${json}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
  }
}

export function createBackend(): PersistenceBackend {
  if (config.databaseUrl) return new PostgresBackend(config.databaseUrl);
  return new FileBackend(path.resolve(config.dataFile));
}

/** Debounced writer: coalesces bursts of mutations into one save. */
export class Persister {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private saving = false;
  constructor(
    private backend: PersistenceBackend,
    private snapshot: () => unknown,
    private delayMs = 500,
  ) {}

  schedule() {
    this.pending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  async flush() {
    if (this.saving) {
      this.pending = true;
      return;
    }
    if (!this.pending) return;
    this.pending = false;
    this.saving = true;
    try {
      await this.backend.save(JSON.stringify(this.snapshot()));
    } catch (e) {
      log(`failed to persist state: ${(e as Error).message}`, "persist");
      this.pending = true;
    } finally {
      this.saving = false;
      if (this.pending) this.schedule();
    }
  }
}
