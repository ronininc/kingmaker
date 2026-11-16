// A STAND-IN for the engine, for tests only (the real engine is never started against live data here). It resolves its
// data folder exactly as the engine's server/src/utils/runtime-paths.ts getDataRoot does (SOLOMON_DATA_DIR, else
// <runtime root>/data, the runtime root being what the headless launcher passes), opens <data>/sqlite/solomon.db —
// the file that holds the engine's governed memory (MemPalace) — with node:sqlite in WAL mode, remembers STUB_REMEMBER
// when set, prints every remembered row as one JSON line, then the engine's ready line, and exits.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const root = process.env.SOLOMON_RUNTIME_ROOT || process.env.SOLOMON_HEADLESS_HOME || process.cwd();
const o = String(process.env.SOLOMON_DATA_DIR ?? '').trim();
const data = o ? (isAbsolute(o) ? o : resolve(root, o)) : join(root, 'data');
mkdirSync(join(data, 'sqlite'), { recursive: true });
const db = new DatabaseSync(join(data, 'sqlite', 'solomon.db'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
if (process.env.STUB_REMEMBER) db.prepare('INSERT INTO memory (content) VALUES (?)').run(process.env.STUB_REMEMBER);
const rows = db.prepare('SELECT content FROM memory ORDER BY id').all().map((r) => r.content);
db.close();
console.log(`STUB_MEMORY ${JSON.stringify({ data, rows })}`);
console.log('Solomon runtime listening on 0');
