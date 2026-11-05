// Locally authored explanation policy; upstream prose never becomes policy or authority.
const DESCRIPTIONS = {
  'src-shell-pipe-exec':'Contains a command that pipes downloaded content into a shell; review its source before running it.',
  'src-shell-download':'Contains commands that download external content; this alone does not establish malicious intent.',
  'source-composite-critical':'Multiple execution or behavior patterns occur in the same text. This is a heuristic combination, not evidence that they ran.',
  'src-eval-call':'Runs code assembled from text.',
  'src-shell-eval':'May run a constructed shell command.',
  'src-pipe-to-shell':'Downloads content and immediately runs it as a shell program.',
  'src-new-function':'Builds executable code from text.',
  'src-py-eval-exec':'May execute text as a program or Python expression.',
  'behavior-covert-exfiltration':'Combines sensitive-data access with a possible outbound transfer.',
  'behavior-silent-persistence':'Contains behavior associated with starting again without a clear user action.',
};
export function explainReview(result,parsed,bytes) {
  const findings=(result.findings||[]).filter(f=>f.severity!=='info');
  const critical=findings.some(f=>f.severity==='critical'),high=findings.some(f=>f.severity==='high');
  const binaryRisk=result.binary&&['fail','block','deny','needs-owner'].includes(result.binary.verdict);
  const rejected=critical||high||binaryRisk||parsed.format==='Sensitive key material';
  const level=critical?'critical':rejected?'high':findings.length||parsed.activeContent?'moderate':parsed.limitations.length?'unknown':'low';
  const reasons=[...new Set(findings.map(f=>DESCRIPTIONS[f.rule]||`${f.title||f.rule}: ${f.detail||'Static risk pattern; review the matched evidence.'}`))].slice(0,8);
  if(binaryRisk)reasons.push('Binary analysis did not admit this file.');
  if(parsed.format==='Sensitive key material')reasons.push('This contains private-key material, which is not accepted in ordinary review.');
  if(parsed.activeContent&&!reasons.length)reasons.push('Active document content was detected; it was not run.');
  const documentContext=['HTML','Text','JSON','Delimited text','TSV'].includes(parsed.format)&&parsed.kind!=='source';
  const disposition=rejected?(documentContext?'review-needed':'ejected'):'reviewed';
  const announcement=rejected&&documentContext
    ?`Document review requires an admin decision. Heuristic risk rating: ${level.toUpperCase()}. ${reasons.join(' ')} Matches may occur in documentation, examples or webpage scripts; they do not prove unauthorized access or a breach. An inert text preview is available. Nothing was installed or executed. The original was not removed.`
    :rejected
    ?`Rejected from the review sandbox. Danger rating: ${level.toUpperCase()}. ${reasons.join(' ')} These are static-analysis findings, not proof the file ran or infected the device. The sandbox copy and its entire disposable workspace were removed. The original file was not removed by this upload review.`
    :`Static review completed. Danger rating: ${level.toUpperCase()}. ${reasons.join(' ')} ${parsed.limitations.length?'Inspection has limits; this is not a clean-device verdict.':'No configured risk pattern was detected; this is not a guarantee of safety.'} The content was not executed.`;
  let preview=null;
  if(!rejected||documentContext) {
    let text=parsed.texts.map(item=>`--- ${item.name} ---\n${item.text}`).join('\n\n');
    const markup=/<(?:!doctype\s+html|html|body|script|iframe)\b/i.test(text);
    if(markup)text=text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' [active/stylesheet content omitted] ').replace(/<[^>]{0,8192}>/g,' ');
    text=text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'[control]');
    if(!text)text='No text decoder is available for this format. Header bytes (hex):\n'+bytes.subarray(0,256).toString('hex').match(/.{1,32}/g).join('\n');
    preview={mode:'inert-text',text:text.slice(0,32768),truncated:text.length>32768,markupRemoved:markup,
      notice:'Text-only preview. No scripts, links, images, embedded objects or commands execute. Unsupported formats are not rendered.'};
  }
  let retention=null;
  if(rejected&&parsed.format!=='Sensitive key material'&&parsed.texts.length){
    let text=parsed.texts.map(item=>item.text).join('\n\n').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' [active content omitted] ').replace(/<[^>]{0,8192}>/g,' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'[control]');
    retention={text:text.slice(0,32768),notice:'Would you like to retain useful text before removing the original? Edit this draft to keep only what you need. It will be scanned again and saved only as plain text; it is not a repaired executable or a guarantee of safety.'};
  }
  return {retention,disposition,risk:{level,reasons,basis:'bounded-static-analysis'},announcement,preview};
}
