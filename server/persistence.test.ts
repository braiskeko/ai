import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PersistenceBackend } from "./persistence";

// `server/config.ts` reads the environment once, when it is first imported, so the
// environment has to be prepared BEFORE persistence.ts (which imports config.ts)
// is loaded. Hence the dynamic import below instead of a static one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "foresight-persistence-test-"));
// Nested directory that does not exist yet: save() must create it.
const dataFile = path.join(tmpDir, "nested", "state.json");
process.env.DATA_FILE = dataFile;
delete process.env.DATABASE_URL;

const { createBackend, Persister } = await import("./persistence");

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(5);
  }
}

/** In-memory backend that records every save attempt and can be told to fail or stall. */
class FakeBackend implements PersistenceBackend {
  name = "fake";
  /** Successfully saved documents, in order. */
  saves: string[] = [];
  /** Number of save() calls, successful or not. */
  attempts = 0;
  /** How many of the next save() calls should reject. */
  failuresLeft = 0;
  /** While true, save() blocks until release() is called. */
  block = false;
  private waiters: (() => void)[] = [];

  async load() {
    return this.saves.at(-1) ?? null;
  }

  async save(json: string) {
    this.attempts++;
    if (this.block) await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("simulated storage failure");
    }
    this.saves.push(json);
  }

  release() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

// ---------------------------------------------------------------------------
// FileBackend
// ---------------------------------------------------------------------------

describe("FileBackend via createBackend()", () => {
  it("is selected when DATABASE_URL is unset", () => {
    assert.equal(createBackend().name, "file");
  });

  it("load() returns null when the data file does not exist", async () => {
    fs.rmSync(dataFile, { force: true });
    assert.equal(await createBackend().load(), null);
  });

  it("save() then load() round-trips the JSON document", async () => {
    const backend = createBackend();
    const doc = {
      users: [{ id: "u1", email: "a@example.com", balance: 12.5 }],
      markets: { m1: { liquidity: 100, q: [0, 3.25], title: "Will it rain? ☔ — \"quoted\"" } },
      nested: { deep: { list: [1, "two", null, true] } },
    };
    const json = JSON.stringify(doc);

    await backend.save(json);

    assert.equal(await backend.load(), json);
    assert.deepEqual(JSON.parse((await backend.load())!), doc);
    // Written to DATA_FILE (the directory was created on demand) ...
    assert.equal(fs.readFileSync(dataFile, "utf8"), json);
    // ... atomically via rename, leaving no temp file behind.
    assert.equal(fs.existsSync(`${dataFile}.tmp`), false);
  });

  it("save() replaces the previous snapshot and a fresh backend instance sees it", async () => {
    const backend = createBackend();
    await backend.save(JSON.stringify({ version: 1 }));
    await backend.save(JSON.stringify({ version: 2 }));
    assert.equal(await backend.load(), '{"version":2}');
    assert.equal(await createBackend().load(), '{"version":2}');
  });
});

// ---------------------------------------------------------------------------
// Persister
// ---------------------------------------------------------------------------

describe("Persister", () => {
  it("coalesces a burst of schedule() calls into a single save of the latest snapshot", async () => {
    const backend = new FakeBackend();
    let state = { counter: 0 };
    const persister = new Persister(backend, () => state, 20);

    for (let i = 1; i <= 10; i++) {
      state = { counter: i };
      persister.schedule();
    }
    assert.equal(backend.attempts, 0, "saving is debounced, not immediate");

    await waitFor(() => backend.saves.length >= 1, "the debounced save");
    await sleep(60); // give any stray timer a chance to misbehave
    assert.equal(backend.attempts, 1, "ten schedule() calls must produce exactly one save");
    assert.deepEqual(backend.saves, [JSON.stringify({ counter: 10 })]);
  });

  it("flush() writes pending data immediately, and the debounce timer then has nothing to do", async () => {
    const backend = new FakeBackend();
    const persister = new Persister(backend, () => ({ v: 1 }), 30);

    persister.schedule();
    persister.schedule();
    await persister.flush();
    assert.equal(backend.attempts, 1);
    assert.deepEqual(backend.saves, ['{"v":1}']);

    await sleep(80); // the 30ms timer fires in here
    assert.equal(backend.attempts, 1, "the timer must not save again when nothing is pending");
  });

  it("flush() is a no-op when nothing was scheduled", async () => {
    const backend = new FakeBackend();
    const persister = new Persister(backend, () => ({ v: 1 }), 10);
    await persister.flush();
    await persister.flush();
    assert.equal(backend.attempts, 0);
  });

  it("saves again when schedule() arrives while a save is already in flight (no lost writes)", async () => {
    const backend = new FakeBackend();
    backend.block = true;
    let state = { v: 1 };
    const persister = new Persister(backend, () => state, 10);

    persister.schedule();
    const first = persister.flush(); // starts save #1, which is now blocked inside the backend
    await waitFor(() => backend.attempts === 1, "first save to start");

    state = { v: 2 };
    persister.schedule();
    await persister.flush(); // returns right away: a save is in progress, so this only marks data pending
    assert.equal(backend.attempts, 1, "no concurrent second save");

    backend.block = false;
    backend.release();
    await first;

    await waitFor(() => backend.saves.length === 2, "the follow-up save");
    assert.equal(backend.attempts, 2);
    assert.deepEqual(backend.saves, ['{"v":1}', '{"v":2}']);
  });

  it("keeps data pending after a failed save and retries on the next flush()", async (t) => {
    t.mock.method(console, "log", () => {}); // silence the "failed to persist state" log line
    const backend = new FakeBackend();
    backend.failuresLeft = 1;
    const persister = new Persister(backend, () => ({ v: "important" }), 100);

    persister.schedule();
    await persister.flush();
    assert.equal(backend.attempts, 1);
    assert.deepEqual(backend.saves, [], "first attempt failed");

    await persister.flush(); // data is still pending, so this must retry
    assert.equal(backend.attempts, 2);
    assert.deepEqual(backend.saves, ['{"v":"important"}']);

    await sleep(150); // the automatic retry timer fires in here and must find nothing pending
    assert.equal(backend.attempts, 2);
  });

  it("retries automatically via schedule() after a failed save", async (t) => {
    t.mock.method(console, "log", () => {});
    const backend = new FakeBackend();
    backend.failuresLeft = 1;
    const persister = new Persister(backend, () => ({ v: 42 }), 10);

    persister.schedule();
    await waitFor(() => backend.saves.length === 1, "the automatic retry");
    assert.equal(backend.attempts, 2, "one failed attempt followed by one successful retry");
    assert.deepEqual(backend.saves, ['{"v":42}']);
  });

  it("keeps retrying while the backend keeps failing, then succeeds", async (t) => {
    t.mock.method(console, "log", () => {});
    const backend = new FakeBackend();
    backend.failuresLeft = 3;
    const persister = new Persister(backend, () => ({ v: "eventually" }), 5);

    persister.schedule();
    await waitFor(() => backend.saves.length === 1, "the eventual successful save");
    assert.equal(backend.attempts, 4);
  });

  it("works end to end with the real FileBackend", async () => {
    const backend = createBackend();
    fs.rmSync(dataFile, { force: true });
    let state = { markets: 0 };
    const persister = new Persister(backend, () => state, 10);

    state = { markets: 1 };
    persister.schedule();
    state = { markets: 2 };
    persister.schedule();
    await persister.flush();

    assert.equal(fs.readFileSync(dataFile, "utf8"), '{"markets":2}');
    assert.equal(await backend.load(), '{"markets":2}');
  });
});
