// lib/rea-rules.mjs — REA's rules as data (lib/rea.mjs reads them). After QwenPaw's skill_scanner signatures (Apache-2.0,
// agentscope-ai/QwenPaw src/qwenpaw/security/skill_scanner/rules/signatures, read 2026-10-15; the format and the idea of
// anchoring and excluding, re-written here). Each rule:
//   id        stable name; a finding's id is `${id}:${file}:${line}` (what the owner acknowledges, bound to the code's hash)
//   kind      what the owner is told it does (several rules share a kind)
//   fix       how the sandbox takes it away: 'network' | 'files' | 'exec'; null: it can't, so the connector is rejected
//   severity  'reject' (fix null) or 'sandbox'
//   patterns  any one matching the line makes it a candidate
//   requires  the line must also show it being DONE (an access call, a home path being built), else it is only a note
//   access    an access call on the line: a finding even in a deny list or a regex's source (no hiding behind the word)
//   quiet     context that makes a match a mention, not an act: a deny list, a rule's own source (unless `access`)
//   docs      true: in docs/, tests/, examples/ of a program (not a skill) a match is a note; those aren't what it runs
// Comments, docstrings and printed advice are never code (lib/rea.mjs scanText).

/** A deny list, a protection, a block: naming a path in order to keep it out. Read on the line's code, not its comment. */
export const DENY_CONTEXT = /\b(deny|denied|subpath|literal|block(ed|list|s)?|blacklist|forbid(den)?|disallow(ed)?|protect(ed|s)?|sensitive|never|refuse[sd]?|exclude[sd]?)\b|\bDENY_|BLOCKED_|SENSITIVE_|PROTECTED_/i;
/** A rule's own source: a regex literal handed to a pattern field, or a pattern being compiled. */
export const REGEX_SOURCE = /^\s*(re|res|pattern|patterns|exclude|requires|access|quiet|rx)\s*:\s*\[?\s*\/|new RegExp\(|re\.compile\(|=\s*\/[^/\n]{12,}\/[dgimsuy]*\s*[;,]?\s*$/;
/** Reading or copying a file (or the keychain): the act itself. */
export const ACCESS = /\b(readFileSync|readFile|createReadStream|openSync|read_text|read_bytes|copyFileSync|copyFile|copyfile|SecItemCopyMatching)\s*\(|(^|[^\w.])open\s*\(|\bshutil\.copy\w*\s*\(|(^|[\s;|&(`"'$])(cat|cp|scp|rsync|tar|zip|sqlite3|base64)\s|\bsecurity["',\s]+(find|dump)-/;
/** A path in the owner's home being built (so it is about to be used): ~ expanded, $HOME, the home directory API. */
export const HOME_PATH = /expanduser\(|homedir\(\)|Path\.home\(\)|\$HOME\b|\$\{HOME\}|\benv\.HOME\b|os\.environ(\.get)?\s*[[(]\s*['"]HOME|getenv\(\s*['"]HOME|NSHomeDirectory|homeDirectoryForCurrentUser|FileManager\.default\.homeDirectory/;

// The reject gates as file-level taint (lib/rea.mjs scanText): the pieces of a fetch-and-run or a run-hidden-code needn't
// share a line. DECODE turns data into code, FETCH pulls it off the network, DYNEXEC runs a string as code (not a named
// program), DYNEXEC_BARE is the same on a value rather than a literal (exec(p), eval(d), new Function(x)).
export const DECODE = /\b(base64\.(b64decode|urlsafe_b64decode|standard_b64decode)|atob\s*\(|Buffer\.from\s*\([^)]*['"]base64['"]|zlib\.decompress|gzip\.decompress|lzma\.decompress|marshal\.loads|bytes\.fromhex|codecs\.decode|base64\s+(-d|--decode|-D)\b|openssl\s+enc\b)/;
export const FETCH = /\b(requests\.(get|post|request)|urllib\.request|urlopen|httpx\.(get|post|request|stream)|aiohttp|axios)\b|(^|[^.\w])fetch\s*\(|\b(curl|wget)\b/;
export const DYNEXEC = /(^|[^-\w.])eval\s*\(|(^|[^-\w.])exec\s*\(|\bnew Function\s*\(|(^|[;&|`]\s*)eval\s+["'$(]|\biex\b/;
export const DYNEXEC_BARE = /((^|[^-\w.])(eval|exec)|\bnew Function)\s*\(\s*[A-Za-z_$]/;

const CRED_PATHS = /(\.ssh\/(id_|authorized_keys|known_hosts|config\b)|\bid_(rsa|ed25519|ecdsa|dsa)\b|Library\/Keychains|Library\/Cookies|Cookies\.binarycookies|Google\/Chrome\/[^'"\s]*(Login Data|Cookies)|\.aws\/credentials|\.netrc\b|\.gnupg\/|\.solomon-secure|wallet\.dat|\.config\/gh\/hosts\.yml|\.docker\/config\.json|\.kube\/config\b|\.config\/gcloud\/|\.azure\/|\.git-credentials\b|\.npmrc\b|\.pypirc\b|\.vault-token\b|\.(zsh|bash)_history\b|Firefox\/Profiles|\.claude\/\.credentials|\.codex\/auth\.json)/;

export const RULES = [
  { id: 'telemetry.host', kind: 'telemetry', fix: 'network', severity: 'sandbox', why: 'reports usage to an analytics service', docs: true, quiet: [DENY_CONTEXT, REGEX_SOURCE],
    // The services' own hosts (a package merely named posthog in a list is not phoning home).
    patterns: [/\b((us|eu|app)\.i\.posthog\.com|api\.posthog\.com|posthog\.com\/(capture|batch|decide|e)\b|cloud\.umami\.is|umami\.is\/api|api\.segment\.io|api\.mixpanel\.com|api(2)?\.amplitude\.com|google-analytics\.com\/(g\/)?collect|www\.googletagmanager\.com|ingest\.(us\.)?sentry\.io|browser-intake-datadoghq\.com|in\.hotjar\.com|heapanalytics\.com|api\.statsig\.com|hosted\.rudderlabs\.com)/i] },
  { id: 'telemetry.sdk', kind: 'telemetry', fix: 'network', severity: 'sandbox', why: 'reports usage to an analytics service', docs: true, quiet: [REGEX_SOURCE],
    // The SDK itself, imported: it sends wherever it is pointed (OpenJarvis points PostHog's at a raw-IP host).
    patterns: [/^\s*(from\s+(posthog|mixpanel|amplitude|sentry_sdk|segment\.analytics|rudderstack)\b[\w.]*\s+import|import\s+(posthog|mixpanel|amplitude|sentry_sdk)\b)/,
      /(require\(\s*|\bfrom\s+|^\s*import\s+)['"](posthog-node|posthog-js|@sentry\/[\w-]+|mixpanel(-browser)?|@segment\/analytics-[\w-]+|analytics-node|@amplitude\/[\w-]+|amplitude-js|@rudderstack\/[\w-]+)['"]/] },
  { id: 'credentials.keychain', kind: 'credentials', fix: 'files', severity: 'sandbox', why: 'reads stored credentials, keys or browser data', docs: true, quiet: [REGEX_SOURCE],
    patterns: [/\bsecurity["',\s]+(find|dump)-(generic|internet)-password|dump-keychain|SecItemCopyMatching/] },
  { id: 'credentials.path', kind: 'credentials', fix: 'files', severity: 'sandbox', why: 'reads stored credentials, keys or browser data', docs: true,
    quiet: [DENY_CONTEXT, REGEX_SOURCE], requires: [ACCESS, HOME_PATH], access: ACCESS, note: 'mentions_credential_paths',
    patterns: [CRED_PATHS] },
  { id: 'environment.dump', kind: 'environment', fix: 'network', severity: 'sandbox', why: 'collects the whole environment (where keys and tokens live) to send it', docs: true, quiet: [REGEX_SOURCE],
    patterns: [/(JSON\.stringify\(\s*process\.env\s*\)|json\.dumps\(\s*dict\(\s*os\.environ\s*\)|dict\(\s*os\.environ\s*\)\s*[,)]\s*(?:.{0,80})(post|send|requests))/] },
  { id: 'persistence.act', kind: 'persistence', fix: 'files', severity: 'sandbox', why: 'installs itself to run at login or on a schedule', docs: true, quiet: [REGEX_SOURCE],
    patterns: [/(\blaunchctl["',\s]+(load|bootstrap|submit)|\bcrontab\s+-|SMLoginItemSetEnabled|SMAppService|>>\s*~?\/?[^\s'"]*\.(zshrc|bashrc|bash_profile|zprofile|profile)\b)/] },
  { id: 'persistence.path', kind: 'persistence', fix: 'files', severity: 'sandbox', why: 'installs itself to run at login or on a schedule', docs: true, quiet: [DENY_CONTEXT, REGEX_SOURCE],
    patterns: [/(Library\/Launch(Agents|Daemons)|LoginItems)/] },
  { id: 'privilege.admin', kind: 'privilege', fix: 'exec', severity: 'sandbox', why: 'asks for administrator rights', docs: true, runs: true,
    patterns: [/(\bsudo\s+[a-z/]|with administrator privileges|\bchmod\s+[0-7]*[46][0-7]{3}\b|\bchmod\s+[ug]?\+s\b|\bsetuid\s*\()/] },
  { id: 'remote_code.pipe', kind: 'remote_code', fix: null, severity: 'reject', why: 'downloads code and runs it', runs: true,
    patterns: [/((curl|wget)\b[^\n|;]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b|(curl|wget)\b[^\n;]{0,200}\|\s*python3?\b|\birm\b[^\n|]{0,200}\|\s*iex\b|exec\(\s*(requests\.get|urlopen)\(|eval\(\s*(await\s+)?fetch\()/i] },
  { id: 'hidden_code.decode', kind: 'hidden_code', fix: null, severity: 'reject', why: 'runs code it hides (encoded or compressed)',
    patterns: [/(eval\(\s*(atob|Buffer\.from)\(|new Function\(\s*atob\(|exec\(\s*(base64\.b64decode|zlib\.decompress|marshal\.loads|bytes\.fromhex|codecs\.decode)|eval\(\s*(base64\.b64decode|compile\(\s*base64))/] },
];

/**
 * What a skill's own words can do that code rules can't see (REA pointed at itself, 2026-10-15). Read only in a skill's
 * instructions (its .md files). A skill is text a model obeys, so these are about what it tells the model to do.
 */
export const INSTRUCTION_RULES = [
  { id: 'instructions.remote', kind: 'remote_instructions', fix: null, severity: 'reject', why: 'tells the model to fetch its instructions from the web each time (whoever controls that page controls the model)',
    patterns: [/\b(fetch|download|load|pull|retrieve|webfetch)\b[^\n]{0,40}\b(latest|fresh|current|up-to-date|newest)\b[^\n]{0,20}\b(rules|instructions|guidelines|prompts?)\b/i] },
  { id: 'instructions.takeover', kind: 'takeover', fix: null, severity: 'reject', why: 'tells the model to use it before every reply, taking over everything else it does',
    patterns: [/\b(before|prior to)\s+(any|every|each)\s+(response|reply|answer|message)\b|\b(even if|even when) (the user|they|you) (didn't|did not|don't|do not) ask\b|(?<!["'“‘])\bignore (all |any )?(previous|other|prior) (instructions|skills)\b/i] },
  { id: 'instructions.concealment', kind: 'concealment', fix: null, severity: 'reject', why: 'tells the model to hide what it does from the owner',
    // After QwenPaw's prompt_injection.yaml CONCEALMENT signatures (re-written).
    patterns: [/\b(do not|don't|never)\s+(tell|inform|mention (it )?to|reveal (it )?to|disclose (it )?to)\s+(the\s+)?(user|owner)(?!['’]s)\b[^\n]{0,30}\b(that you|you used|you are using|what you did|about (this|the) skill)\b|\bkeep\s+(this|it|that)\s+(a\s+)?secret\s+from\s+(the\s+)?(user|owner)\b|\bwithout\s+(the\s+)?(user|owner)('s)?\s+(knowing|knowledge|noticing)\b/i] },
  { id: 'instructions.forgery', kind: 'forgery', fix: null, severity: 'reject', why: 'makes documents look signed or genuine when they are not',
    patterns: [/\b(fake|forge[ds]?|forging|simulate[ds]?|imitate[ds]?|counterfeit)\b[^\n]{0,40}\b(signature|signed|notar|stamp|seal)|\b(signature|signed)\b[^\n]{0,40}\b(look|appear)s?\b[^\n]{0,30}\b(real|genuine|hand-?signed|physical(ly)?|authentic)/i] },
  { id: 'instructions.home_writes', kind: 'home_writes', fix: 'files', severity: 'sandbox', why: 'saves its own data in hidden folders in the home folder',
    patterns: [/\b(write|save|store|create|append|persist|mkdir)\b[^\n]{0,60}(~|\$HOME|\/Users\/[^/\s]+)\/\.(?!agents\/|claude\/)[a-z]/i] },
];
export const INSTRUCTION_NOTES = [
  { kind: 'affiliate_link', re: /https?:\/\/[^\s)]+[?&](ref|aff|affiliate|via|partner|fpr|irclickid)=[\w-]+/i },
];

/** Things a connector may do because it was asked to, which are worth knowing (never a reason to sandbox). */
export const NOTES = [
  { kind: 'network', re: /\b(requests\.(get|post|put)|urllib\.request|http\.client|httpx\.|aiohttp|fetch\(|axios\.|net\.request|URLSession)\b/ },
  { kind: 'runs_programs', re: /\b(subprocess\.(run|Popen|call|check_output)|child_process|execFile|spawn\(|os\.system\(|Process\(\))\b/ },
  { kind: 'installs_packages', re: /\b(pip3?\s+install|npm\s+(i|install)\s|brew\s+install|uv\s+tool\s+install)\b/ },
];

/** A program's documentation, tests and examples: in them a sandbox-fixable match is a mention, not what it runs. */
// Folders by name, and test files by the language's convention (Rust's foo_tests.rs, Python's test_foo.py, JS's .test.mjs).
export const DOC_PATH = /(^|\/)(docs?|documentation|examples?|samples?|tests?|__tests__|spec|fixtures?|testdata)\/|(_tests?|\.test|\.spec|_spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;
