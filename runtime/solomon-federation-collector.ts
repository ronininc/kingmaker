// Kingmaker — Solomon Federation Collector (the S→K transport, PULL side of the diode).
//
// Kingmaker reaches DOWN into Solomon's exposed read surface — the append-only sanitized outbox Solomon
// writes locally (Solomon opens no connection, holds no Kingmaker address). This collector reads that
// outbox, SANDBOXES every line (see contracts/federation-report), and keeps only well-formed sanitized
// reports: graduated abilities are STAGED under review (a governed step later promotes them into the Vault
// — never auto-canon), and BLOCKED-skill reports become cross-installation threat intel. Anything malformed
// or carrying a payload/pollution key is QUARANTINED and never ingested. So Kingmaker accumulates the
// ABILITIES acquired across every Solomon installation, staying as powerful as their sum, with no path for a
// compromised node to push code or data upward.
import { readFileSync } from 'node:fs';
import { sandboxIncomingReport, type FederatedAbilityRecord, type ThreatIntelRecord } from '../contracts/federation-report';

export interface CollectionResult {
  staged: FederatedAbilityRecord[];
  threats: ThreatIntelRecord[];
  quarantined: Array<{ line: number; reason: string }>;
  linesRead: number;
}

/** Dedup memory across pulls (installationId␟skillId, blocked␟skillId). Persist this between collections. */
export interface CollectorState { seen: Set<string> }
export function createCollectorState(): CollectorState { return { seen: new Set<string>() }; }

const SEP = '␟';

/**
 * Pull + sandbox + stage one read of Solomon's outbox. Idempotent across pulls when the same `state` is
 * reused: an ability/threat already seen is not re-staged. A missing/unreadable outbox yields an empty
 * result (Kingmaker never fabricates an ability it did not read).
 */
export function collectFromSolomonOutbox(outboxPath: string, opts: { state?: CollectorState; at?: string } = {}): CollectionResult {
  const state = opts.state ?? createCollectorState();
  const at = opts.at ?? new Date().toISOString();

  let text: string;
  try { text = readFileSync(outboxPath, 'utf8'); } catch { return { staged: [], threats: [], quarantined: [], linesRead: 0 }; }

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const staged: FederatedAbilityRecord[] = [];
  const threats: ThreatIntelRecord[] = [];
  const quarantined: Array<{ line: number; reason: string }> = [];

  lines.forEach((line, i) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { quarantined.push({ line: i + 1, reason: 'unparseable JSON' }); return; }

    const verdict = sandboxIncomingReport(parsed);
    if (!verdict.ok) { quarantined.push({ line: i + 1, reason: verdict.reason }); return; }

    const report = verdict.report;
    if (report.kind === 'federation') {
      for (const s of report.skills) {
        const key = `${report.installationId}${SEP}${s.id}`;
        if (state.seen.has(key)) continue;
        state.seen.add(key);
        staged.push({ installationId: report.installationId, skillId: s.id, name: s.name, category: s.category, graduated: s.graduated, origin: 'SOLOMON_FEDERATED', status: 'STAGED_UNDER_REVIEW', customerDataIncluded: false, receivedAt: at });
      }
    } else if (report.kind === 'skill' && report.verdict === 'BLOCKED') {
      const key = `blocked${SEP}${report.skillId}`;
      if (state.seen.has(key)) return;
      state.seen.add(key);
      threats.push({ installationId: 'unknown', skillId: report.skillId, categories: report.categories, verdict: 'BLOCKED', receivedAt: at });
    }
    // An ALLOWED skill report adds no new ability (the federation inventory carries the abilities) — ignored.
  });

  return { staged, threats, quarantined, linesRead: lines.length };
}
