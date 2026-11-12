// finding-explain.mjs — Scripture Armor's explanation layer (Item 4,
// owner requirement 2026-11-05 22:58: findings explained the way the XZ
// walkthrough presenter explained the backdoor — stage by stage, in
// plain language addressed to the user: WHAT it is, WHERE it hides,
// WHAT TRIGGERS it, WHAT IT WOULD DO).
//
// Design law:
//  * An explanation is a PURE FUNCTION of the finding's own recorded
//    evidence (rule, severity, basis, location, detail, excerpt — or
//    the REA shape: why, code, file, line, fix). It never invents a
//    trigger, a call path, or a behavior the evidence does not carry:
//    where the evidence is silent, the explanation says so in words.
//  * Explanations never change a verdict. They explain the verdict
//    that exists; the harm test and every severity stay exactly as
//    the engines assigned them.
//  * The canonical scan record (scan.mjs canonicalScanRecord) is a
//    digest-bound format and is NOT extended: explainRecord() derives
//    explanations for a sealed record at read time, and the live
//    record producers attach the same derivation at scan time. Both
//    paths produce identical objects because the derivation is pure.
//
// Template coverage is a build gate, not a hope: test/finding-explain
// .test.mjs derives every statically emittable rule id from the live
// sources (rule pack data, scan/format/rea source literals, REA rule
// tables) and fails if any lacks a dedicated template here. Runtime-
// generated rule ids are unbounded by construction and are handled
// explicitly: shield-generated REA rules (gen.<base>.<cycle>) derive
// from their base rule's template; pack-generated detectors (arbitrary
// ids from derivePack) render through the generic fallback, which is
// built from the finding's own detail text — never silent, never a
// bare code.

export const EXPLANATION_SCHEMA = 'scripture-armor.explanation/1';
export const DOWNLOAD_EXPLANATION_SCHEMA = 'scripture-armor.download-explanation/1';

// Ids that may legitimately lack a dedicated template, EACH with its
// reason. Visible by construction: the coverage gate prints this list
// and fails on any id that is neither templated nor listed here.
// Currently empty — every statically emittable id has a template.
export const EXPLANATION_EXCLUSIONS = Object.freeze({});

// ---------------------------------------------------------------------------
// Finding normalization — the two shapes the engines emit.
//   scan/format shape: { rule, severity, basis, location, detail, excerpt? }
//   REA shape:         { rule, severity?, kind, why, fix, file, line, code }
// ---------------------------------------------------------------------------

function normFinding(f) {
  const src = f || {};
  const location = src.location != null
    ? String(src.location)
    : (src.file ? (src.line ? `${src.file}:${src.line}` : String(src.file)) : null);
  return {
    rule: String(src.rule || 'unknown'),
    severity: src.severity || null,
    basis: src.basis || (src.why ? 'rea' : null),
    location,
    detail: String(src.detail || src.why || ''),
    excerpt: src.excerpt != null ? String(src.excerpt) : (src.code != null ? String(src.code) : null),
    kind: src.kind || null,
    fix: src.fix,
    generated: !!src.generated,
  };
}

// ---------------------------------------------------------------------------
// Stage helpers — the honesty mechanics shared by every template.
// ---------------------------------------------------------------------------

const clip = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function evidenceWhere(f) {
  if (f.excerpt) {
    return f.location
      ? `The scan pinned it to ${f.location} and kept the actual text: “${clip(f.excerpt)}”.`
      : `The scan kept the actual text: “${clip(f.excerpt)}”.`;
  }
  if (f.location) return `The scan pinned it to ${f.location}. It did not keep the surrounding text for this finding.`;
  return 'The scan did not record a location for this finding.';
}

const TRIGGER_NOT_SHOWN = 'The evidence in this finding does not show what would set it off at run time, and the explanation will not invent one: what is established is that the thing described is present, as recorded above.';

function patternTrigger(construct) {
  return `It acts when the program runs and reaches this code — ${construct}. A pattern scan cannot show whether the program's own logic ever reaches it; presence in the text is what is proven.`;
}

const CERTAINTY = {
  'pattern': 'How Armor knows: a text pattern matched. The file was not run. A pattern shows the construct is present in the text — it cannot show whether the program ever reaches it.',
  'pattern-composite': 'How Armor knows: two patterns matched in one file and the source lane’s composition rule fired. Neither pattern was executed; the composition is a recorded judgment about the combination.',
  'inventory': 'How Armor knows: an inventory observation — something present in the file was catalogued. Presence is a fact; it is not a claim that the thing is used.',
  'path-heuristic': 'How Armor knows: the binary analyzer traced call paths through the compiled code. The path exists in the call graph; whether outside input can steer it is a further question the heuristic does not answer.',
  'exact-hash': 'How Armor knows: the file’s SHA-256 was compared with the owner’s list. A hash match is byte-for-byte identity, not resemblance.',
  'coverage': 'How Armor knows: this is the inspector reporting the edge of its own coverage — a statement about the scan, not about the file’s behavior.',
  'rea': 'How Armor knows: REA read this line of the code directly (its reader excludes comments and printed advice). The code was not run.',
  'littlebrother-enrichment': 'How Armor knows: a public-source lookup made at scan time. Outside context can be wrong or stale; it is recorded as context, not as a verdict.',
};
const CERTAINTY_DEFAULT = 'How Armor knows: recorded by the scan engine as part of this record. The file was not run.';

// REA consequence framing, from the finding's own fix field: what the
// sandbox takes away (or cannot). Appended to an REA template's effect
// only when the finding carries the REA shape (fix !== undefined).
function fixSuffix(f) {
  if (f.fix === undefined) return '';
  if (f.fix === null) return ' In Armor’s handling this is the class the sandbox cannot take away, so the connector is refused outright rather than run with the dangerous part trimmed.';
  if (f.fix === 'network') return ' In Armor’s handling, this is one of the parts the sandbox takes away: the connector may run, but its network access is cut.';
  if (f.fix === 'files') return ' In Armor’s handling, this is one of the parts the sandbox takes away: the connector may run, but its access to files of this kind is cut.';
  if (f.fix === 'exec') return ' In Armor’s handling, this is one of the parts the sandbox takes away: the connector may run, but its ability to run programs or raise its own privileges is cut.';
  return '';
}

// ---------------------------------------------------------------------------
// The generic fallback — for rule ids with no dedicated template
// (runtime-generated pack detectors). Built entirely from the finding's
// own fields; it says plainly that it is a general rendering.
// ---------------------------------------------------------------------------

const SEVERITY_EFFECT = {
  critical: 'Its severity is critical — the class Armor stops on. The specific behavior is the one its own description above names.',
  high: 'Its severity is high — in Armor’s scoring a high finding on its own is enough to keep a file from passing quietly.',
  medium: 'Its severity is medium — a real capability or shape worth knowing about, short of the stop classes on its own.',
  low: 'Its severity is low — recorded so the file’s full picture exists, with correspondingly small weight.',
  info: 'Its severity is info — a record line, not an accusation; it carries no weight in the verdict.',
  reject: 'Its severity class is reject — the class Armor refuses rather than runs.',
  sandbox: 'Its severity class is sandbox — the class Armor allows only with the named ability taken away.',
};

function genericTemplate(f) {
  return {
    what: `This finding was recorded under the rule “${f.rule}”. Its own description, written by the detector that produced it, reads: ${f.detail || '(the detector recorded no description)'}`,
    trigger: TRIGGER_NOT_SHOWN,
    effect: (g) => SEVERITY_EFFECT[g.severity] || 'Its weight in the verdict is the one its severity names.',
    generic: true,
  };
}

// ---------------------------------------------------------------------------
// Templates. Each stage is one or two plain sentences; a stage is a
// string or a function of the normalized finding. `hides` is the
// class-level "where this kind of thing sits" sentence; the renderer
// always appends the evidence line for THIS finding after it.
// ---------------------------------------------------------------------------

const TEMPLATES = {};

// --- Source lane: the detector pack (shield-packs/scan-rules-pack.json) ---

Object.assign(TEMPLATES, {
  'src-eval-call': {
    what: 'This line calls eval() — a function that takes text and runs it as program code, as if it had been written into the program from the start.',
    trigger: patternTrigger('the text handed to eval() becomes code at that moment'),
    effect: 'Whoever or whatever supplies that text controls what the program does next. Code that arrives as text is invisible to every check that read this file as written.',
  },
  'src-dynamic-function': {
    what: 'This line builds a brand-new function out of a string of text (new Function(...)) and can then call it like any other part of the program.',
    trigger: patternTrigger('the string is compiled into a function when the line runs'),
    effect: 'The real behavior is decided by text assembled at run time, so the file you scanned is not the whole program — part of it is written later, by the program or by whoever feeds it strings.',
  },
  'src-vm-run': {
    what: 'This line uses Node’s vm module to run a string as code (vm.runIn…), inside a separate context the program sets up.',
    trigger: patternTrigger('the string is executed when the line runs'),
    effect: 'The separate context is a fence, not a wall: what matters is what the string contains and what the program hands across the fence with it. Either way, behavior arrives as text, after the file was reviewed.',
  },
  'src-child-process-exec-interp': {
    what: 'This line runs an outside program through child_process, and the command it runs is built by gluing pieces of text together — interpolation or concatenation — rather than being one fixed command written out in the file.',
    trigger: 'When the program reaches this line, the pieces are joined and handed to the system as one command to execute. The scan matched the gluing; it does not trace where each piece came from.',
    effect: 'If any glued-in piece comes from outside data — a file name, a download, user input — that data can change the command itself, not just its input. That is the classic route from “the program runs a tool” to “the data runs the machine.”',
  },
  'src-child-process': {
    what: 'This file brings in child_process, the part of Node that starts other programs.',
    trigger: 'Nothing here is a trigger by itself: importing the tool is not using it, and this finding makes no claim about which programs get started.',
    effect: 'On its own this is capability, not behavior — many honest programs start helpers. It is recorded so the program’s reach is visible: this file can, in principle, run other programs.',
  },
  'src-dynamic-import': {
    what: 'This line loads another module with import(), and the name of what it loads is a variable rather than fixed text in the file.',
    trigger: 'When the line runs, whatever the variable holds at that moment is what gets loaded — and loaded code executes as part of the program.',
    effect: 'The scan cannot tell from this file alone what code will actually be pulled in. The loaded module is decided at run time, possibly from data outside the file.',
  },
  'behavior-remote-activation': {
    what: 'This code opens a listening socket or starts a server — it sets the program up to be reached and activated over the network.',
    hides: 'It sits wherever the program sets up its public ear.',
    trigger: 'Once the program is running, the trigger is an outside connection arriving: anything that can reach that socket or server can talk to it.',
    effect: 'A program that listens can be driven by someone other than the person who started it. Whether that is intended depends on what the server does with connections, which this pattern alone does not show.',
  },
  'behavior-sensor-access': {
    what: 'This code uses a camera or microphone capture API — it can take pictures or record sound through the device.',
    trigger: patternTrigger('the capture call records when the code runs'),
    effect: 'Software that can see and hear through the device can watch the room it sits in. The pattern does not show whether it asks the user first or records quietly — in a program with no obvious reason for a camera or microphone, the reach itself is the finding.',
  },
  'src-shell-pipe-exec': {
    what: 'This line downloads something from the network and pipes it straight into a shell — the downloaded bytes are executed as commands, sight unseen.',
    hides: 'It hides in the open, usually dressed as an install or setup step.',
    trigger: 'The download and the execution are the same act: when this line runs, whatever the server sends back runs.',
    effect: 'The program’s behavior becomes whatever a remote server decides at that moment. It can change tomorrow without this file changing, and nothing about it can be reviewed in advance — this is the shape of most drive-by compromises.',
  },
  'src-shell-download': {
    what: 'This command fetches a payload from a remote address over http(s).',
    trigger: patternTrigger('the payload arrives from the network when the line runs'),
    effect: 'By itself, a download is only the first half of download-and-execute. It still means part of what this program works with was not in the file you scanned, and can change on the server without any change here.',
  },
  'src-shell-eval': {
    what: 'This line uses the shell’s eval: it builds a command as text and then has the shell run that text.',
    trigger: 'When the line runs, the assembled text becomes commands. Any piece of the text that came from data — a variable, a file, input — becomes part of the command itself.',
    effect: 'Data stops being data and becomes instructions. That is how a harmless-looking script ends up running commands its author never wrote out.',
  },
  'src-shell-decode-exec': {
    what: 'This line decodes base64 text and feeds the result into a shell to run.',
    trigger: 'When it runs, the encoded block is turned back into commands and executed in the same motion.',
    effect: 'The encoded block is the real program, written so a reader — or a scanner — cannot see what it does at a glance. Decoding straight into a shell is how payloads hide inside ordinary-looking scripts.',
  },
  'src-py-eval-exec': {
    what: 'This line calls Python’s eval() or exec() on a string — running text as Python code.',
    trigger: patternTrigger('whatever string it is handed becomes program'),
    effect: 'Behavior is decided by text that may be assembled or fetched at run time, so reviewing this file does not review everything the program can do.',
  },
  'src-py-os-system': {
    what: 'This line hands a command to the operating system’s shell through os.system or os.popen.',
    trigger: 'When it runs, the shell executes the command string exactly as if someone had typed it into a terminal.',
    effect: 'If any part of that string is built from data the program did not itself write, the data can bend the command. Even when the command is fixed, the program is reaching outside itself to act on the machine.',
  },
  'src-py-subprocess-shell': {
    what: 'This line starts another program through Python’s subprocess with shell=True — the command is interpreted by a shell rather than run directly.',
    trigger: 'When it runs, the shell parses the whole command string first, so anything in the string that looks like shell syntax — pipes, semicolons, substitutions — is acted on.',
    effect: 'Shell interpretation is the gap data slips through: a value meant to be a plain argument can become extra commands. Running the same program without a shell would not have that gap.',
  },
  'src-py-pickle-loads': {
    what: 'This line loads data with Python’s pickle module (pickle.loads or pickle.load).',
    trigger: 'The trigger is the loading itself: pickle data is a small program for a built-in machine, and loading it can run instructions embedded in the data, before the program does anything else with it.',
    effect: 'A pickle file is not passive data. A crafted one executes code as it is read — so a pickle from anyone else is, in effect, code from someone else.',
  },
  'behavior-silent-persistence': {
    what: 'This code sets up a persistence mechanism — cron, a systemd service, a launchd entry, or a registry Run key: a standing instruction to the system to start this program again on its own.',
    trigger: 'Once installed, the trigger belongs to the system, not the user: a reboot, a login, or a timer starts the program without anyone choosing to run it.',
    effect: 'The program outlives the session it was started in and can come back after restarts. That staying power is one of the behaviors that separates tools from intruders.',
  },
  'behavior-removal-resistance': {
    what: 'This code carries a mechanism associated with resisting removal or analysis — watching for its own termination, respawning itself, or checking for analysis tools.',
    trigger: 'It acts when someone tries to stop, remove, or examine the program. That is the moment it is built for.',
    effect: 'Software that fights removal stops being fully under its owner’s control: deleting the file may not end it. Some protective tools do this legitimately; in an unknown program it has to be named.',
  },
});

// --- Source lane: the checks hardcoded in scan.mjs / scanWithPack ---

Object.assign(TEMPLATES, {
  'source-lane-notice': {
    what: 'This is the source scanner’s label on its own work: the file was read as text and checked against a list of known patterns.',
    trigger: 'Nothing triggers it; it is the scan describing itself.',
    effect: 'It is not an accusation and carries no weight in the verdict. It exists so the record says plainly what kind of looking was done — and that a pattern scan can only find the patterns it knows.',
  },
  'behavior-covert-exfiltration': {
    what: 'In one file, two things appear together: a channel that can send data out (a network request) and bulk access to local data — reading files wholesale, or reaching into the environment, where keys and tokens live. Both halves are named in the detail.',
    trigger: 'Both halves are present in the same file. Whether they are actually connected — whether the gathered data is what gets sent — is a question of the program’s logic, which this co-occurrence check does not trace.',
    effect: 'That pairing is the working shape of exfiltration: gather broadly, send quietly. Each half alone is ordinary; together in one file they earn a hard look before the program is trusted.',
  },
  'dependency-inventory': {
    what: 'This is an inventory line: the file is a dependency manifest, and the detail lists what it declares — the packages it depends on, or the install/run scripts it defines. The scanner wrote them down without judging them.',
    trigger: 'Nothing triggers it; a manifest is a declaration, not an act.',
    effect: 'No weight in the verdict. A program’s real reach comes through its dependencies, so the record names them — a name on this list is a fact, not a finding against it.',
  },
  'source-composite-critical': {
    what: 'Two independent high-severity patterns from the code-execution or behavior families appear in the same file, and the source lane’s composition rule raises them together into a critical finding. The detail names the pair.',
    trigger: 'Each pattern has its own trigger; the composite’s point is the combination — typically one pattern that obtains or builds code, and another that can run it or act on the machine.',
    effect: 'Separately, each pattern has innocent uses. Together in one file they form a working chain — the same reason a single odd wire is nothing and a wired detonator is something. The pair is shown in the detail so the judgment can be checked.',
  },
});

// --- Binary lane (scan.mjs normalizeBinaryFindings / scanBinaryFile) ---

const IMPORT_CATEGORY_GLOSS = {
  'process-injection': 'reach into another running program’s memory and execution',
  'persistence': 'make itself start again at login or on a schedule',
  'network-control': 'open, redirect, or take control of network connections',
  'sensor-access': 'use the device’s camera, microphone, or location',
  'removal-resistance': 'watch for — and resist — being stopped or removed',
};

Object.assign(TEMPLATES, {
  'exact-sample-hash': {
    what: 'This file’s SHA-256 hash appears on the owner’s own curated list of known-bad samples (badhashes.txt, kept in the identity store).',
    trigger: 'There is no trigger to reconstruct: the identification is the file itself, byte for byte.',
    effect: 'A hash match is the strongest identification a scan can make — this is not “similar to” a bad file, it is the same bytes. Armor treats it as stop-class.',
  },
  'dangerous-import': {
    what: (f) => {
      const cat = (f.detail.split(' capability present')[0] || 'a dangerous-capability').trim();
      const gloss = IMPORT_CATEGORY_GLOSS[cat];
      return `This compiled program’s import table names a function in the ${cat} family${gloss ? ` — the family of functions that let a program ${gloss}` : ''}. The import table is the program’s own declaration of what it may call.`;
    },
    trigger: 'Presence is not use: an import says the capability is within reach, not that any code path calls it. Where the analyzer also traced a path to a dangerous sink, that appears as its own finding (sink-reachability).',
    effect: 'Recorded as a fact about the program’s reach. The weight it carries depends on the family — a program that imports process-injection functions has declared a larger reach than one that has not — but an import alone does not prove the reach is ever used.',
  },
  'sink-reachability': {
    what: (f) => f.detail.includes('unbounded-copy')
      ? 'The analyzer traced a call path inside the compiled program to an unbounded-copy function — one of the strcpy/strcat family, which copies data with no length check.'
      : 'The analyzer traced a call path inside the compiled program to a command-execution function — one of the exec/system family, which runs other programs or shell commands.',
    hides: 'It hides in the call graph: no single line of the file says “attack”; the shape appears only when the path from an entry point to the dangerous function is followed.',
    trigger: (f) => `The path in the location is the trigger route: execution flows from the named starting function toward the sink. Reachability is heuristic — the route exists in the call graph; the scan does not prove an outsider can steer it.`,
    effect: (f) => {
      if (f.detail.includes('unbounded-copy')) return 'If the copied data can be longer than the space reserved for it, the copy overwrites neighboring memory — the overflow shape behind a large share of native-code exploits. This rule shows the path exists; it cannot prove the copy overflows.';
      if (f.detail.includes('NON-literal argument')) return 'The decompiled code at the sink shows the command argument is NOT a fixed literal — it is built or received at run time. That is the classic command-injection shape: data reaching a command. The finding says “candidate” in its own detail, and it means it: reachability is shown, argument control is not proven.';
      if (f.detail.includes('evidence is UNKNOWN')) return 'The scan could not determine whether the command argument is a fixed literal or built from data, and it says so rather than guessing. No safety claim is made in either direction — the path alone is the finding.';
      return 'The command argument is a compile-time literal — a fixed command the program itself chose, written into it when it was built. That bounds the concern: the sink is reachable, but the command is the program’s own.';
    },
  },
  'unbounded-copy-call': {
    what: 'A function in this compiled program calls an unbounded-copy function (the strcpy/strcat family) directly, and no length-checked variant appears in the same function. The detail counts the call sites.',
    trigger: 'It fires whenever this function runs and performs the copy.',
    effect: 'Unbounded copies are dangerous exactly when the source data can outgrow the destination space. The scan shows the call exists without a checked alternative nearby; it cannot measure the buffers, so this stands as a candidate, labeled as such.',
  },
  'embedded-endpoint': {
    what: 'Written into this file, as plain text, is a network address — the detail shows it. It was put there when the file was made.',
    trigger: 'A string is not a connection: nothing here shows the program contacts this address. But the address’s presence says the program was built knowing it.',
    effect: 'Endpoints are the map of where a program might report or fetch. Recorded as inventory so the map exists in the record; on its own it is a fact, not an accusation.',
  },
  'library-identification-status': {
    what: 'Function-ID library matching was not performed for this file, so the scan cannot say which known libraries are bundled inside it.',
    trigger: 'Nothing triggers it; it is the analyzer marking the edge of what it did.',
    effect: 'An honesty line: an empty library list here means “not looked”, not “nothing there”. No part of the verdict rests on it.',
  },
  'known-library': {
    what: (f) => f.detail.includes('owner flag list')
      ? 'Part of this compiled program is recognized library code, identified by the Function-ID matcher — and this library is on the owner’s own flag list (flagged-libraries.txt).'
      : 'Part of this compiled program is recognized library code — the Function-ID matcher identified which known library this stretch of code belongs to. The detail names it.',
    trigger: 'Nothing triggers it; it is an identification, not an act.',
    effect: (f) => f.detail.includes('owner flag list')
      ? 'The owner has already decided this library deserves scrutiny wherever it appears, so its presence raises the finding. The library being bundled is a fact; why it was flagged is the owner’s own record.'
      : 'Library code is usually exactly what it claims to be. The record names it so the program’s makeup is visible — most of any compiled program is other people’s libraries, and knowing which is part of knowing the program.',
  },
  'static-analysis-limited': {
    what: 'This finding is about the scan itself: the analysis of this file is limited, and the detail names why — a packer’s signature, a high-entropy (packed or encrypted) region, decompiler failures, observation caps that omitted material, or a checksum-valid UPX pack header whose packed content was not unpacked.',
    trigger: 'Nothing triggers it; it is the analyzer reporting what it could not see.',
    effect: 'The consequence is a cap on trust, not a claim about the file: an opaque binary cannot earn a pass from a blind scan, so the verdict is capped at warn. What is packed or unread was not judged either way — it was not seen.',
  },
  // Consolidation bridge (2026-11-06): this rule id is emitted by
  // Item 3's unpacking lane in scan.mjs; Item 4's template set predates
  // it. Added so the merged tree passes its own coverage gate.
  'packed-content-unpacked': {
    what: 'This binary arrived UPX-packed, and the packed content was unpacked inside the scan workdir and scanned through the normal binary lane. The detail names the pack evidence that was found.',
    trigger: 'Nothing triggers it; it is the scanner reporting that the packed layer was opened — the rest of the record judges what was inside.',
    effect: 'The findings, confidence and verdict of this record describe the UNPACKED program, not the packed loader stub: packed content cannot earn a pass by hiding behind its wrapper, and a packed clean program is judged on its actual code. The unpacked copy existed only inside the scan workdir and was wiped with it.',
  },
});

// --- Format lane (format-inspect.mjs) ---

Object.assign(TEMPLATES, {
  'format-structure': {
    what: 'An inventory line from the format inspector: the detail records the file’s structure as found — its format and version, and what was actually looked at (a PDF’s page objects, an archive’s entries, an image’s chunks).',
    trigger: 'Nothing triggers it; it is the inspector describing the specimen.',
    effect: 'No weight on its own. It exists so the record shows the shape of the thing inspected and how far the inspection went — structure and metadata, never rendering or execution.',
  },
  'format-unsupported': {
    what: 'This file’s format cannot be inspected safely by this build, and the scanner says so instead of guessing — the detail names the format and the reason.',
    trigger: 'Nothing triggers it; it is a boundary marker.',
    effect: 'This is a coverage gap, not a clean bill: the file was NOT inspected. Treating an uninspected file as safe would be the failure this finding exists to prevent.',
  },
  'pdf-javascript': {
    what: 'This PDF declares JavaScript inside the document — a /JavaScript entry or a /JS action, per the detail.',
    hides: 'It hides in the document’s action dictionaries: invisible in the rendered page, attached to the document or its elements.',
    trigger: 'PDF JavaScript is set to run when the document is opened, or when an element is interacted with, inside whatever reader opens it. This lane inventoried it and never executed it.',
    effect: 'A document that carries its own code stops being passive paper: opened in a reader that honors it, the script acts with that reader’s access to the machine. That is how a “document” becomes a delivery vehicle.',
  },
  'pdf-open-action': {
    what: 'This PDF carries an /OpenAction — an instruction that something happen automatically when the document is opened.',
    trigger: 'The trigger is opening the document. No click inside the content is needed.',
    effect: 'Automatic actions remove the reader’s moment of choice: whatever the action points at — a first page, a script, an external reference — is engaged by the act of opening.',
  },
  'pdf-additional-actions': {
    what: 'This PDF carries additional actions (/AA) — extra behaviors attached to events such as a page opening, the document closing, or an element being used.',
    trigger: 'Each action fires on its bound event, during ordinary reading.',
    effect: 'Behavior woven into ordinary document events is behavior a reader triggers without deciding to. The actions are inventoried here and were never executed.',
  },
  'pdf-launch-action': {
    what: 'This PDF carries a /Launch action — an instruction to start an external program.',
    trigger: 'Launch actions are offered or fired when the document is opened, depending on the reader’s settings.',
    effect: 'A document that can start programs has left the category of documents. Even when a reader asks first, the ask itself is the attack surface: the file is requesting that the machine run something.',
  },
  'pdf-embedded-file': {
    what: 'This PDF embeds another file inside it (/EmbeddedFile) — a passenger file carried in the document’s body.',
    trigger: 'The embedded file does nothing while embedded. It acts only if extracted and opened — which is exactly the step the carrier is designed to invite.',
    effect: 'The wrapper is a document; the payload is whatever is inside. This lane did not extract or open it, and inspecting the PDF does not inspect the embedded file’s contents.',
  },
  'pdf-uri': {
    what: 'This PDF carries external URI references — links pointing outside the document.',
    trigger: 'A link acts only if followed; nothing here follows one.',
    effect: 'Inventory only: a link is not an action. The record names where the document points so the destination is part of the file’s story.',
  },
  'pdf-stream-indicator': {
    what: 'Text recovered from this PDF’s compressed streams contains code-execution vocabulary — words of the eval / system / powershell kind.',
    trigger: 'Vocabulary is not behavior: these words also appear in documentation and security writing. Nothing here shows the words are executed.',
    effect: 'Recorded as an indicator, not proof — a reason to look closer at a document whose own text talks about running code, weighted as a pattern can bear.',
  },
  'archive-entry-encrypted': {
    what: 'An entry inside this archive is encrypted: its name shows in the listing (the location names it), but its content cannot be read without its password.',
    trigger: 'Nothing triggers it; the entry is a sealed compartment.',
    effect: 'What cannot be read cannot be inspected: this entry is a declared blind spot. The archive can be judged as a container, but no verdict covers what is inside this entry.',
  },
  'archive-macro': {
    what: 'This archive contains an Office macro project (vbaProject.bin) — the code store where a document’s macros live.',
    trigger: 'Macros run when the containing document is opened in an Office application that allows them — historically, often with a plausible document and one click on “enable content”.',
    effect: 'Macros are full programs living inside documents: they can read files, fetch payloads, and act as the user. They are inventoried here and never executed; this lane did not read the macro code itself.',
  },
  'archive-entry-executable': {
    what: 'Inside this archive sits an executable or script entry — the location names it: a program traveling inside a container.',
    trigger: 'It acts only if extracted and run. The archive itself does not run it.',
    effect: 'Passing or sealing the archive says nothing about this entry’s code — the listing lane does not inspect it. An archive is a suitcase; this finding names the tool inside without claiming what it does.',
  },
  'archive-nested': {
    what: 'This archive contains another archive inside it.',
    trigger: 'Nothing triggers it; it is a statement about depth.',
    effect: 'This lane lists one level deep. The nested archive’s contents are a coverage gap unless scanned separately — each layer of wrapping hides the next from a listing-level look.',
  },
  'media-text-chunk': {
    what: 'This image carries a text chunk — words stored in the image file’s own metadata rather than its picture. The detail shows what the chunk says, in part.',
    trigger: 'Nothing triggers it; viewers that show the image do not run its text.',
    effect: 'Inventory only: image text chunks are where captions, tool names — and occasionally instructions or links — ride. The pixels were not decoded; the words are recorded so they are part of the file’s record.',
  },
  'media-trailing-data': {
    what: 'There are bytes in this file AFTER the image’s official end marker — data appended beyond the complete image. The detail counts them.',
    hides: 'It hides past the end of the picture: every normal viewer stops at the end marker, so appended data is invisible in the image as shown.',
    trigger: 'Nothing in a normal viewer reads past the end marker. The trailing bytes would act only if something extracted and used them.',
    effect: 'Appending data after an image’s end is a classic payload-hiding shape: the file shows as a picture while carrying a second, invisible passenger. The trailing bytes were not interpreted — the finding is the shape, not the content.',
  },
  'media-exif': {
    what: 'This image carries EXIF metadata — the fields cameras and phones write into photos: device, time, and possibly location.',
    trigger: 'Nothing triggers it; metadata describes, it does not act.',
    effect: 'Inventory only. EXIF is a privacy surface rather than a behavior: it can say where a photo was taken, which matters when the file travels further than its owner intended.',
  },
  'binary-high-entropy': {
    what: 'This file’s bytes measure as high-entropy — they look random, the way encrypted, compressed, or packed content does. The detail gives the measured figure.',
    trigger: 'Nothing triggers it; it is a measurement of the file as it lies.',
    effect: 'Readable code is not random-looking. High entropy says part of this file cannot be read as it lies, so the rest of the inspection sees less than the file contains — whatever indicators exist may be inside the packed or encrypted region.',
  },
  'binary-string-indicator': {
    what: 'Among this binary’s readable strings are words from the process and network vocabulary — exec, system, powershell, curl, and their kin.',
    trigger: 'Words are not actions: libraries, error messages, and help text carry the same words. Nothing here shows the program using them.',
    effect: 'An indicator, weighted as one. In a file that could not be fully analyzed, the vocabulary it carries is one of the few visible signs of what it was built to reach for.',
  },
});

// --- REA (lib/rea-rules.mjs tables + lib/rea.mjs synthetic ids) ---
// REA findings carry why/code/file/line/fix; the fix framing (what the
// sandbox takes away, or that it cannot) is appended by the renderer
// from the finding's own fix field — see fixSuffix().

Object.assign(TEMPLATES, {
  'telemetry.host': {
    what: 'This code names a known analytics service’s own collection address — PostHog, Sentry, Mixpanel, and their kin: the endpoint usage reports are sent to.',
    trigger: 'Telemetry fires as the program runs: events are packaged and sent to that address during ordinary use.',
    effect: 'What is sent is usage data — what the program did, when, and on whose machine. Quietly or not, the program reports home.',
  },
  'telemetry.sdk': {
    what: 'This code imports an analytics SDK itself — a library whose whole job is collecting usage and sending it to whoever configured it.',
    trigger: 'Once imported and initialized, the SDK collects and sends as the program runs. Where it sends depends on configuration the import line does not show.',
    effect: 'An analytics library in the code means reporting is a designed feature, not an accident — and its destination can be set to any host, including one that is not the vendor’s.',
  },
  'credentials.keychain': {
    what: 'This line reaches for the system keychain directly — the security command’s password find/dump, or the keychain API (SecItemCopyMatching).',
    trigger: 'It acts when the line runs: the keychain is asked for stored passwords or keys.',
    effect: 'The keychain is where the machine keeps its secrets — logins, keys, certificates. Code that queries it unprompted is reaching for the crown jewels, whatever it says it needs them for.',
  },
  'credentials.path': {
    what: 'This code builds a path to a credential store — an SSH key, a browser’s saved-login file, a cloud credential file, a wallet — and a read or copy call acts on it.',
    trigger: 'This finding requires both halves in the evidence: the path being built and an access call using it. A credential path merely named — in a deny list, for instance — is a mention, and this rule stays silent.',
    effect: 'Reading a credential file is taking the keys themselves, not a copy of what they protect. From there, whatever they open is open.',
  },
  'environment.dump': {
    what: 'This code packages the process’s ENTIRE environment — every variable, wholesale — in a shape bound for sending: a post or send in the same breath.',
    trigger: 'When it runs, the whole environment is serialized for outbound delivery.',
    effect: 'The environment is where programs keep their secrets: API keys, tokens, passwords handed over at launch. Dumping all of it sends every secret the program was trusted with, not just the sender’s own.',
  },
  'persistence.act': {
    what: 'This line performs a persistence act: loading a launch agent, adding a cron entry, enabling a login item, or appending itself to a shell startup file.',
    trigger: 'The act itself is the installation. After it, the system restarts the program at login or on schedule without being asked again.',
    effect: 'This is the program arranging to outlive its welcome — to be running tomorrow whether or not anyone chooses it.',
  },
  'persistence.path': {
    what: 'This code names the system’s persistence locations — the LaunchAgents / LaunchDaemons folders or the login-items store: the places programs are registered to start automatically.',
    trigger: 'Naming the place is the precursor to writing there; this rule records the reach even before an install act is proven.',
    effect: 'Those folders are the machine’s list of “run this, always”. Code that builds paths into them is reaching for permanence.',
  },
  'privilege.admin': {
    what: 'This line asks for administrator rights — sudo, an “administrator privileges” prompt — or loosens the rules that hold it back: a setuid call, or a chmod that makes a file runnable with its owner’s power.',
    trigger: 'It acts when the line runs: a password prompt appears, or the permission change lands silently.',
    effect: 'Administrator rights dissolve the boundary between the program and the machine. A program that elevates itself can do anything its user can do — including things the user cannot easily undo.',
  },
  'remote_code.pipe': {
    what: 'This line is the whole attack in one line: download from the network, piped straight into a shell or interpreter — curl | sh and its variants, including fetch-then-eval.',
    hides: 'It hides in the open, usually as an install step.',
    trigger: 'Download and execution are one act: when the line runs, the server’s answer becomes commands.',
    effect: 'Nothing about the payload can be reviewed in advance, and it can change at any time.',
  },
  'hidden_code.decode': {
    what: 'This line decodes hidden data — base64, decompression, marshal or hex decoding — directly into an executor: eval or exec receives the decoded result.',
    trigger: 'Decode and execution are the same line: when it runs, what was encoded becomes running code.',
    effect: 'The encoded form defeats reading: neither the owner nor this scan can see what runs by looking at the file.',
  },
  'hidden_code.taint': {
    what: 'Across this one file — not necessarily on one line — both halves of hidden execution appear: somewhere it decodes data, and somewhere it executes strings as code. The text kept with this finding is the execution half.',
    trigger: 'The halves need not touch: data decoded in one place can flow to the executor in another. The scan found both halves present in the file; it does not trace the flow between them.',
    effect: 'Split across a file, the trick is the same as on one line: text nobody reviewed becomes running code. The file is refused for the combination, not for either half alone.',
  },
  'remote_code.taint': {
    what: 'Across this one file, both halves of download-and-run appear: somewhere it fetches from the network, and somewhere it executes strings as code.',
    trigger: 'The halves need not share a line; fetched text that reaches the executor runs. The scan found both halves in the file; the flow between them is not traced.',
    effect: 'This is remote code execution assembled from ordinary parts — which is why this gate sits at file level, not line level.',
  },
  'hidden_code.dynamic': {
    what: 'This line runs a VALUE as code — eval, exec, or new Function applied to a variable rather than to a fixed string written in the file.',
    trigger: 'Whatever the variable holds when the line runs is what executes.',
    effect: 'A fixed string can at least be read; a variable cannot. This line’s behavior is decided somewhere else — by data, by configuration, by a download — anywhere but in the text under review.',
  },
  'hidden_code.blob': {
    what: 'This line carries a very large encoded blob — 800 or more characters of base64-shaped text in a single string.',
    trigger: 'A blob is inert until something decodes it; nothing in this line alone does that.',
    effect: 'Large encoded blobs are how fonts, icons, and images legitimately travel inside code — and also how payloads hide. Alone, this flag earns the sandbox, not refusal: it marks data whose contents the scan did not decode.',
  },
  'unscanned.skipped': {
    what: 'This file was too large for REA to read, or past the reading budget — so it was NOT scanned, though it would still run as part of the connector.',
    trigger: 'Nothing triggers it; it is REA marking what it could not read.',
    effect: 'Unvetted code never gets free rein: the file is hashed whole, so a later edit is caught, and the connector runs sandboxed until the owner clears what could not be read.',
  },
  'instructions.remote': {
    what: 'These instructions — a skill’s own words, which a model obeys — tell the model to fetch its rules fresh from the web each time: the latest instructions, from a page someone else controls.',
    trigger: 'Every use: the fetch happens as part of using the skill, by design.',
    effect: 'Whoever controls that page controls the model. The instructions the owner reviewed would not be the instructions that run.',
  },
  'instructions.takeover': {
    what: 'These instructions order the model to apply this skill before every reply, or to ignore other instructions and the user’s own choices.',
    trigger: 'Constantly — that is the point of the instruction: it claims every interaction, not just the ones it was invoked for.',
    effect: 'A skill is supposed to be a tool the model picks up. This makes it the model’s standing orders, overriding the user’s other instructions and even their silence.',
  },
  'instructions.concealment': {
    what: 'These instructions tell the model to hide what it does from the owner — not to tell the user that the skill was used, or to keep its actions secret.',
    trigger: 'Whenever the skill is used: concealment is instructed as part of the use itself.',
    effect: 'An assistant that hides its actions from its owner has broken the one rule everything else stands on.',
  },
  'instructions.forgery': {
    what: 'These instructions direct the making of documents that look signed or genuine when they are not — fake signatures, simulated notarization, seals meant to pass as real.',
    trigger: 'When the skill is asked to produce the document.',
    effect: 'A forged signature’s whole value is deceiving someone who trusts it. The deception is the instruction’s purpose.',
  },
  'instructions.home_writes': {
    what: 'These instructions tell the model to save the skill’s own data into hidden folders in the user’s home directory.',
    trigger: 'As the skill works: its state accumulates in dot-folders the user does not see in ordinary browsing.',
    effect: 'Hidden state is state the owner cannot audit or easily remove. The sandbox confines these writes; the finding stands so the hiding place is named.',
  },
});

// --- Little Brother enrichment ---

Object.assign(TEMPLATES, {
  'littlebrother-enrichment': {
    what: 'This is outside context Armor looked up about an address or indicator found in the scan — the detail quotes what the public-source lookup returned, or records that it returned none.',
    trigger: 'Nothing triggers it; it is reference material attached to the record.',
    effect: 'Context, not a verdict: it carries no weight in the score. It exists so a human reading the record sees what the outside world says about something the file contains.',
  },
});

// ---------------------------------------------------------------------------
// The renderer.
// ---------------------------------------------------------------------------

const stage = (v, f) => (typeof v === 'function' ? v(f) : v);

// Shield-generated REA rules are minted as gen.<base rule>.<cycle> by
// shield-generator.mjs; the base rule id may itself contain dots, so
// the cycle suffix (8 word chars) is stripped from the end.
function derivedBase(rule) {
  if (!rule.startsWith('gen.')) return null;
  const rest = rule.slice(4);
  const m = /^(.*)\.[a-z0-9_-]{8}$/i.exec(rest);
  const base = m ? m[1] : rest;
  return TEMPLATES[base] ? base : null;
}

export function explainFinding(rawFinding) {
  const f = normFinding(rawFinding);
  let template = TEMPLATES[f.rule];
  let mode = 'dedicated';
  if (!template) {
    const base = derivedBase(f.rule);
    if (base) {
      template = TEMPLATES[base];
      mode = `derived:${base}`;
    } else {
      template = genericTemplate(f);
      mode = 'generic';
    }
  }
  const what = stage(template.what, f) + (mode.startsWith('derived:')
    ? ` This instance was flagged by a shield rule Armor’s loop generated from that pattern (its own rule id is ${f.rule}), tuned to a recurring obfuscated form of it.`
    : '');
  const where = (template.hides ? template.hides + ' ' : '') + evidenceWhere(f);
  const trigger = template.trigger ? stage(template.trigger, f) : TRIGGER_NOT_SHOWN;
  const effect = stage(template.effect, f) + fixSuffix(f);
  const certainty = CERTAINTY[f.basis] || CERTAINTY_DEFAULT;
  const headline = `${f.rule}${f.severity ? ` (${f.severity})` : ''} — ${what.split(/(?<=[.!?])\s/)[0]}`;
  const text = [
    headline,
    `What it is: ${what}`,
    `Where it hides: ${where}`,
    `What triggers it: ${trigger}`,
    `What it would do: ${effect}`,
    certainty,
  ].join('\n');
  return {
    schema: EXPLANATION_SCHEMA,
    rule: f.rule,
    severity: f.severity,
    template: mode,
    headline,
    what,
    where,
    trigger,
    effect,
    certainty,
    text,
  };
}

// Attach the explanation to a finding object (additive: every existing
// field is carried through untouched).
export function attachExplanation(finding) {
  return { ...finding, explanation: explainFinding(finding) };
}

export function explainFindings(findings) {
  return (findings || []).map((f) => explainFinding(f));
}

// Derive an explained copy of a whole scan record — the read-time path
// for sealed/canonical records, whose digest-bound form carries no
// explanation field by design.
export function explainRecord(record) {
  if (!record || !Array.isArray(record.findings)) return record;
  return { ...record, findings: record.findings.map((f) => attachExplanation(f)) };
}

export { TEMPLATES as EXPLANATION_TEMPLATES };

// ---------------------------------------------------------------------------
// The completeness gate (pure): given the set of emittable rule ids and
// a template map, report what is missing. The inventory derivation
// lives with the callers (tests, build checks) because it sweeps
// sources this module must not import (import-cycle discipline).
// ---------------------------------------------------------------------------

export function checkExplanationCoverage(ids, templates = TEMPLATES, exclusions = EXPLANATION_EXCLUSIONS) {
  const missing = [];
  for (const id of ids) {
    if (templates[id]) continue;
    if (Object.prototype.hasOwnProperty.call(exclusions, id)) continue;
    missing.push(id);
  }
  return { ok: missing.length === 0, missing, excluded: Object.keys(exclusions) };
}

// ---------------------------------------------------------------------------
// The download-moment version (improvement lane, 2026-11-05 03:28): at
// the moment a user takes in a file, the explanation takes delta form —
// what the program SAYS it does versus what the findings show it doing
// beyond that. Warn-and-inform; the user decides. This is a view over
// the same explanations plus the artifact's stated function, not a
// second engine: it introduces no verdict of its own.
// ---------------------------------------------------------------------------

// The artifact's stated function, from what the artifact itself
// carries: a package manifest's name/description where one is among
// the reviewed texts; otherwise nothing — and the rendering says so.
export function statedFunctionOf({ name = null, format = null, texts = [] } = {}) {
  for (const t of texts || []) {
    if (!/(^|\/)package\.json$/i.test(t.name || '')) continue;
    try {
      const pkg = JSON.parse(t.text);
      const parts = [];
      if (pkg.name) parts.push(`“${pkg.name}”`);
      if (pkg.description) parts.push(String(pkg.description));
      if (parts.length) return { source: 'package.json', text: parts.join(' — ') };
    } catch { /* an unparseable manifest states nothing */ }
  }
  return null;
}

export function explainDownload({ artifactName = null, format = null, stated = null, findings = [] } = {}) {
  const all = findings || [];
  const beyond = all.filter((f) => f.severity && f.severity !== 'info');
  const explanations = beyond.map((f) => f.explanation || explainFinding(f));
  const claims = stated
    ? `It declares itself, in its own ${stated.source}, as: ${stated.text}.`
    : `It does not declare a purpose anywhere the review can read — no manifest description, no stated function. All it claims to be is ${artifactName ? `a file named “${artifactName}”` : 'an unnamed file'}${format ? `, of the kind: ${format}` : ''}.`;
  const lines = [
    'Before you run or keep this file — what it says it does, and what the scan found beyond that:',
    claims,
  ];
  if (!explanations.length) {
    lines.push('Beyond that: the scan found nothing in this file beyond the ordinary contents of its kind — no code-execution patterns, no hidden behavior. That is a statement about these checks, not a guarantee of safety.');
  } else {
    lines.push('Beyond that, the scan found:');
    for (const e of explanations) lines.push(`- ${e.headline}\n  What it would do: ${e.effect}`);
    lines.push('Nothing here was run or installed. These are static findings — what the file contains, not proof of what it has done. The choice to keep or discard it is yours.');
  }
  return {
    schema: DOWNLOAD_EXPLANATION_SCHEMA,
    claims,
    stated: stated || null,
    beyondCount: explanations.length,
    explanations,
    text: lines.join('\n'),
  };
}
