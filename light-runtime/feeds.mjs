/**
 * light-runtime/feeds.mjs — the wall's daemon feeds (surface rebuild, §D.3 of the pass-1
 * report): read-only views over the governed-turn daemon's own persistence, served beside
 * /state so the panes render the machine's real records instead of one thin state object.
 *
 * The sources, exactly as §D.1 found them in the tree:
 *   - the daemon's SQLite store — $SOLOMON_DATA_DIR, else <daemon runtime root>/data —
 *     sqlite/solomon.db: the hash-chained `ledger` (DECISION / REPLAY / REVIEW / ACTION)
 *     and `conversation_turns`, written together on every completed governed turn
 *     (solomon/server/src/storage/{db,conversation-governance}.ts). The light server opens
 *     it READ-ONLY and never writes it; the durable file is read directly rather than via
 *     the daemon's live /audit route for the same reason the failure registry reads files:
 *     the history must render even while the daemon is down, and a read-only open cannot
 *     disturb the writer.
 *   - <data root>/background-tasks/tasks.json — the daemon's background-task registry,
 *     one JSON array, read as-is.
 *   - the light runtime's own logs/server.log — the per-turn timing records the failure
 *     registry already parses (reused here, not re-derived).
 *
 * HONEST ABSENCE is the contract, same as failures.mjs: a machine whose daemon has never
 * run has no database, and every feed then answers present:false with real empty lists and
 * real zeros — never a fabricated row. A feed that cannot read its source says so in its
 * own `note`, in words. node:sqlite is loaded defensively: on a runtime without it the
 * feeds degrade to the same honest-absent shape with the reason named, and the rest of the
 * light server is untouched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseTurnTiming, readTail } from './failures.mjs';

export const FEEDS_SCHEMA = 'kingmaker.light-feeds/1';

const LOG_TAIL_BYTES = 1024 * 1024;
const EXCERPT = 160;

// node:sqlite is stdlib on the Node this runtime ships with (24.x). The dynamic import
// keeps a runtime without it from taking the whole light server down at module load.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }

/**
 * The daemon's data dir, by the daemon's own rules (runtime-paths.ts getDataRoot): an
 * absolute SOLOMON_DATA_DIR wins, a relative one resolves against the runtime root, and
 * the default is <runtime root>/data. The runtime root is SOL_GHOST_RUNTIME_HOME, else
 * <engine state dir>/runtime — the same home proposals.mjs derives for the owner nonce.
 */
export function resolveDaemonDataDir({ engineStateDir, env = process.env } = {}) {
  const runtimeHome = env.SOL_GHOST_RUNTIME_HOME ? String(env.SOL_GHOST_RUNTIME_HOME) : join(engineStateDir, 'runtime');
  const named = env.SOLOMON_DATA_DIR ? String(env.SOLOMON_DATA_DIR) : null;
  if (named) return isAbsolute(named) ? named : join(runtimeHome, named);
  return join(runtimeHome, 'data');
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

function excerpt(value, max = EXCERPT) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A ledger payload's one-line summary: the discriminator the writer itself put there
 *  (action / type), never an invented label. */
export function payloadAction(payload) {
  const p = parseJsonObject(payload);
  if (!p) return null;
  return typeof p.action === 'string' ? p.action : typeof p.type === 'string' ? p.type : null;
}

/** The guardrail decisions one ledger row's response payload carries (the governed turn
 *  writes them under guardrailDecisions on its ACTION append). Pure; exported for tests. */
export function guardrailDecisionsFrom(responsePayload) {
  const p = parseJsonObject(responsePayload);
  const list = Array.isArray(p?.guardrailDecisions) ? p.guardrailDecisions : [];
  return list.filter((d) => d && typeof d === 'object').map((d) => ({
    decisionId: typeof d.decisionId === 'string' ? d.decisionId : null,
    stage: typeof d.stage === 'string' ? d.stage : null,
    mode: typeof d.mode === 'string' ? d.mode : null,
    decision: typeof d.decision === 'string' ? d.decision : null,
    reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes.filter((c) => typeof c === 'string').slice(0, 8) : [],
  }));
}

function clampLimit(value, fallback, cap) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), cap) : fallback;
}

export function createDaemonFeeds({
  engineStateDir,
  env = process.env,
  // Test seams: pin the data dir / db file, or replace the database opener wholesale.
  dataDir = null,
  dbPath = null,
  openDatabase = null,
  readServerLog = null,
  readTasksFile = null,
} = {}) {
  if (!engineStateDir && !dataDir && !dbPath && !openDatabase) throw new Error('createDaemonFeeds: engineStateDir is required');
  const theDataDir = dataDir ?? (engineStateDir ? resolveDaemonDataDir({ engineStateDir, env }) : null);
  const theDbPath = dbPath ?? (theDataDir ? join(theDataDir, 'sqlite', 'solomon.db') : null);
  const tasksFile = theDataDir ? join(theDataDir, 'background-tasks', 'tasks.json') : null;
  const daemonStateFile = engineStateDir ? join(engineStateDir, 'daemon.json') : null;

  const dbAvailable = () => {
    if (openDatabase) return true;
    return !!(DatabaseSync && theDbPath && existsSync(theDbPath));
  };

  /** Run fn against a read-only handle; null when the store is absent or unreadable. */
  function withDb(fn) {
    if (!dbAvailable()) return null;
    let db = null;
    try {
      db = openDatabase ? openDatabase(theDbPath) : new DatabaseSync(theDbPath, { readOnly: true });
      return fn(db);
    } catch { return null; }
    finally { try { db?.close(); } catch { /* the read is over either way */ } }
  }

  function tableSet(db) {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    return new Set(rows.map((r) => r.name));
  }

  function readTasks() {
    if (!tasksFile) return null;
    try {
      const raw = readTasksFile ? readTasksFile(tasksFile) : (existsSync(tasksFile) ? readFileSync(tasksFile, 'utf8') : null);
      if (raw == null) return null;
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : null;
    } catch { return null; }
  }

  function readTiming() {
    if (!engineStateDir) return [];
    const logPath = join(engineStateDir, 'logs', 'server.log');
    const text = readServerLog ? readServerLog(logPath) : readTail(logPath, LOG_TAIL_BYTES);
    return parseTurnTiming(text ?? '');
  }

  const absentDb = (extra = {}) => ({
    ok: true, schema: FEEDS_SCHEMA, present: false, source: `the daemon's ledger — ${theDbPath}`,
    note: DatabaseSync
      ? 'No daemon database at that path yet — the governed-turn daemon has not written one on this machine. These are its real zeros, not a failure.'
      : 'This runtime has no node:sqlite, so the daemon\'s database cannot be opened from here. The feed reports absent rather than guessing.',
    ...extra,
  });

  /** GET /api/conversations — the conversations the daemon actually holds, newest first. */
  function conversations({ limit = 50 } = {}) {
    const cap = clampLimit(limit, 50, 200);
    const out = withDb((db) => {
      if (!tableSet(db).has('conversation_turns')) return null;
      return db.prepare(
        `SELECT conversationId AS id, COUNT(*) AS turns, MAX(timestamp) AS lastAt,
                (SELECT mode FROM conversation_turns c2 WHERE c2.conversationId = c.conversationId
                  ORDER BY c2.timestamp DESC, c2.turnId DESC LIMIT 1) AS lastMode
           FROM conversation_turns c GROUP BY conversationId ORDER BY lastAt DESC LIMIT ?`,
      ).all(cap);
    });
    if (!out) return absentDb({ conversations: [] });
    return {
      ok: true, schema: FEEDS_SCHEMA, present: true, source: `the daemon's conversation_turns — ${theDbPath}`,
      conversations: out.map((r) => ({ id: r.id, turns: Number(r.turns) || 0, lastAt: r.lastAt ?? null, lastMode: r.lastMode ?? null })),
    };
  }

  /** GET /api/conversations/<id>/turns — the durable history of one conversation. */
  function conversationTurns(conversationId, { limit = 200 } = {}) {
    const cap = clampLimit(limit, 200, 500);
    const out = withDb((db) => {
      if (!tableSet(db).has('conversation_turns')) return null;
      return db.prepare(
        `SELECT turnId, timestamp, mode, userText, solomonResponse, confidence,
                governanceFlagsJson, sourceProofIdsJson, auditHash
           FROM conversation_turns WHERE conversationId = ? ORDER BY timestamp ASC, turnId ASC LIMIT ?`,
      ).all(String(conversationId), cap);
    });
    if (!out) return absentDb({ conversationId: String(conversationId), turns: [] });
    return {
      ok: true, schema: FEEDS_SCHEMA, present: true, conversationId: String(conversationId),
      source: `the daemon's conversation_turns — ${theDbPath}`,
      turns: out.map((r) => {
        const flags = (() => { try { const v = JSON.parse(r.governanceFlagsJson ?? '[]'); return Array.isArray(v) ? v.filter((f) => typeof f === 'string').slice(0, 8) : []; } catch { return []; } })();
        const proofs = (() => { try { const v = JSON.parse(r.sourceProofIdsJson ?? '[]'); return Array.isArray(v) ? v.length : 0; } catch { return 0; } })();
        return {
          turnId: r.turnId, at: r.timestamp ?? null, mode: r.mode ?? null,
          userText: excerpt(r.userText, 400), response: excerpt(r.solomonResponse, 600),
          confidence: typeof r.confidence === 'number' ? r.confidence : null,
          governanceFlags: flags, proofCount: proofs, auditHash: r.auditHash ?? null,
        };
      }),
    };
  }

  /** GET /api/audit — the hash-chained ledger itself, newest first, payloads summarized. */
  function audit({ limit = 50 } = {}) {
    const cap = clampLimit(limit, 50, 200);
    const out = withDb((db) => {
      if (!tableSet(db).has('ledger')) return null;
      const rows = db.prepare(
        'SELECT id, timestamp, recordType, hash, previousHash, requestPayload, responsePayload FROM ledger ORDER BY id DESC LIMIT ?',
      ).all(cap);
      const total = db.prepare('SELECT COUNT(*) AS n FROM ledger').get();
      return { rows, total: Number(total?.n) || 0 };
    });
    if (!out) return absentDb({ entries: [], total: 0, tipHash: null });
    return {
      ok: true, schema: FEEDS_SCHEMA, present: true, source: `the daemon's hash-chained ledger — ${theDbPath}`,
      total: out.total, tipHash: out.rows[0]?.hash ?? null,
      entries: out.rows.map((r) => ({
        id: r.id, at: r.timestamp ?? null, recordType: r.recordType ?? null,
        hash: r.hash ?? null, previousHash: r.previousHash ?? null,
        action: payloadAction(r.requestPayload),
      })),
    };
  }

  /** The ledger-carried half of GET /api/gates: guardrail decisions, newest first. */
  function guardrailDecisions({ limit = 50 } = {}) {
    const cap = clampLimit(limit, 50, 200);
    const out = withDb((db) => {
      if (!tableSet(db).has('ledger')) return null;
      const rows = db.prepare(
        'SELECT timestamp, responsePayload FROM ledger ORDER BY id DESC LIMIT 400',
      ).all();
      const found = [];
      for (const r of rows) {
        for (const d of guardrailDecisionsFrom(r.responsePayload)) found.push({ at: r.timestamp ?? null, ...d });
        if (found.length >= cap) break;
      }
      return found.slice(0, cap);
    });
    if (!out) return { present: false, decisions: [] };
    return { present: true, decisions: out };
  }

  /** The records half of GET /api/router: timing routes + ledger tool activations. */
  function routerRecords() {
    const timing = readTiming().slice(-50).reverse().map((t) => ({
      at: t.endMs ? new Date(t.endMs).toISOString() : null,
      totalMs: t.totalMs, route: t.route ?? null,
      slowestStage: t.slowest?.phase ?? null, slowestMs: t.slowest?.ms ?? null,
    }));
    const actions = withDb((db) => {
      if (!tableSet(db).has('ledger')) return null;
      return db.prepare(
        "SELECT timestamp, requestPayload, responsePayload FROM ledger WHERE recordType = 'ACTION' ORDER BY id DESC LIMIT 100",
      ).all();
    });
    return {
      timing,
      timingSource: 'per-turn timing records — the light runtime\'s own logs/server.log',
      actionsPresent: actions != null,
      actions: (actions ?? []).map((r) => ({
        at: r.timestamp ?? null, action: payloadAction(r.requestPayload),
      })).filter((a) => a.action),
    };
  }

  /** GET /api/activity — what the machine did, from all three durable sources. */
  function activity({ limit = 60 } = {}) {
    const cap = clampLimit(limit, 60, 200);
    const items = [];
    const turns = withDb((db) => {
      if (!tableSet(db).has('conversation_turns')) return null;
      return db.prepare(
        'SELECT conversationId, turnId, timestamp, mode, userText FROM conversation_turns ORDER BY timestamp DESC LIMIT 60',
      ).all();
    });
    for (const t of turns ?? []) {
      items.push({ kind: 'turn', at: t.timestamp ?? null, conversationId: t.conversationId, mode: t.mode ?? null, text: excerpt(t.userText) });
    }
    const tasks = readTasks();
    for (const t of tasks ?? []) {
      if (!t || typeof t !== 'object') continue;
      items.push({
        kind: 'task', at: t.updatedAt ?? t.finishedAt ?? t.startedAt ?? null,
        status: typeof t.status === 'string' ? t.status : null,
        title: excerpt(t.title ?? t.id ?? 'background task'), taskKind: typeof t.kind === 'string' ? t.kind : null,
      });
    }
    for (const t of readTiming().slice(-40)) {
      items.push({
        kind: 'timing', at: t.endMs ? new Date(t.endMs).toISOString() : null,
        totalMs: t.totalMs, route: t.route ?? null,
      });
    }
    items.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    return {
      ok: true, schema: FEEDS_SCHEMA,
      sources: {
        turns: turns != null, tasks: tasks != null, timing: true,
        turnsSource: `the daemon's conversation_turns — ${theDbPath}`,
        tasksSource: `the daemon's background-task registry — ${tasksFile}`,
      },
      items: items.slice(0, cap),
    };
  }

  /** The daemon half of GET /api/health: its state file + the §D.1 voice-turn tally. */
  function health() {
    let daemon = { stateFile: daemonStateFile, present: false, pid: null, port: null };
    if (daemonStateFile && existsSync(daemonStateFile)) {
      const parsed = parseJsonObject((() => { try { return readFileSync(daemonStateFile, 'utf8'); } catch { return null; } })());
      if (parsed) daemon = { stateFile: daemonStateFile, present: true, pid: typeof parsed.pid === 'number' ? parsed.pid : null, port: typeof parsed.port === 'number' ? parsed.port : null };
    }
    // The voice tally exists only where SOLOMON_VOICE_TURNS_PATH names the file (§D.1):
    // no env, no file the server may guess at — the count stays unmeasured, labeled.
    let voiceTurns = null;
    const voicePath = env.SOLOMON_VOICE_TURNS_PATH ? String(env.SOLOMON_VOICE_TURNS_PATH) : null;
    if (voicePath) {
      if (!existsSync(voicePath)) {
        voiceTurns = { path: voicePath, present: false, total: 0, byOutcome: {} };
      } else {
        const byOutcome = {};
        let total = 0;
        try {
          for (const line of readFileSync(voicePath, 'utf8').split('\n')) {
            const rec = parseJsonObject(line);
            if (!rec) continue;
            total += 1;
            const key = typeof rec.outcome === 'string' ? rec.outcome : typeof rec.status === 'string' ? rec.status : 'unrecorded';
            byOutcome[key] = (byOutcome[key] ?? 0) + 1;
          }
        } catch { /* an unreadable tally reads as absent, below */ }
        voiceTurns = { path: voicePath, present: total > 0 || existsSync(voicePath), total, byOutcome };
      }
    }
    const tables = withDb((db) => [...tableSet(db)].filter((t) => t === 'ledger' || t === 'conversation_turns'));
    return {
      daemon,
      store: { dbPath: theDbPath, present: tables != null, tables: tables ?? [] },
      tasks: { file: tasksFile, present: readTasks() != null },
      voiceTurns,
    };
  }

  /** The catalog half of GET /api/library: the payload's index files, read as data. */
  function catalog(catalogDir) {
    const readIndex = (name) => {
      if (!catalogDir) return null;
      const path = join(catalogDir, name);
      if (!existsSync(path)) return null;
      return parseJsonObject((() => { try { return readFileSync(path, 'utf8'); } catch { return null; } })());
    };
    const essentials = readIndex('essentials.json');
    const extensions = readIndex('extensions.json');
    const picks = readIndex('kingmaker-picks.json');
    return {
      dir: catalogDir,
      essentials: essentials ? {
        present: true, why: excerpt(essentials.why, 220),
        items: (Array.isArray(essentials.essentials) ? essentials.essentials : []).map((e) => ({ id: e?.id ?? null, role: e?.role ?? null, note: excerpt(e?.note, 120) })),
        considered: typeof essentials.considered === 'string' ? essentials.considered : null,
      } : { present: false, items: [] },
      extensions: extensions ? {
        present: true, updated: extensions.updated ?? null,
        items: (Array.isArray(extensions.extensions) ? extensions.extensions : []).map((e) => ({ id: e?.id ?? null, name: e?.name ?? null, maker: e?.maker ?? null })),
      } : { present: false, items: [] },
      picks: picks ? {
        present: true, why: excerpt(picks.why, 220), maxGbPerFile: picks.maxGbPerFile ?? null,
        items: (Array.isArray(picks.picks) ? picks.picks : []).map((p) => ({ role: p?.role ?? null, id: p?.id ?? null })),
      } : { present: false, items: [] },
    };
  }

  return {
    dataDir: theDataDir, dbPath: theDbPath, tasksFile,
    conversations, conversationTurns, audit, guardrailDecisions, routerRecords, activity, health, catalog,
  };
}
