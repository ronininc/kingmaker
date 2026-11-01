// The Brain Library's pull-request scan, as the library repo runs it (.github/scan/run.mjs, copied there by
// `node scripts/brain-library.mjs build`). The workflow checks out the library's own main, never the submission, so the
// scan that runs is always the owner's: the submitted files are fetched from GitHub's API as text and only read
// (lib/library-scan.mjs scanSubmission), never run. A failing scan fails the check and says why on the pull request's
// summary; a passing one only makes it ready for the owner's review.
import { appendFileSync } from 'node:fs';
import { scanSubmission, MAX_FILE_BYTES } from './library-scan.mjs';

const { GH_TOKEN, REPO, PR, GITHUB_STEP_SUMMARY } = process.env;
const api = (path, accept = 'application/vnd.github+json') => fetch(`https://api.github.com/${path}`, {
  headers: { authorization: `Bearer ${GH_TOKEN}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'kingmaker-brain-library-scan' },
});

const files = [];
for (let page = 1; page <= 3; page += 1) {
  const r = await api(`repos/${REPO}/pulls/${PR}/files?per_page=100&page=${page}`);
  if (!r.ok) { console.error(`could not list the pull request's files (${r.status})`); process.exit(1); }
  const batch = await r.json();
  files.push(...batch);
  if (batch.length < 100) break;
}
for (const f of files.slice(0, 21)) {
  if (f.status !== 'added' || !f.raw_url || f.changes > 50_000) continue;
  const r = await fetch(f.raw_url, { headers: { authorization: `Bearer ${GH_TOKEN}` } });
  if (!r.ok) continue;
  const buf = Buffer.from(await r.arrayBuffer());
  f.content = buf.length > MAX_FILE_BYTES ? ' '.repeat(MAX_FILE_BYTES + 1) : buf.toString('utf8');
}

const { ok, problems } = scanSubmission(files);
const report = ok
  ? `### ✓ Scan passed\n\n${files.length} new bench file(s). Ready for the owner's review; nothing is merged automatically.\n`
  : `### ✗ Scan failed\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\nOnly new bench results from \`kingmaker models bench\` can be submitted (see CONTRIBUTING.md).\n`;
console.log(report);
if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, report);
process.exit(ok ? 0 : 1);
