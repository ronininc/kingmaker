// preconfig.mjs — DESIGN §9.4 layers 1-3, all local. Layer 2 (the fit) examines what is already on
// the machine — application NAMES and work TYPES only — and renders a PROPOSAL the owner edits or
// rejects line by line. Nothing is applied silently; nothing here opens a socket (§9.4 zero-egress).
import { readdirSync, existsSync } from 'node:fs';
import { PROFILES } from './profiles.mjs';

const SIGNALS = [
  { type: 'media work', any: ['blender', 'ffmpeg', 'obs', 'gimp', 'inkscape', 'kdenlive'], profile: 'Creator' },
  { type: 'building work', any: ['git', 'node', 'gcc', 'make', 'python3', 'cargo', 'freecad', 'openscad'], profile: 'Builder' },
  { type: 'security work', any: ['nmap', 'wireshark', 'tcpdump', 'ghidra', 'zaproxy'], profile: 'Security' },
  { type: 'office/operations work', any: ['psql', 'sqlite3', 'curl'], profile: 'Operator' },
];
export function localInferenceProposal(path = '/usr/bin') {
  const apps = existsSync(path) ? readdirSync(path) : [];
  const found = [];
  for (const s of SIGNALS) { const hits = s.any.filter((a) => apps.includes(a)); if (hits.length) found.push({ type: s.type, evidence: hits, suggests: s.profile }); }
  const suggested = found.length ? found.sort((a, b) => b.evidence.length - a.evidence.length)[0].suggests : 'Desk';
  return {
    kind: 'preconfig-proposal', at: new Date().toISOString(), scannedPath: path, applicationsSeen: apps.length,
    signals: found, proposal: { profile: suggested, forward: PROFILES[suggested].forward, laneEmphasis: PROFILES[suggested].laneEmphasis },
    ownerLine: 'PROPOSAL ONLY — nothing applied. Edit or reject line by line; the edited record is the configuration.',
    egress: 'none — this inference ran on-device; its inputs never left the machine',
  };
}
