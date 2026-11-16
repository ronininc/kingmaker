// lib/tool-docs.mjs — official documentation as an ATTRIBUTED source for tool-method drafts (2026-11-16). Opt-in
// (`kingmaker tools scan --docs`): the only network request is a GET of the tool's official manual URL, and nothing
// about the user is sent. Retrieved content is DATA: examples are parsed out of it and quoted (briefly, with
// attribution and licence) into the method; nothing in it is executed or followed as an instruction.
// Registry entries are explicit: a tool not listed here gets no web source (the draft says "not consulted").
import { createHash } from 'node:crypto';

const unesc = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

export const OFFICIAL_DOCS = Object.freeze({
  jq: Object.freeze({
    url: 'https://jqlang.org/manual/', publisher: 'jq project (jqlang)', licence: 'CC-BY-3.0 (documentation); jq code MIT',
    // Worked examples are <table>s of Command / Input / Output under each <h3> section.
    parse(html) {
      const out = []; let section = null;
      const re = /<h3[^>]*>([\s\S]*?)<\/h3>|<th[^>]*>Command<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<th>Input<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<th>Output<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
      let m; while ((m = re.exec(html))) { if (m[1] != null) section = unesc(m[1]); else out.push({ section, command: unesc(m[2]), input: unesc(m[3]), output: unesc(m[4]) }); }
      return out;
    },
    // The sections that teach selection and aggregation of data — the core of most requests.
    core: ['Identity', 'Object Identifier-Index', 'Array Index', 'Array/Object Value Iterator', 'Pipe', 'length', 'keys', 'map', 'select', 'add', 'min, max'],
  }),
});

export async function fetchOfficialDocs(tool, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const d = OFFICIAL_DOCS[tool]; if (!d) return null;
  const res = await fetchImpl(d.url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`official docs ${d.url} answered ${res.status}`);
  const html = await res.text();
  const examples = d.parse(html);
  const core = d.core.flatMap((name) => examples.filter((e) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[,:( ])`, 'i').test(e.section ?? '')).slice(0, 1));
  return { tool, url: d.url, publisher: d.publisher, licence: d.licence, retrievedAt: now().toISOString(), sha256: createHash('sha256').update(html).digest('hex'), examples: examples.length, quoted: core };
}

/** Pure: the know-how block a tool method's planning step gets from the official examples (attributed, brief). */
export function officialKnowHow(docs) {
  if (!docs?.quoted?.length) return '';
  return [`OFFICIAL EXAMPLES — ${docs.publisher}, ${docs.url} (${docs.licence}), retrieved ${docs.retrievedAt.slice(0, 10)}. Each: section: command → output for the shown input.`,
    ...docs.quoted.map((e) => `- ${e.section}: ${e.command}   input ${e.input.slice(0, 80)} → ${e.output.slice(0, 60)}`),
    'The command line is: jq [options] FILTER [FILE...]. Put the filter first, the file named in the request last.'].join('\n');
}
