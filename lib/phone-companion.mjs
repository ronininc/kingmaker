// lib/phone-companion.mjs — Kingmaker on the owner's iPhone, served by the Mac over the home Wi-Fi (v1).
// The Mac is the host and does the thinking; the phone is the display, and its camera, microphone and location work
// for Kingmaker in the field (the owner, 2026-10-15: "this is how we achieve crm real time location data and content
// submission in the field").
//
// The engine runs it (lib/cli.mjs, the control line `companion start|stop|status`, which the bar passes on from
// kingmaker://companion?op=start|stop) and starts it again at launch when it was on last time. The Ronin launcher
// shows the pairing QR, the code and the paired phones through the loopback-only /admin routes
// (~/Projects/ronin-launcher/docs/kingmaker-bridge.md). scripts/phone-companion.mjs runs it by hand.
//
// Secure by necessity: iPhone gives a web app the camera, microphone and location only over HTTPS it trusts. So the
// Mac keeps its own certificate authority, "Ronin Local CA" (made once, in the data folder), and the phone trusts it
// once (a profile, then one switch). Port N-1 is a small HTTP page that walks through that and checks it; port N is
// the app, HTTPS only.
//
// How it reaches Kingmaker: inside the engine, a turn from the phone is a typed turn in that process (onTurn), so every
// gate applies; run by hand, it goes into the bar as kingmaker://bar?text=…&key=<the bar link key> (handed to macOS on
// stdin, never in an argv). What the bar shows is read back from its own log (logs/bar.log). The bar link key never
// leaves the Mac and is never on a command line: the phone gets a session cookie after a one-time
// pairing (the QR's link, or a six-digit code) that only the Mac shows. Field photos, videos and voice notes land in
// Field in Kingmaker's hidden folder (lib/kingmaker-home.mjs; the bar's Artifacts tab); locations go to field-locations.jsonl in the data folder.
// The latest photo rides the phone's next turn, typed or spoken, and lib/field-photo.mjs gives it to the tool that can
// use it (the vision lane, a copy in Kingmaker's files, a CRM job, the image lane, the governed brain with its path).
import { execFile, execFileSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, openSync, readSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeFolder } from './kingmaker-home.mjs';
import { bridgeMetrics } from './bridge-metrics.mjs';
import { historyQuery, readHistory } from './metrics-history.mjs';
import { listDatasets } from './datasets.mjs';
import { createPhoneVoice, MAX_UTTERANCE_BYTES } from './phone-voice.mjs';
import { createRinger } from './phone-ring.mjs';
import { photoFresh, uploadType, visionCopy } from './field-photo.mjs';
import { sendPush, vapidKeys } from './web-push.mjs';

export const COMPANION_PORT = 3091;
export const PAIR_CODE_TTL_MS = 10 * 60_000;   // the six-digit code is good for ten minutes
export const PAIR_LOCK_AFTER = 5;               // this many wrong tries…
export const PAIR_LOCK_MS = 15 * 60_000;        // …and pairing is locked for fifteen minutes
const MAX_UPLOAD = 1024 * 1024 * 1024;   // 1 GB: a long field video
const DEFAULT_ICON = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'ronin-inc-crest.png');

export const companionStateDir = (env = process.env) => String(env.SOL_GHOST_HOME ?? '').trim() || join(homedir(), 'Library/Application Support/sol-ghost');
const files = (state) => ({
  barLog: join(state, 'logs/bar.log'), keyFile: join(state, 'bar-link.key'), tlsDir: join(state, 'phone-tls'),
  devFile: join(state, 'phone-companion.json'), locFile: join(state, 'field-locations.jsonl'), onFile: join(state, 'phone-companion-on.json'),
});

export const lanIp = () => Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
const bonjour = () => { try { return `${execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`; } catch { return `${hostname().replace(/\.local$/, '')}.local`; } };

// ── TAILSCALE (Kingmaker Phone away from home): a core capability, on the same terms as the rest — present by default,
//    governed, off with SOL_GHOST_TAILSCALE=0. When Tailscale's backend is Running, the Mac has a stable MagicDNS name
//    and a 100.x address that work over cellular, so the phone reaches it off the home Wi-Fi. We read it (never start or
//    change it) and use the name as the companion's address. The iPhone side is the App Store Tailscale app.
export const TAILSCALE_CLIS = Object.freeze(['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']);
/** The Mac's Tailscale identity when the backend is Running: { name, ip } (MagicDNS name, trailing dot stripped, plus its
 *  100.x IPv4), else null. Null when SOL_GHOST_TAILSCALE=0, when no CLI is installed, or when the backend isn't up. Pure
 *  but for the injected `exists`/`run`; never throws. */
export function tailscalePeer({ env = process.env, clis = TAILSCALE_CLIS, exists = existsSync, run = (cli) => execFileSync(cli, ['status', '--json'], { encoding: 'utf8', timeout: 4000 }) } = {}) {
  if (String(env.SOL_GHOST_TAILSCALE ?? '').trim() === '0') return null;
  for (const cli of clis) {
    if (!exists(cli)) continue;
    let out; try { out = run(cli); } catch { continue; }   // a wedged CLI: try the next path
    const r = peerFromStatus(out);
    if (r !== undefined) return r;
  }
  return null;
}
/** The same, without blocking: the running companion re-reads it on an interval (a wedged CLI must not stall the
 *  event loop for its 4 s timeout). → Promise of { name, ip } or null; never rejects. */
export async function tailscalePeerAsync({ env = process.env, clis = TAILSCALE_CLIS, exists = existsSync,
  run = (cli) => new Promise((resolve, reject) => execFile(cli, ['status', '--json'], { encoding: 'utf8', timeout: 4000 }, (e, out) => (e ? reject(e) : resolve(out)))) } = {}) {
  if (String(env.SOL_GHOST_TAILSCALE ?? '').trim() === '0') return null;
  for (const cli of clis) {
    if (!exists(cli)) continue;
    let out; try { out = await run(cli); } catch { continue; }
    const r = peerFromStatus(out);
    if (r !== undefined) return r;
  }
  return null;
}
/** Pure: `tailscale status --json` → { name, ip }, null (the backend isn't up: it is global, so no other CLI is
 *  tried), or undefined (unreadable output: try the next CLI path). */
function peerFromStatus(text) {
  let j; try { j = JSON.parse(text); } catch { return undefined; }
  if (!j || j.BackendState !== 'Running' || !j.Self) return null;
  const name = String(j.Self.DNSName || '').replace(/\.$/, '');
  const ips = Array.isArray(j.Self.TailscaleIPs) ? j.Self.TailscaleIPs : [];
  const ip = ips.find((a) => /^100\.\d+\.\d+\.\d+$/.test(a)) || null;
  return name && ip ? { name, ip } : null;
}
/** How often a running companion re-reads Tailscale, so signing in (or out) after Kingmaker started needs no restart. */
export const TAILSCALE_RECHECK_MS = 60_000;
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const cookieOf = (req) => (/(?:^|;\s*)km=([a-f0-9]{48})/.exec(req.headers.cookie || '') || [])[1];
const hash = (c) => createHash('sha256').update(String(c)).digest('hex');
/** The Mac itself: only a loopback peer reaches /admin (the launcher on this Mac). */
export const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);

// ── THE PAIRED PHONES: in the data folder (0600), only a hash of each phone's cookie. Unpairing (on the phone, or on the
//    Mac) removes it, and that phone is cut off at once, mid-stream too.
export function deviceStore(state = companionStateDir()) {
  const { devFile } = files(state);
  let devices = [], devStamp = -1;
  const load = () => {
    const st = existsSync(devFile) ? statSync(devFile).mtimeMs : 0;
    if (st === devStamp) return devices;
    devStamp = st;
    try { devices = JSON.parse(readFileSync(devFile, 'utf8')).devices || []; } catch { devices = []; }
    return devices;
  };
  const save = (list) => {
    devices = list; mkdirSync(state, { recursive: true }); const tmp = `${devFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: 1, devices: list }, null, 1), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, devFile);
    devStamp = statSync(devFile).mtimeMs;
  };
  /** What the Mac may show: never the cookie hashes. */
  const shown = () => load().map(({ id, name, ip, pairedAt, lastSeen }) => ({ id, name, ip, pairedAt, lastSeen: lastSeen || null }));
  /** One phone by id, or `all`. → how many were unpaired. */
  const unpair = (which) => { const list = load(), keep = which === 'all' ? [] : list.filter((d) => d.id !== which); if (keep.length !== list.length) save(keep); return list.length - keep.length; };
  return { load, save, shown, unpair };
}

// ── ON OR OFF, remembered in the data folder: the engine starts the companion again at launch when it was on.
export function companionWanted(state = companionStateDir()) { try { return JSON.parse(readFileSync(files(state).onFile, 'utf8')).on === true; } catch { return false; } }
export function setCompanionWanted(state, on) {
  mkdirSync(state, { recursive: true });
  writeFileSync(files(state).onFile, JSON.stringify({ on: Boolean(on), at: new Date().toISOString() }), { mode: 0o600 });
}
/** The engine's control line `companion start|stop|status` → the op, or null. */
export function companionControl(line) { const m = /^companion\s+(start|stop|status)\s*$/.exec(String(line).trim()); return m ? m[1] : null; }

// ── RONIN LOCAL CA: made once; the server certificate is remade when the Mac's address or name changes (iPhone wants a
//    server certificate under 825 days, with the names it's reached by and serverAuth).
/** The CA's lifetime in days (was ten years). A phone that trusts it should not trust it for a decade. */
export const CA_DAYS = 730;
const SERVER_DAYS = 700;
/**
 * Pure: the CA's openssl config, with CRITICAL X.509 nameConstraints, so even if ca.key leaks it can sign nothing but this
 * Mac's own names: .local and localhost, this host's name, loopback, the private LAN ranges (the Mac's address changes with
 * DHCP, so a single /32 would break the next day) and Tailscale (.ts.net names, the 100.64.0.0/10 range) for the remote
 * option. No public website name can be certified. NEW CAs only: an existing CA is left as it is (see ensureTls).
 */
export function caConfig(host = '') {
  const h = String(host).toLowerCase().replace(/[^a-z0-9.-]/g, '');
  const dns = ['.local', 'localhost', '.ts.net', ...(h && !h.endsWith('.local') ? [h] : [])];
  const ips = ['127.0.0.1/255.255.255.255', '10.0.0.0/255.0.0.0', '172.16.0.0/255.240.0.0', '192.168.0.0/255.255.0.0', '100.64.0.0/255.192.0.0', '169.254.0.0/255.255.0.0'];
  const permitted = [...dns.map((d) => `permitted;DNS:${d}`), ...ips.map((i) => `permitted;IP:${i}`)].join(',');
  return `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=Ronin Local CA\nO=Ronin Inc\n[v3]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nnameConstraints=critical,${permitted}\n`;
}
export function ensureTls(tlsDir, host, extraNames = []) {
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 }); chmodSync(tlsDir, 0o700);
  const p = (f) => join(tlsDir, f), ssl = (args, input) => execFileSync('/usr/bin/openssl', args, { stdio: ['pipe', 'pipe', 'pipe'], input });
  const valid = (f, secs = 0) => { try { ssl(['x509', '-in', p(f), '-noout', '-checkend', String(secs)]); return true; } catch { return false; } };
  // A CA is made once. An EXISTING CA is never replaced just to add constraints (every paired phone trusts that exact one),
  // so only a missing or expired CA is remade, and only the remade one carries nameConstraints and the shorter life.
  if (!existsSync(p('ca.key')) || !existsSync(p('ca.pem')) || !valid('ca.pem')) {
    ssl(['genrsa', '-out', p('ca.key'), '3072']); chmodSync(p('ca.key'), 0o600);
    writeFileSync(p('ca.cnf'), caConfig(host));
    ssl(['req', '-x509', '-new', '-key', p('ca.key'), '-sha256', '-days', String(CA_DAYS), '-config', p('ca.cnf'), '-out', p('ca.pem')]);
    chmodSync(p('ca.key'), 0o600); chmodSync(p('ca.pem'), 0o644);
    for (const old of ['server.pem', 'server.meta']) { try { unlinkSync(p(old)); } catch { /* none */ } }   // signed by the old CA
  }
  // The cert covers every address the phone may reach the Mac by — its primary host, the LAN name/IP, and (when on) the
  // Tailscale name + 100.x, so one cert validates both at home and away. Re-issued below whenever this set changes.
  const names = [`DNS:${host}`, 'DNS:localhost', `IP:${lanIp()}`, 'IP:127.0.0.1', ...extraNames].filter((v, i, a) => v && a.indexOf(v) === i).join(',');
  const meta = existsSync(p('server.meta')) ? readFileSync(p('server.meta'), 'utf8') : '';
  if (meta !== names || !existsSync(p('server.pem')) || !valid('server.pem', 30 * 86400)) {
    ssl(['genrsa', '-out', p('server.key'), '2048']); chmodSync(p('server.key'), 0o600);
    writeFileSync(p('server.cnf'), `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${host}\nO=Ronin Inc\n[v3]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names}\n`);
    ssl(['req', '-new', '-key', p('server.key'), '-config', p('server.cnf'), '-out', p('server.csr')]);
    ssl(['x509', '-req', '-in', p('server.csr'), '-CA', p('ca.pem'), '-CAkey', p('ca.key'), '-CAcreateserial', '-days', String(SERVER_DAYS), '-sha256', '-extfile', p('server.cnf'), '-extensions', 'v3', '-out', p('server.pem')]);
    writeFileSync(p('server.meta'), names);
  }
  const caDer = ssl(['x509', '-in', p('ca.pem'), '-outform', 'DER']);
  return { key: readFileSync(p('server.key')), cert: readFileSync(p('server.pem')), caDer };
}
/** The CA as an iPhone configuration profile (Settings → Profile Downloaded → Install). */
function caProfile(caDer) {
  const uuid = () => randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadCertificateFileName</key><string>Ronin Local CA.cer</string>
<key>PayloadContent</key><data>${caDer.toString('base64')}</data>
<key>PayloadDescription</key><string>Lets this iPhone open Kingmaker from your Mac securely.</string>
<key>PayloadDisplayName</key><string>Ronin Local CA</string>
<key>PayloadIdentifier</key><string>org.ronininc.kingmaker.ca.cert</string>
<key>PayloadType</key><string>com.apple.security.root</string>
<key>PayloadUUID</key><string>${uuid()}</string><key>PayloadVersion</key><integer>1</integer>
</dict></array>
<key>PayloadDescription</key><string>Kingmaker on your Mac: a private certificate so your iPhone can use it securely, camera and location included.</string>
<key>PayloadDisplayName</key><string>Kingmaker (Ronin Inc)</string>
<key>PayloadIdentifier</key><string>org.ronininc.kingmaker.ca</string>
<key>PayloadOrganization</key><string>Ronin Inc</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>${uuid()}</string><key>PayloadVersion</key><integer>1</integer>
</dict></plist>`;
}

// ── THE BAR'S LOG, read by bytes (it has —, … and ’).
function logFrom(barLog, offset) {
  if (!existsSync(barLog)) return { lines: [], end: 0 };
  const size = statSync(barLog).size;
  if (offset > size) offset = 0;
  if (size === offset) return { lines: [], end: size };
  const fd = openSync(barLog, 'r'); const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset); closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(Boolean).map((l) => {
    const m = /^(\S+) ([^:]+): (.*)$/.exec(l);
    return m ? { at: m[1], who: m[2], text: m[3] } : null;
  }).filter((x) => x && (x.who !== 'note' || /Kingmaker is (on|off)|worked on|Saved|moved to the Trash/.test(x.text)));
  return { lines, end: size };
}
function history(barLog, n = 40) {
  if (!existsSync(barLog)) return { lines: [], end: 0 };
  const size = statSync(barLog).size, { lines } = logFrom(barLog, Math.max(0, size - 64 * 1024));
  return { lines: lines.slice(-n), end: size };
}

// ── THE FIELD: where the phone's photos, videos, voice notes and locations go.
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
const cleanName = (s) => String(s || 'file').replace(/[^\w.\- ]+/g, '').replace(/^\.+/, '').slice(0, 80) || 'file';
function saveLocation(state, dev, body) {
  const p = JSON.parse(body);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const rec = { at: new Date().toISOString(), device: dev.id, name: dev.name, lat: n(p.lat), lon: n(p.lon), accuracy: n(p.acc), speed: n(p.speed), heading: n(p.heading) };
  if (rec.lat == null || rec.lon == null || Math.abs(rec.lat) > 90 || Math.abs(rec.lon) > 180) throw new Error('bad position');
  mkdirSync(state, { recursive: true }); appendFileSync(files(state).locFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
  return rec;
}
/** The latest position per phone: [{ device, at, lat, lon, accuracy, … }]. */
export function latestLocations(state = companionStateDir()) {
  const { locFile } = files(state);
  if (!existsSync(locFile)) return [];
  const last = new Map();
  for (const l of readFileSync(locFile, 'utf8').split('\n').filter(Boolean).slice(-2000)) { try { const r = JSON.parse(l); last.set(r.device, r); } catch { /* skip */ } }
  return [...last.values()];
}


// ── THE COMPANION: both servers, started and stopped by the engine (or by scripts/phone-companion.mjs).
const send = (res, code, type, body, headers = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(body); };
const readBytes = (req, max, done) => { const parts = []; let n = 0; req.on('data', (d) => { n += d.length; if (n > max) { req.destroy(); return; } parts.push(d); }); req.on('end', () => done(Buffer.concat(parts))); };
const readBody = (req, max, done) => { let body = ''; req.on('data', (d) => { body += d; if (body.length > max) req.destroy(); }); req.on('end', () => done(body)); };
const listen = (server, port, addr) => new Promise((resolve, reject) => {
  const fail = (e) => reject(e);
  server.once('error', fail);
  server.listen(port, addr, () => { server.off('error', fail); resolve(server.address().port); });
});
const closeServer = (server) => new Promise((resolve) => { if (!server?.listening) return resolve(); server.close(() => resolve()); server.closeAllConnections?.(); });

/**
 * The iPhone companion. `port` is the HTTPS app (and /admin), `setupPort` the HTTP setup page (port - 1 by default; 0
 * picks a free one, for tests). `log(event, detail)` never gets a pairing token, code or cookie.
 */
export function createCompanion({ state = companionStateDir(), port = COMPANION_PORT, setupPort = port ? port - 1 : 0, bind = '0.0.0.0',
  host = null, icon = process.env.KINGMAKER_PHONE_ICON || DEFAULT_ICON, log = () => {}, onTurn = null, metrics = null, openUrl = null, osascript = '/usr/bin/osascript', voice = null, tailscale = tailscalePeer, tailscaleLive = null, tailscaleEvery = TAILSCALE_RECHECK_MS, toVision = visionCopy, maxUpload = MAX_UPLOAD, now = Date.now } = {}) {
  // The running re-check reads Tailscale without blocking; a caller that injects `tailscale` (tests) gets it for both.
  const liveTailscale = tailscaleLive || (tailscale === tailscalePeer ? () => tailscalePeerAsync() : async () => tailscale());
  let phoneVoice = voice;   // lib/phone-voice.mjs: made on the first call, so a companion that's never called loads nothing
  const f = files(state), store = deviceStore(state), FIELD_DIR = homeFolder('field', { env: { ...process.env, SOL_GHOST_HOME: state }, make: false });
  // THE PHONE TURN BRIDGE (to the governed brain, via onTurn): each paired phone is one conversation thread, so a
  // follow-up ("send that to him") resumes the last turn; the id is the device's, stable until it unpairs. The latest
  // field photo waits here per device and rides the next turn as its `image`, then is cleared (one turn sees one photo);
  // after PHOTO_TTL_MS it no longer rides (lib/field-photo.mjs decides which tool takes it).
  const convOf = (id) => `phone-${id}`;
  const latestPhoto = new Map();   // device id → { path, mimeType, filename, receivedAt }
  const inFlight = new Set();      // upload names being written (two at once never share one)
  // Uploads live in a tenant subdir of the Field dir: the engine's runtime confines a turn's image.path to
  // <SOLOMON_FIELD_UPLOAD_DIR>/<tenantId> (realpath-checked, so one tenant can't read another's by guessing a name).
  // The phone turn is sent under tenantId 'primary' (lib/client.mjs turn()), so that's the owner's subdir here.
  const UPLOAD_TENANT = 'primary';
  // Without the engine (scripts/phone-companion.mjs), a turn goes to the bar as kingmaker://bar…&key=. The URL carries the
  // bar key, so it is handed to macOS on osascript's stdin, never in an argv another process could read; it opens
  // without activating Kingmaker (like `open -g`).
  const open = openUrl || ((url, done) => {
    const child = execFile(osascript, ['-l', 'JavaScript', '-'], (err) => done(err));
    child.stdin.end(`ObjC.import('AppKit');const c=$.NSWorkspaceOpenConfiguration.configuration;c.activates=false;$.NSWorkspace.sharedWorkspace.openURLConfigurationCompletionHandler($.NSURL.URLWithString(${JSON.stringify(url)}),c,function(){});delay(1)`);
  });
  let HOST = host, appPort = port, setPort = setupPort, tls = null, resumeKey = null, appServer = null, setupServer = null, running = false, starting = null;
  let tsPeer = null;   // the Mac's Tailscale identity while running (start(), then re-read); null = home-only (no cellular reach)
  let lanName = '', tsTimer = null, rechecking = null;
  // Every address the phone may reach the Mac by, beside HOST: the Tailscale name + 100.x while it is up, and the LAN name.
  const extraNames = () => [...(tsPeer ? [`DNS:${tsPeer.name}`, `IP:${tsPeer.ip}`] : []), ...(lanName && lanName !== HOST ? [`DNS:${lanName}`] : [])];

  // The bar link key (the bar's own secret for kingmaker://bar …&key=): made here the way the bar makes it when it's missing.
  const barKey = () => {
    if (!existsSync(f.keyFile)) { mkdirSync(state, { recursive: true }); writeFileSync(f.keyFile, randomBytes(24).toString('hex'), { mode: 0o600 }); }
    return readFileSync(f.keyFile, 'utf8').trim();
  };
  const hashesOf = (d) => d.hashes || (d.hash ? [d.hash] : []);
  const deviceOf = (req) => { const c = cookieOf(req); if (!c) return null; const h = hash(c); return store.load().find((d) => hashesOf(d).includes(h)) || null; };
  // A Home Screen web app on iPhone doesn't share Safari's cookies. So each paired phone has a resume link (keyed by a
  // secret on the Mac, never stored): the app page sits at it, Add to Home Screen keeps it, and the Home Screen copy
  // pairs itself from it. Unpairing the phone ends it too.
  const resumeOf = (d) => createHmac('sha256', resumeKey).update(`${d.id}|${d.pairedAt}`).digest('hex').slice(0, 40);
  function resumePhone(token) {
    const d = store.load().find((x) => safeEq(resumeOf(x), token)); if (!d) return null;
    const c = randomBytes(24).toString('hex');
    store.save(store.load().map((x) => (x.id === d.id ? { ...x, hash: undefined, hashes: [...hashesOf(x), hash(c)].slice(-4) } : x)));
    log('resumed', { id: d.id });
    return `km=${c}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
  }
  function deviceName(ua = '') {
    const kind = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : /Macintosh/.test(ua) ? 'Mac' : 'Browser';
    const os = (/OS (\d+)_(\d+)/.exec(ua) || []).slice(1).join('.');
    return os ? `${kind} (iOS ${os})` : kind;
  }

  // ── RINGING THE PHONE (lib/phone-ring.mjs): the open apps hear it on their event streams, a closed one through Web
  //    Push to the subscription the owner allowed in the app ("Allow calls"). Only paired phones; unpairing drops both.
  const streams = new Set();
  const broadcast = (event, data) => { for (const s of streams) { if (!deviceOf(s.req)) continue; s.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } };
  const subscribed = () => store.load().filter((d) => d.push?.endpoint);
  const pushAll = async (payload) => {
    let n = 0; const vapid = vapidKeys(f.tlsDir);
    for (const d of subscribed()) {
      const r = await sendPush(d.push, payload, vapid).catch(() => ({ ok: false }));
      if (r.ok) n++;
      if (r.gone) store.save(store.load().map((x) => (x.id === d.id ? { ...x, push: undefined } : x)));
    }
    return n;
  };
  const ringer = createRinger({ broadcast, push: pushAll, reachable: () => running && (streams.size > 0 || subscribed().length > 0), log: (e, d) => log(e, d) });

  // ── PAIRING: one link (in the QR) and one six-digit code, shown only on the Mac, used once. The code expires after ten
  //    minutes (a fresh one is made on demand), and five wrong tries lock pairing for fifteen minutes, so nobody else on
  //    the Wi-Fi can guess it. A phone that is already paired keeps its access: it carries its own cookie and none of this
  //    touches it. Every attempt is logged (who, how, whether it worked); the code and the token never are.
  let pairToken = '', pairCode = '', pairMisses = 0, codeIssuedAt = 0, lockedUntil = 0;
  const newCode = () => { pairCode = String(randomInt(0, 1_000_000)).padStart(6, '0'); codeIssuedAt = now(); };
  const rotate = () => { pairToken = randomBytes(16).toString('hex'); newCode(); pairMisses = 0; };
  rotate();
  const pairLocked = () => now() < lockedUntil;
  const codeExpired = () => now() - codeIssuedAt > PAIR_CODE_TTL_MS;
  const pairMiss = (via, req, why) => {
    pairMisses += 1;
    log('pair_attempt', { via, ok: false, why, ip: req.socket.remoteAddress, misses: pairMisses });
    if (pairMisses >= PAIR_LOCK_AFTER) { lockedUntil = now() + PAIR_LOCK_MS; rotate(); log('pairing_locked', { minutes: PAIR_LOCK_MS / 60_000, ip: req.socket.remoteAddress }); }
  };
  const appUrl = () => `https://${HOST}:${appPort}`;
  const setupUrl = () => `http://${HOST}:${setPort}/setup`;
  // The token rides in the fragment: a browser never sends it, so it never crosses the Wi-Fi in the clear. The setup page
  // reads it on the phone and hands it on only over TLS (https://…/?pair=), after the phone trusts the Ronin CA.
  const link = () => `${setupUrl()}#pair=${pairToken}`;
  function pairPhone(req) {
    const c = randomBytes(24).toString('hex'), now = new Date().toISOString(), id = randomBytes(3).toString('hex');
    store.save([...store.load(), { id, hashes: [hash(c)], name: deviceName(req.headers['user-agent']), ip: req.socket.remoteAddress, pairedAt: now, lastSeen: now }]);
    rotate();
    log('pair_attempt', { via: 'paired', ok: true, id, ip: req.socket.remoteAddress });
    return `km=${c}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
  }
  /**
   * The pairing payload the launcher draws its QR(s) from, fresh unless `fresh` is false:
   *   setupUrl  the setup page + pairing token — QR 1, "install + trust the Ronin CA certificate" (carries #pair so the
   *             setup page's own Open button still works). `link` is the legacy name for the same value, kept for compat.
   *   appLink   the HTTPS app + the SAME token — QR 2, "open the app" (pairs on open; only works once the cert is trusted)
   *   app       the HTTPS app origin (no token); code is the six-digit fallback. Token rotates per pairing (?fresh=0 keeps it).
   */
  const pairLink = ({ fresh = true } = {}) => { if (fresh) rotate(); else if (codeExpired()) newCode(); const setup = link(); return { link: setup, setupUrl: setup, appLink: `${appUrl()}/?pair=${pairToken}`, code: pairCode, app: appUrl() }; };
  // `remote` is present only when Tailscale is up: the off-Wi-Fi app origin (same name the phone pairs/returns to) plus the
  // MagicDNS name and 100.x. The launcher reads it to show "Works on cellular"; its absence means home-only.
  const status = () => ({ running, app: running ? appUrl() : null, setup: running ? setupUrl() : null, host: HOST, ip: lanIp(), devices: store.load().length, remote: running && tsPeer ? { app: `https://${tsPeer.name}:${appPort}`, name: tsPeer.name, ip: tsPeer.ip } : null });

  function app(req, res) {
    const url = new URL(req.url, 'https://x');
    if (url.pathname === '/ping') return send(res, 200, 'application/json', '{"ok":true}', { 'access-control-allow-origin': '*' });
    // The Mac only (loopback), for the Ronin launcher (docs/kingmaker-bridge.md): is it up, the machine card, a fresh pairing link and code,
    // the paired phones, unpairing, the latest locations. Anything else gets 403.
    if (url.pathname.startsWith('/admin/')) {
      if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, 'text/plain', 'the Mac only');
      if (url.pathname === '/admin/status' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify(status()));
      // The launcher's machine card (lib/bridge-metrics.mjs); the engine passes its own queue and token rates.
      if (url.pathname === '/admin/metrics' && req.method === 'GET') return void Promise.resolve().then(() => (metrics || (() => bridgeMetrics({ state })))()).then((m) => send(res, 200, 'application/json', JSON.stringify(m)), () => send(res, 500, 'application/json', '{}'));
      if (url.pathname === '/admin/metrics/history' && req.method === 'GET') {
        const q = historyQuery(url.searchParams);
        if (q.error) return send(res, 400, 'application/json', JSON.stringify({ error: q.error }));
        try { return send(res, 200, 'application/json', JSON.stringify(readHistory(state, q))); } catch { return send(res, 500, 'application/json', '{}'); }
      }
      if (url.pathname === '/admin/datasets' && req.method === 'GET') return void listDatasets({ state }).then((d) => send(res, 200, 'application/json', JSON.stringify(d)), () => send(res, 500, 'application/json', '[]'));
      if (url.pathname === '/admin/devices' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify(store.shown()));
      if (url.pathname === '/admin/locations' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify(latestLocations(state).map(({ device, at, lat, lon, accuracy }) => ({ device, at, lat, lon, accuracy }))));
      if (url.pathname === '/admin/pair-link' && req.method === 'POST') return send(res, 200, 'application/json', JSON.stringify(pairLink({ fresh: url.searchParams.get('fresh') !== '0' })));
      if (url.pathname === '/admin/unpair' && req.method === 'POST') {
        const which = url.searchParams.get('id') || '';
        if (!which) return send(res, 400, 'application/json', '{"unpaired":0}');
        const n = store.unpair(which); if (n) log('unpaired', { which: which === 'all' ? 'all' : which, n });
        return send(res, 200, 'application/json', JSON.stringify({ unpaired: n }));
      }
      return send(res, 404, 'text/plain', '');
    }
    if (url.pathname === '/manifest.webmanifest') { const d = deviceOf(req); return send(res, 200, 'application/manifest+json', MANIFEST(d ? `/?resume=${resumeOf(d)}` : '/')); }
    if (url.pathname === '/' && url.searchParams.has('resume') && !deviceOf(req)) {
      const cookie = resumePhone(url.searchParams.get('resume'));
      return cookie ? send(res, 302, 'text/plain', '', { location: url.pathname + url.search, 'set-cookie': cookie }) : send(res, 200, 'text/html; charset=utf-8', PAIR_PAGE);
    }
    // The SW carries the page's build hash, so /sw.js changes whenever the page does. iOS re-installs it on launch, and
    // its activate tells every open window to reload — busting a home-screen PWA that is holding an old cached page.
    if (url.pathname === '/sw.js') return send(res, 200, 'text/javascript', `/* ${COMPANION_BUILD} */\n${SW}`);
    if (url.pathname === '/icon.png') return icon && existsSync(icon) ? send(res, 200, 'image/png', readFileSync(icon)) : send(res, 404, 'text/plain', '');
    if (url.pathname === '/' && url.searchParams.has('pair')) {
      if (pairLocked()) { log('pair_attempt', { via: 'link', ok: false, why: 'locked', ip: req.socket.remoteAddress }); return send(res, 429, 'text/html; charset=utf-8', PAIR_PAGE, { 'retry-after': String(Math.ceil((lockedUntil - now()) / 1000)) }); }
      if (!safeEq(url.searchParams.get('pair'), pairToken)) { pairMiss('link', req, 'wrong link'); return send(res, 403, 'text/html; charset=utf-8', PAIR_PAGE); }
      return send(res, 302, 'text/plain', '', { location: '/', 'set-cookie': pairPhone(req) });
    }
    if (url.pathname === '/pair-code' && req.method === 'POST') {
      return readBody(req, 200, (body) => {
        if (pairLocked()) { log('pair_attempt', { via: 'code', ok: false, why: 'locked', ip: req.socket.remoteAddress }); return send(res, 429, 'application/json', '{"ok":false,"locked":true}', { 'retry-after': String(Math.ceil((lockedUntil - now()) / 1000)) }); }
        let code = ''; try { code = String(JSON.parse(body).code || '').replace(/\D/g, ''); } catch { /* below */ }
        if (codeExpired()) { log('pair_attempt', { via: 'code', ok: false, why: 'expired', ip: req.socket.remoteAddress }); return send(res, 403, 'application/json', '{"ok":false,"expired":true}'); }
        if (code.length !== 6 || !safeEq(code, pairCode)) { pairMiss('code', req, 'wrong code'); return send(res, 403, 'application/json', '{"ok":false}'); }
        send(res, 200, 'application/json', '{"ok":true}', { 'set-cookie': pairPhone(req) });
      });
    }
    const me = deviceOf(req);
    if (!me) return url.pathname === '/' ? send(res, 200, 'text/html; charset=utf-8', PAIR_PAGE) : send(res, 401, 'text/plain', 'not paired');
    if (Date.now() - Date.parse(me.lastSeen || 0) > 60_000) { me.lastSeen = new Date().toISOString(); store.save(store.load().map((d) => (d.id === me.id ? me : d))); }
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', APP_PAGE.replace('__RESUME__', resumeOf(me)));
    if (url.pathname === '/unpair' && req.method === 'POST') {
      store.save(store.load().filter((d) => d.id !== me.id)); log('unpaired', { which: me.id, n: 1, by: 'phone' });
      return send(res, 200, 'application/json', '{"ok":true}', { 'set-cookie': 'km=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      let { lines, end } = history(f.barLog);
      for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
      const tick = setInterval(() => {
        if (!deviceOf(req)) { res.write('event: unpaired\ndata: {}\n\n'); clearInterval(tick); clearInterval(ping); return res.end(); }
        const r = logFrom(f.barLog, end); end = r.end; for (const l of r.lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
      }, 700);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      const entry = { req, res }; streams.add(entry);
      const ringing = ringer.active(); if (ringing && ringing.state === 'ringing') res.write(`event: ring\ndata: ${JSON.stringify(ringing)}\n\n`);
      req.on('close', () => { clearInterval(tick); clearInterval(ping); streams.delete(entry); });
      return;
    }
    // Web Push: the Mac's VAPID key, and the phone's subscription (the owner allowed calls in the app).
    if (url.pathname === '/push/key' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify({ key: vapidKeys(f.tlsDir).publicKey }));
    if (url.pathname === '/push/subscribe' && req.method === 'POST') {
      return readBody(req, 4000, (body) => {
        let sub = null; try { sub = JSON.parse(body); } catch { /* below */ }
        if (!/^https:\/\//.test(String(sub?.endpoint || '')) || !sub?.keys?.p256dh || !sub?.keys?.auth) return send(res, 400, 'application/json', '{"ok":false}');
        store.save(store.load().map((d) => (d.id === me.id ? { ...d, push: { endpoint: String(sub.endpoint).slice(0, 600), keys: { p256dh: String(sub.keys.p256dh).slice(0, 120), auth: String(sub.keys.auth).slice(0, 40) } } } : d)));
        log('push_subscribed', { id: me.id }); return send(res, 200, 'application/json', '{"ok":true}');
      });
    }
    // The ring, from the phone's side.
    if (url.pathname === '/ring/active' && req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify(ringer.active()));
    const rm = /^\/ring\/(answer|decline|hangup|played|heard)$/.exec(url.pathname);
    if (rm && req.method === 'POST') {
      const id = String(url.searchParams.get('id') || '');
      if (rm[1] === 'heard') return readBytes(req, MAX_UTTERANCE_BYTES, async (buf) => {
        phoneVoice ??= createPhoneVoice();
        let text = ''; try { text = await phoneVoice.hear(buf); } catch { text = ''; } finally { buf.fill(0); }
        return send(res, ringer.heard(id, text) ? 200 : 409, 'application/json', JSON.stringify({ ok: true, heard: text }));
      });
      const ok = rm[1] === 'played' ? ringer.played(id, url.searchParams.get('seq')) : ringer[rm[1]](id);
      return send(res, ok ? 200 : 409, 'application/json', JSON.stringify({ ok }));
    }
    // CALL and WALKIE-TALKIE (lib/phone-voice.mjs): an utterance in (raw 16 kHz PCM), its words as an ordinary turn;
    // Kingmaker's line spoken back. Nothing is written to disk.
    if (url.pathname === '/voice/turn' && req.method === 'POST') {
      return readBytes(req, MAX_UTTERANCE_BYTES, async (buf) => {
        phoneVoice ??= createPhoneVoice();
        let heard = '';
        try { heard = await phoneVoice.hear(buf); } catch (e) { log('voice_failed', { reason: String(e?.message || e).slice(0, 80) }); return send(res, 500, 'application/json', '{"ok":false}'); } finally { buf.fill(0); }
        if (!heard) return send(res, 200, 'application/json', '{"ok":true,"heard":""}');
        log('voice_turn', { id: me.id, chars: heard.length });
        return turnFor(heard, res, { heard });
      });
    }
    if (url.pathname === '/voice/say' && req.method === 'POST') {
      return readBody(req, 8000, async (body) => {
        let text = ''; try { text = String(JSON.parse(body).text || ''); } catch { /* below */ }
        phoneVoice ??= createPhoneVoice();
        const a = text.trim() ? await phoneVoice.speak(text).catch(() => null) : null;
        return a ? send(res, 200, a.type, a.bytes) : send(res, 204, 'text/plain', '');
      });
    }
    if (url.pathname === '/voice/sayfail' && req.method === 'POST') {   // the phone couldn't play an answer aloud: log why, on the Mac
      return readBody(req, 2000, (body) => {
        let reason = ''; try { reason = String(JSON.parse(body).reason || '').slice(0, 80); } catch { /* ignore */ }
        log('voice_say_failed', { reason });
        return send(res, 204, 'text/plain', '');
      });
    }
    if (url.pathname === '/turn' && req.method === 'POST') {
      return readBody(req, 20_000, (body) => {
        let text = ''; try { text = String(JSON.parse(body).text || '').trim().slice(0, 4000); } catch { /* below */ }
        if (!text) return send(res, 400, 'application/json', '{"ok":false}');
        return turnFor(text, res);
      });
    }
    function turnFor(text, res, extra = {}) {
      {
        // Inside the engine: straight into its typed-turn path (the same gates, the same governed brain); the bar shows it
        // and writes bar.log, which /events streams back.
        if (onTurn) { const waiting = latestPhoto.get(me.id) || null; latestPhoto.delete(me.id); const image = photoFresh(waiting) ? waiting : null; return Promise.resolve().then(() => onTurn(text, { conversationId: convOf(me.id), image })).then(() => send(res, 200, 'application/json', JSON.stringify({ ok: true, ...extra })), (e) => { log('turn_refused', { reason: String(e?.message || e).slice(0, 80) }); send(res, 503, 'application/json', '{"ok":false}'); }); }
        // By hand: into the bar exactly like a typed turn.
        open(`kingmaker://bar?text=${encodeURIComponent(text)}&key=${encodeURIComponent(barKey())}`, (err) => send(res, err ? 502 : 200, 'application/json', JSON.stringify({ ok: !err, ...extra })));
      }
    }
    if (url.pathname === '/field/location' && req.method === 'POST') {
      return readBody(req, 2000, (body) => {
        try { const r = saveLocation(state, me, body); send(res, 200, 'application/json', JSON.stringify({ ok: true, at: r.at })); }
        catch { send(res, 400, 'application/json', '{"ok":false}'); }
      });
    }
    if (url.pathname === '/field/upload' && req.method === 'POST') {
      // Two photos in the same second keep both (the iPhone camera calls every one image.jpg).
      const dir = join(FIELD_DIR, UPLOAD_TENANT), base = `${stamp()} ${me.name.split(' ')[0]} ${cleanName(url.searchParams.get('name'))}`;
      let name = base; for (let i = 2; inFlight.has(name) || existsSync(join(dir, name)); i++) name = base.replace(/(\.[^. ]+)?$/, ` ${i}$1`);
      inFlight.add(name); res.once('close', () => inFlight.delete(name));
      const out = join(dir, name), part = `${out}.part`;
      const mimeType = uploadType(req.headers['content-type'], name);
      mkdirSync(dir, { recursive: true });
      // Every way an upload can end answers once and leaves no .part behind: too big (413), cut off (the phone retries),
      // empty (400), or saved (200, and a photo waits for the next turn, readable by the vision lane).
      let size = 0, over = false, settled = false; const w = createWriteStream(part, { mode: 0o644 });
      const drop = () => { try { unlinkSync(part); } catch { /* gone */ } };
      // The .part goes once the stream has closed: it opens asynchronously, so an unlink before that would race its open.
      const fail = (code, error) => { if (settled) return; settled = true; w.once('close', drop); w.destroy(); drop(); if (!res.headersSent) send(res, code, 'application/json', JSON.stringify({ ok: false, error }), { connection: 'close' }); };
      req.on('data', (d) => { size += d.length; if (size > maxUpload && !over) { over = true; req.unpipe(w); log('field_upload_refused', { why: 'too big', id: me.id }); res.once('finish', () => req.destroy()); fail(413, 'too big'); } });
      req.on('close', () => { if (!req.complete && !over && !settled) { log('field_upload_cut', { kb: Math.round(size / 1024), id: me.id }); fail(400, 'cut off'); } });
      req.pipe(w);
      w.on('finish', () => void (async () => {
        if (settled || over) return;
        if (!size) return fail(400, 'empty');
        settled = true;
        renameSync(part, out);
        let attached = false;
        if (/^image\//.test(mimeType)) {
          // HEIC (an iPhone's own format) or a photo over 8 MB: a JPEG beside it for the vision lane, by macOS's sips.
          const v = await toVision(out, mimeType, { size }).catch(() => ({ path: out, mimeType, converted: false }));
          latestPhoto.set(me.id, { path: v.path, mimeType: v.mimeType, filename: name, receivedAt: new Date().toISOString() });
          attached = true;
          if (v.converted) log('field_upload_converted', { from: mimeType, id: me.id });
        }
        log('field_upload', { name, kb: Math.round(size / 1024), type: mimeType, id: me.id, attached });
        send(res, 200, 'application/json', JSON.stringify({ ok: true, saved: name, type: mimeType, attached }));
      })().catch((e) => { log('field_upload_failed', { reason: String(e?.message || e).slice(0, 80), id: me.id }); drop(); if (!res.headersSent) send(res, 500, 'application/json', '{"ok":false,"error":"not saved"}'); }));
      w.on('error', () => fail(500, 'not saved'));
      return;
    }
    send(res, 404, 'text/plain', 'not found');
  }

  // The setup page (HTTP: the phone doesn't trust the Mac yet): the certificate, the trust check, then the app.
  function setup(req, res) {
    const url = new URL(req.url, 'http://x');
    // inline, not attachment: `attachment` makes Safari SAVE the profile to Files; inline + the aspen-config MIME hands it to the iOS profile installer ("Profile Downloaded").
    if (url.pathname === '/ronin-ca.mobileconfig') return send(res, 200, 'application/x-apple-aspen-config', caProfile(tls.caDer), { 'content-disposition': 'inline; filename="Kingmaker-Ronin-CA.mobileconfig"' });
    if (url.pathname === '/icon.png') return icon && existsSync(icon) ? send(res, 200, 'image/png', readFileSync(icon)) : send(res, 404, 'text/plain', '');
    if (url.pathname === '/setup') return send(res, 200, 'text/html; charset=utf-8', SETUP_PAGE(appUrl()));
    return send(res, 302, 'text/plain', '', { location: '/setup' });
  }

  /** Start both servers (a second start while running is a no-op). → status(). Throws when a port is taken. */
  async function start() {
    if (running) return status();
    if (starting) return starting;
    starting = (async () => {
      // When Tailscale is up, its MagicDNS name is the companion's primary address, so one Home-Screen origin works at
      // home and away (cookies are per-origin: a phone paired on the .local name pairs once more on the Tailscale name).
      // The cert still carries the LAN name/IP too, so it validates either way.
      tsPeer = tailscale();
      lanName = bonjour();
      HOST = HOST || (tsPeer ? tsPeer.name : lanName);
      tls = ensureTls(f.tlsDir, HOST, extraNames());
      const rk = join(f.tlsDir, 'resume.key'); if (!existsSync(rk)) writeFileSync(rk, randomBytes(32).toString('hex'), { mode: 0o600 });
      resumeKey = readFileSync(rk, 'utf8').trim();
      if (!onTurn) barKey();   // only the by-hand path sends the bar its key
      appServer = createHttps({ key: tls.key, cert: tls.cert }, app);
      setupServer = createHttp(setup);
      try {
        appPort = await listen(appServer, port, bind);
        setPort = await listen(setupServer, setupPort, bind);
      } catch (e) {
        await closeServer(appServer); await closeServer(setupServer); appServer = setupServer = null;
        log('start_failed', { code: e.code || '', port: e.port ?? null });
        throw e;
      }
      running = true;
      if (tailscaleEvery > 0) { tsTimer = setInterval(() => { recheckTailscale().catch(() => {}); }, tailscaleEvery); tsTimer.unref?.(); }
      log('started', { app: appUrl(), setup: setupUrl() });
      return status();
    })();
    try { return await starting; } finally { starting = null; }
  }
  /**
   * Tailscale came up, went down or changed name while running (the owner signed in after Kingmaker started): re-issue
   * the cert for the new set of names and hand it to the live HTTPS server, so the phone reaches the Mac away from home
   * with no restart. HOST (the paired origin) stays as it was; the cert keeps every name. Nothing happens when nothing
   * changed. → { changed, remote }.
   */
  async function recheckTailscale() {
    if (!running) return { changed: false, remote: null };
    if (rechecking) return rechecking;
    rechecking = (async () => {
      const peer = await liveTailscale().catch(() => null);
      const same = (a, b) => (a?.name ?? null) === (b?.name ?? null) && (a?.ip ?? null) === (b?.ip ?? null);
      if (!running || same(peer, tsPeer)) return { changed: false, remote: tsPeer?.name ?? null };
      tsPeer = peer;
      tls = ensureTls(f.tlsDir, HOST, extraNames());
      appServer?.setSecureContext({ key: tls.key, cert: tls.cert });
      log('tailscale', { remote: tsPeer?.name ?? null });
      return { changed: true, remote: tsPeer?.name ?? null };
    })();
    try { return await rechecking; } finally { rechecking = null; }
  }
  /** Stop both servers; open streams are closed too. */
  async function stop() {
    if (starting) await starting.catch(() => {});
    if (!running) return status();
    running = false;
    if (tsTimer) { clearInterval(tsTimer); tsTimer = null; }
    await Promise.all([closeServer(appServer), closeServer(setupServer)]);
    appServer = setupServer = null;
    log('stopped', {});
    return status();
  }
  return { start, stop, status, pairLink, ringer, recheckTailscale, get running() { return running; } };
}

// ── PAGES
const MANIFEST = (start = '/') => JSON.stringify({ name: 'Kingmaker', short_name: 'Kingmaker', start_url: start, scope: '/', display: 'standalone',
  orientation: 'portrait', background_color: '#000000', theme_color: '#000000',
  icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] });
// The service worker: a ring from the Mac shows as a notification, even with the app closed; tapping it opens the call.
const SW = `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil((async()=>{await self.clients.claim();for(const c of await self.clients.matchAll({type:'window'}))c.postMessage({reload:1})})()));self.addEventListener('fetch',()=>{});
self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch{}if(d.type!=='ring')return;
 e.waitUntil(self.registration.showNotification((d.caller||'Kingmaker')+' is calling',{body:'Kingmaker · tap to answer',tag:'km-ring',requireInteraction:true,icon:'/icon.png',data:{id:d.id}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window'}).then(cs=>{for(const c of cs){c.focus();c.postMessage({ring:true});return}return self.clients.openWindow('/?ring=1')}))});`;
const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Kingmaker"><meta name="theme-color" content="#000000"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon.png"><title>Kingmaker</title>`;
const BRAND = `.mark{font-family:"Bodoni 72",Didot,serif;font-weight:700;letter-spacing:.32em;font-size:17px;padding-left:.32em}.sub{color:#E8BA45;font-size:10px;letter-spacing:.42em;margin-top:5px}`;

const SETUP_PAGE = (appUrl) => `<!doctype html><html><head>${HEAD}<style>html,body{margin:0;background:#000;color:#fff;font:16px -apple-system,sans-serif}
body{padding:calc(env(safe-area-inset-top) + 28px) 22px 40px}${BRAND}.top{text-align:center;margin-bottom:28px}
.step{border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:16px 16px 14px;margin-bottom:14px}.step b{color:#E8BA45;font-size:12px;letter-spacing:.14em}
.step p{margin:8px 0 0;color:rgba(255,255,255,.75);line-height:1.45;font-size:15px}.btn{display:block;text-align:center;margin-top:12px;background:#E8BA45;color:#000;text-decoration:none;font-weight:600;border-radius:12px;padding:12px}
.ok{border-color:#4ADE80}.ok b{color:#4ADE80}#go{display:none}</style></head><body>
<div class="top"><div class="mark">KINGMAKER</div><div class="sub">RONIN INC</div></div>
<div class="step" id="s1"><b>1 · INSTALL THE RONIN CERTIFICATE</b><p>It lets this iPhone talk to your Mac securely, so Kingmaker can use the camera, microphone and location. It stays on your Wi-Fi, between your phone and your Mac.</p>
<a class="btn" href="/ronin-ca.mobileconfig">Install certificate</a><p style="font-size:13px">Tap <b style="color:#fff;letter-spacing:0">Allow</b> — iOS saves it as a profile first, it doesn't install yet. Then open <b style="color:#fff;letter-spacing:0">Settings → General → VPN &amp; Device Management → Ronin Local CA → Install</b>. If it saved to Files instead, open <b style="color:#fff;letter-spacing:0">Files → Downloads</b> and tap the profile to start the install.</p></div>
<div class="step" id="s2"><b>2 · TRUST IT</b><p>Settings → General → About → <b style="color:#fff;letter-spacing:0">Certificate Trust Settings</b> → turn on <b style="color:#fff;letter-spacing:0">Ronin Local CA</b>.</p><p id="chk" style="font-size:13px">Checking…</p></div>
<div class="step" id="go"><b>3 · OPEN KINGMAKER</b><p id="how">Then tap Share → Add to Home Screen, and open Kingmaker from there: full screen, no browser.</p><a class="btn" id="open" href="#">Open Kingmaker</a></div>
<script>const app=${JSON.stringify(appUrl)};
// The pairing token is in this page's #fragment (never sent over the Wi-Fi). Kept for this tab only, out of the address bar.
let pair='';try{const h=/^#pair=([a-f0-9]{32})$/.exec(location.hash);if(h){pair=h[1];sessionStorage.km_pair=pair;history.replaceState(null,'',location.pathname)}else pair=/^[a-f0-9]{32}$/.test(sessionStorage.km_pair||'')?sessionStorage.km_pair:''}catch{}
document.getElementById('open').href=app+(pair?'/?pair='+pair:'/');
if(!pair)document.getElementById('how').textContent='Open Kingmaker, then type the six-digit pairing code shown on your Mac. After that, tap Share → Add to Home Screen.';
async function check(){try{const r=await fetch(app+'/ping',{cache:'no-store'});if(r.ok){document.getElementById('s2').classList.add('ok');document.getElementById('s1').classList.add('ok');document.getElementById('chk').textContent='Trusted ✓';document.getElementById('go').style.display='block';return}}catch{}
document.getElementById('chk').textContent='Not trusted yet: do steps 1 and 2, then come back here.';setTimeout(check,2500)}check()</script></body></html>`;

const PAIR_PAGE = `<!doctype html><html><head>${HEAD}<style>html,body{margin:0;height:100%;background:#000;color:#fff;font:16px -apple-system,sans-serif;overscroll-behavior:none}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;box-sizing:border-box}${BRAND}.sub{margin-bottom:34px}
p{color:rgba(255,255,255,.6);line-height:1.5;margin:0 0 22px}input{width:200px;text-align:center;font:600 32px ui-monospace,Menlo,monospace;letter-spacing:.3em;background:rgba(255,255,255,.06);color:#fff;border:1px solid #E8BA45;border-radius:14px;padding:12px 0;outline:0}
button{margin-top:16px;background:#E8BA45;color:#000;border:0;border-radius:14px;font:600 17px -apple-system,sans-serif;padding:12px 36px}#m{color:#ff8a65;font-size:14px;min-height:20px;margin-top:14px}</style></head><body>
<div class="mark">KINGMAKER</div><div class="sub">RONIN INC</div>
<p>Scan the code in Kingmaker on your Mac,<br>or type the six-digit pairing code it shows.</p>
<form id="f"><input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000"><br><button>Pair</button></form><div id="m"></div>
<script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const m=document.getElementById('m');m.textContent='';
const r=await fetch('/pair-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('c').value})}).catch(()=>null);
if(r&&r.ok)location.replace('/');else m.textContent='That code didn\\'t match. Check the one on your Mac.'})</script></body></html>`;

const APP_PAGE = `<!doctype html><html lang="en"><head>${HEAD}
<style>
:root{--gold:#E8BA45;--green:#4ADE80;--dim:rgba(255,255,255,.45);--line:rgba(255,255,255,.08)}
html,body{margin:0;height:100%;background:#000;color:#fff;font:16px -apple-system,system-ui,sans-serif;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
body{position:fixed;inset:0;display:flex;flex-direction:column;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
header{flex:none;text-align:center;padding:14px 0 10px;border-bottom:1px solid var(--line);position:relative}${BRAND}
.state{font-size:11px;color:var(--dim);margin-top:4px;letter-spacing:.04em}
#un{position:absolute;right:14px;top:calc(50% - 10px);font-size:12px;color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:10px;padding:2px 8px}
#talk{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:14px 16px 8px}
.m{margin:0 0 12px;line-height:1.38;white-space:pre-wrap;word-wrap:break-word;-webkit-user-select:text;user-select:text}
.you{text-align:right;font-weight:500}.km{color:var(--green)}.note{color:var(--dim);font-size:13px}.field{color:var(--gold);font-size:13px;text-align:right}
.src{font-size:14px}.src a{color:var(--gold);text-decoration:none;display:block;margin:3px 0}.src b{display:block;font-size:11px;color:var(--dim);letter-spacing:.12em;font-weight:600;margin-bottom:2px}
.tools{flex:none;display:flex;gap:8px;padding:6px 12px 0}
.tools button{flex:1;height:36px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:#fff;font-size:13px}
.tools button.on{border-color:var(--gold);color:var(--gold)}.tools button.rec{border-color:#ff5a5a;color:#ff5a5a}
form{flex:none;display:flex;gap:8px;align-items:center;margin:8px 12px 10px;padding:6px 6px 6px 14px;border:1px solid rgba(255,255,255,.14);border-radius:22px;background:rgba(255,255,255,.07)}
input[type=text]{flex:1;background:none;border:0;outline:0;color:#fff;font-size:17px;padding:8px 0;-webkit-user-select:text;user-select:text}
#b{flex:none;width:38px;height:38px;border-radius:19px;border:0;background:var(--gold);color:#000;font-size:19px;font-weight:700}#b:disabled{background:rgba(255,255,255,.12);color:rgba(255,255,255,.35)}
/* THE CALL: full screen, the Ronin crest pulsing with Kingmaker's voice. Sizes come from the device profile (fit(), below):
   --orb, --ctl, --type; the controls sit in the bottom third for one hand on the big phones; landscape puts them beside. */
:root{--orb:min(64vw,300px);--ctl:64px;--type:1}
#call{position:fixed;inset:0;z-index:50;display:none;flex-direction:column;align-items:center;background:radial-gradient(circle at 50% 38%,#16120a 0,#000 62%);
 padding:calc(env(safe-area-inset-top) + 14px) 18px calc(env(safe-area-inset-bottom) + 18px)}
#call.on{display:flex}
#call .top{width:100%;text-align:center}#call .who{font-family:"Bodoni 72",Didot,serif;font-weight:700;letter-spacing:.3em;font-size:calc(19px*var(--type))}
#call .st{margin-top:6px;color:var(--gold);font-size:calc(13px*var(--type));letter-spacing:.14em;text-transform:uppercase;min-height:1.3em}
#orbw{flex:1;display:flex;align-items:center;justify-content:center;width:100%}
#orb{width:var(--orb);height:var(--orb);border-radius:50%;display:flex;align-items:center;justify-content:center;position:relative;transition:transform .08s linear}
#orb::before{content:"";position:absolute;inset:-14%;border-radius:50%;background:radial-gradient(circle,rgba(232,186,69,.42) 0,rgba(232,186,69,.08) 45%,transparent 70%);opacity:var(--glow,.35);transition:opacity .1s linear}
#orb img{width:86%;height:86%;object-fit:contain;position:relative;filter:drop-shadow(0 0 18px rgba(232,186,69,.35))}
#call.thinking #orb{animation:breathe 1.6s ease-in-out infinite}@keyframes breathe{50%{transform:scale(1.05)}}
#line{max-width:92%;text-align:center;color:rgba(255,255,255,.75);font-size:calc(15px*var(--type));line-height:1.4;min-height:2.8em;margin-bottom:14px;-webkit-user-select:text;user-select:text}
.ctls{display:flex;gap:calc(var(--ctl)*.45);align-items:center;justify-content:center;width:100%}
.ctls button{width:var(--ctl);height:var(--ctl);border-radius:50%;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#fff;font-size:calc(var(--ctl)*.36)}
.ctls button.off{background:#fff;color:#000}.ctls #end{background:#e5484d;border-color:#e5484d}
.ctls .lbl,#ringC .lbl{display:block;font-size:10px;letter-spacing:.06em;color:rgba(255,255,255,.55);margin-top:6px;text-align:center}
#ptt{display:none;margin:4px auto 16px;width:calc(var(--ctl)*1.9);height:calc(var(--ctl)*1.9);border-radius:50%;border:2px solid var(--gold);background:rgba(232,186,69,.08);color:var(--gold);font-size:calc(13px*var(--type));letter-spacing:.08em;font-weight:600;touch-action:none}
#call.walkie #ptt{display:block}#ptt.down{background:var(--gold);color:#000}
#side{width:100%;display:flex;flex-direction:column;align-items:center}
#unSheet{position:fixed;inset:0;z-index:60;display:none;align-items:flex-end;background:rgba(0,0,0,.55)}#unSheet.on{display:flex}
#unSheet .box{width:100%;box-sizing:border-box;background:#111;border-top:1px solid rgba(232,186,69,.35);border-radius:18px 18px 0 0;padding:20px 18px calc(env(safe-area-inset-bottom) + 16px);text-align:center}
#unSheet b{font-size:17px}#unSheet p{color:rgba(255,255,255,.6);font-size:14px;line-height:1.4;margin:8px 0 16px}
#unSheet button{display:block;width:100%;height:50px;border-radius:14px;border:0;font-size:17px;font-weight:600;margin-top:8px}#unYes{background:#e5484d;color:#fff}#unNo{background:rgba(255,255,255,.08);color:#fff}
#ringC{display:none;gap:calc(var(--ctl)*1.2);justify-content:center;width:100%}#call.incoming #ringC{display:flex}#call.incoming .ctls,#call.incoming #mode{display:none}
#ringC button{width:calc(var(--ctl)*1.15);height:calc(var(--ctl)*1.15);border-radius:50%;border:0;color:#fff;font-size:calc(var(--ctl)*.42)}#ansB{background:#30a46c}#decB{background:#e5484d}
#call.incoming #orb{animation:ringing 1.1s ease-in-out infinite}@keyframes ringing{50%{transform:scale(1.08)}}
#mode{margin-top:14px;font-size:12px;color:rgba(255,255,255,.55);background:none;border:0;text-decoration:underline}
@media (orientation:landscape){#orb{width:min(58vh,38vw);height:min(58vh,38vw)}#call{flex-direction:row;flex-wrap:wrap}#call .top{width:100%}#orbw{flex:1;height:70%}#side{display:flex;flex-direction:column;align-items:center;justify-content:center;width:46%}}
/* THE FIRST-OPEN TOUR (as in the Mac's bar, lib/first-run.mjs): everything dims but one control, lit in gold, and one card. */
#tour{position:fixed;inset:0;z-index:70;display:none}#tour.on{display:block}
#tourHole{position:fixed;border-radius:14px;box-shadow:0 0 0 9999px rgba(0,0,0,.66);border:2px solid var(--gold);transition:all .25s ease;pointer-events:none}
#tourCard{position:fixed;left:14px;right:14px;background:#0b0b0b;border:1px solid rgba(232,186,69,.55);border-radius:16px;padding:16px 16px 12px}
#tourCard .n{font-size:11px;letter-spacing:.12em;color:var(--dim);font-weight:600}#tourCard b{display:block;color:var(--gold);font-size:18px;margin:4px 0 6px}
#tourCard p{margin:0 0 14px;line-height:1.4;font-size:15px;color:rgba(255,255,255,.9)}
#tourCard .row{display:flex;align-items:center;gap:10px}#tourSkip{background:none;border:0;color:var(--dim);font-size:14px;padding:8px 0}
#tourNext{margin-left:auto;height:38px;padding:0 18px;border-radius:12px;border:0;background:var(--gold);color:#000;font-size:15px;font-weight:700}
</style></head><body>
<header><div class="mark">KINGMAKER</div><div class="state" id="state">Connecting to your Mac…</div><a id="un" href="#">Unpair</a></header>
<div id="unSheet"><div class="box"><b>Unpair this iPhone?</b><p>It stops reaching Kingmaker on your Mac at once. To use it here again, scan a new pairing code.</p>
 <button id="unYes">Unpair</button><button id="unNo">Cancel</button></div></div>
<div id="talk"></div>
<div class="tools"><button id="loc">📍 Location</button><button id="cam">📷 Camera</button><button id="mic">🎙 Note</button><button id="callB">📞 Call</button></div>
<div class="tools" id="allowRow" style="display:none"><button id="allowB">🔔 Allow calls from Kingmaker</button></div>
<div id="call"><div class="top"><div class="who">KINGMAKER</div><div class="st" id="cst">Connecting</div></div>
 <div id="orbw"><div id="orb"><img src="/icon.png" alt=""></div></div>
 <div id="side"><div id="line"></div><button id="ptt">HOLD TO TALK</button>
 <div id="ringC"><div><button id="decB" aria-label="Decline">✕</button><span class="lbl">Decline</span></div><div><button id="ansB" aria-label="Answer">📞</button><span class="lbl">Answer</span></div></div>
 <div class="ctls"><div><button id="muteB" aria-label="Mute">🎙</button><span class="lbl">Mute</span></div><div><button id="endB" aria-label="End call">✕</button><span class="lbl">End</span></div><div><button id="sndB" aria-label="Kingmaker's voice">🔊</button><span class="lbl">Voice</span></div><div id="prvWrap"><button id="prvB" aria-label="Private or speaker">🔈</button><span class="lbl" id="prvL">Speaker</span></div></div>
 <button id="mode">Switch to hold-to-talk</button></div></div>
<input id="file" type="file" accept="image/*,video/*" capture="environment" multiple hidden>
<div id="tour" role="dialog" aria-label="Kingmaker tour"><div id="tourHole"></div><div id="tourCard"><div class="n" id="tourN"></div><b id="tourT"></b><p id="tourP"></p><div class="row"><button id="tourSkip">Skip the tour</button><button id="tourNext">Next</button></div></div></div>
<form id="f" autocomplete="off"><input id="t" type="text" placeholder="Ask or tell Kingmaker anything" enterkeyhint="send"><button id="b" disabled>↵</button></form>
<script>
// ── THE DEVICE PROFILE, applied by itself (owner 2026-10-15: "make it fit with the iphone … the last 5 generations").
// iOS hides the model, so it's read from what the page can see: the screen's CSS size, the pixel ratio and the safe
// area (a Dynamic Island's top inset is 59–62, a notch's 44–50). iPhone 13 mini … 17 Pro Max: 375, 390, 393, 402, 420,
// 428, 430 and 440 points wide.
function fit(){const w=Math.min(screen.width,screen.height),h=Math.max(screen.width,screen.height),R=document.documentElement.style;
 const probe=document.createElement('div');probe.style.cssText='position:fixed;top:0;height:env(safe-area-inset-top);visibility:hidden';document.body.appendChild(probe);
 const inset=probe.getBoundingClientRect().height;probe.remove();
 const cls=w<=375?'mini':w<=402?'base':w<=420?'air':'max',island=inset>=55;
 const p={mini:{orb:62,ctl:58,type:.94},base:{orb:64,ctl:64,type:1},air:{orb:62,ctl:68,type:1.04},max:{orb:60,ctl:70,type:1.08}}[cls];
 R.setProperty('--orb','min('+p.orb+'vw,'+(cls==='max'?320:300)+'px)');R.setProperty('--ctl',p.ctl+'px');R.setProperty('--type',p.type);
 document.documentElement.dataset.fit=cls+(island?' island':' notch')+(h/w>2.1?' tall':'');}
const talk=document.getElementById('talk'),st=document.getElementById('state'),t=document.getElementById('t'),b=document.getElementById('b');
// Keep the text field usable in EVERY orientation with the keyboard up: track the visible viewport (iOS shrinks it for
// the keyboard but leaves the fixed body full-height), pin the body to it, and keep the latest message in view.
if(window.visualViewport){const vv=window.visualViewport,setVH=()=>{document.body.style.height=vv.height+'px';if(document.activeElement===t)talk.scrollTop=talk.scrollHeight};vv.addEventListener('resize',setVH);vv.addEventListener('scroll',setVH);setVH();t.addEventListener('focus',()=>setTimeout(setVH,120))}
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let where='On your Mac';const show=s=>{st.textContent=s};
function add(l){const d=document.createElement('div');
 if(l.who==='Sources'){d.className='m src';d.innerHTML='<b>SOURCES</b>'+l.text.split(' · ').map(p=>{const i=p.lastIndexOf(' — ');const u=i>0?p.slice(i+3):p,n=i>0?p.slice(0,i):p;return /^https?:/.test(u)?'<a href="'+esc(u)+'" target="_blank" rel="noopener">↗ '+esc(n)+'</a>':esc(p)}).join('')}
 else{d.className='m '+(l.who==='field'?'field':l.who.startsWith('You')?'you':l.who==='Kingmaker'?'km':'note');d.textContent=(l.who==='You (said)'?'🎙 ':'')+l.text}
 talk.appendChild(d);talk.scrollTop=talk.scrollHeight;return d}
t.addEventListener('input',()=>{b.disabled=!t.value.trim()});
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const text=t.value.trim();if(!text)return;t.value='';t.placeholder=ASK;b.disabled=true;show('Sending to your Mac…');
 try{const r=await fetch('/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});show(r.ok?'Kingmaker is working…':'Not paired: scan the code on your Mac again.')}catch{show('Your Mac is out of reach. Same Wi-Fi?')}});
function listen(){const es=new EventSource('/events');
 es.onopen=()=>{show(where);C.lastAt=Date.now()};es.onmessage=e=>{const l=JSON.parse(e.data);add(l);if(l.who==='Kingmaker'){show(where);hearAnswer(l)}};
 es.onerror=()=>show('Reconnecting to your Mac…');es.addEventListener('unpaired',()=>{es.close();gone()});
 es.addEventListener('ring',e=>ring(JSON.parse(e.data)));
 es.addEventListener('ring-say',e=>{const d=JSON.parse(e.data);if(d.id===C.ring)C.rq=C.rq.then(()=>speakRing(d.seq,d.text))});
 es.addEventListener('ring-listen',e=>{const d=JSON.parse(e.data);if(d.id===C.ring)C.rq=C.rq.then(()=>{C.ringListen=true;C.capturing=false;setState('listening','Your turn')})});
 es.addEventListener('ring-end',e=>{const d=JSON.parse(e.data);if(d.id===C.ring)C.rq=C.rq.then(()=>ringOver('Call ended.'))})}
function gone(){document.body.innerHTML='<div style="margin:auto;text-align:center;color:rgba(255,255,255,.6);padding:30px;line-height:1.5">This phone is unpaired. Scan a new pairing code on your Mac to use Kingmaker here again.</div>'}
// UNPAIR: one tap, then one confirm, in Kingmaker's own sheet (not the browser's dialog).
const sheet=document.getElementById('unSheet');
document.getElementById('un').addEventListener('click',e=>{e.preventDefault();sheet.classList.add('on')});
document.getElementById('unNo').addEventListener('click',()=>sheet.classList.remove('on'));
sheet.addEventListener('click',e=>{if(e.target===sheet)sheet.classList.remove('on')});
document.getElementById('unYes').addEventListener('click',async()=>{try{await fetch('/unpair',{method:'POST'})}catch{}gone()});
// LOCATION: only while the switch is on, and the state line says so. Sent at most every 15 s.
const locB=document.getElementById('loc');let watch=null,lastSent=0;
function locOn(){if(!navigator.geolocation)return add({who:'note',text:'This phone has no location.'});
 watch=navigator.geolocation.watchPosition(p=>{const now=Date.now();if(now-lastSent<15000)return;lastSent=now;const c=p.coords;
  fetch('/field/location',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lat:c.latitude,lon:c.longitude,acc:c.accuracy,speed:c.speed,heading:c.heading})}).catch(()=>{})},
  e=>{add({who:'note',text:'Location: '+(e.code===1?'not allowed. Settings → Privacy → Location Services → Safari Websites.':e.message)});locOff()},{enableHighAccuracy:true,maximumAge:10000});
 locB.classList.add('on');where='On your Mac · sharing location';show(where);try{localStorage.km_loc='1'}catch{}}
function locOff(){if(watch!=null)navigator.geolocation.clearWatch(watch);watch=null;locB.classList.remove('on');where='On your Mac';show(where);try{localStorage.km_loc='0'}catch{}}
locB.addEventListener('click',()=>watch==null?locOn():locOff());try{if(localStorage.km_loc==='1')locOn()}catch{}
// CAMERA: photos and videos straight from the camera (or the library), each sent to the Mac. A photo goes as a JPEG the
// Mac's vision can read: HEIC decoded here, turned upright, at most 2560 px (the original goes when the phone can't).
// A video goes as it is, plus one frame of it as a photo. Each upload shows its progress, retries a dropped connection
// twice, and says when it's on the Mac; the latest photo rides the next thing said or typed.
const file=document.getElementById('file');document.getElementById('cam').addEventListener('click',()=>file.click());
const MAXPX=2560,ASK='Ask or tell Kingmaker anything';
function canvasJpeg(src,w,h){const k=Math.min(1,MAXPX/Math.max(w,h)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(w*k));c.height=Math.max(1,Math.round(h*k));
 c.getContext('2d').drawImage(src,0,0,c.width,c.height);return new Promise(r=>c.toBlob(b=>r(b),'image/jpeg',.86))}
async function asJpeg(f){try{let im;try{im=await createImageBitmap(f,{imageOrientation:'from-image'})}catch{im=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=URL.createObjectURL(f)})}
 const b=await canvasJpeg(im,im.width||im.naturalWidth,im.height||im.naturalHeight);return b&&b.size>0?b:f}catch{return f}}
function videoFrame(f){return new Promise(res=>{const v=document.createElement('video'),u=URL.createObjectURL(f);let done=false;v.muted=true;v.playsInline=true;v.preload='auto';
 const fin=b=>{if(done)return;done=true;URL.revokeObjectURL(u);res(b)};setTimeout(()=>fin(null),8000);
 v.onloadedmetadata=()=>{v.currentTime=Math.min(1,(v.duration||2)/2)};v.onseeked=async()=>{try{fin(await canvasJpeg(v,v.videoWidth,v.videoHeight))}catch{fin(null)}};v.onerror=()=>fin(null);v.src=u;v.load()})}
const jpgName=n=>n.replace(/\\.[^.]+$/,'')+'.jpg';
function send1(blob,name,line){return new Promise((ok,no)=>{const x=new XMLHttpRequest();x.open('POST','/field/upload?name='+encodeURIComponent(name));x.timeout=600000;
 x.setRequestHeader('content-type',blob.type||'application/octet-stream');
 x.upload.onprogress=e=>{if(e.lengthComputable)line.textContent='Sending '+name+'… '+Math.round(e.loaded/e.total*100)+'%'};
 x.onload=()=>{let j={};try{j=JSON.parse(x.responseText)}catch{}x.status===200?ok(j):no({status:x.status})};x.onerror=()=>no({status:0});x.ontimeout=()=>no({status:0});x.send(blob)})}
async function upload(blob,name){const line=add({who:'field',text:'Sending '+name+'…'});
 for(let i=0;i<3;i++){try{const j=await send1(blob,name,line);line.textContent='✓ On your Mac: '+j.saved;
   if(j.attached){t.placeholder='Ask about the photo…';add({who:'note',text:'Ask about it now, typed or on a call: "what is this?", "read it", "save it".'})}return j}
  catch(e){if(e.status===413){line.textContent='✗ Too big to send: '+name;return null}if(e.status===401){line.textContent='✗ Not paired: scan the code on your Mac again.';return null}
   line.textContent=(i<2?'Retrying '+name+'… ':'✗ Not sent: ')+(e.status?'the Mac said '+e.status:'your Mac is out of reach');if(i<2)await new Promise(r=>setTimeout(r,1500*(i+1)))}}
 return null}
file.addEventListener('change',async()=>{const list=[...file.files];file.value='';
 for(const f of list){const vid=/^video\\//.test(f.type),n=f.name||((vid?'video-':'photo-')+Date.now()+(vid?'.mov':'.jpg'));
  if(/^image\\//.test(f.type)||/\\.(heic|heif|jpe?g|png)$/i.test(n)){const j=await asJpeg(f);await upload(j,j===f?n:jpgName(n))}
  else if(vid){await upload(f,n);const fr=await videoFrame(f);if(fr)await upload(fr,jpgName(n).replace(/\\.jpg$/,' frame.jpg'));else add({who:'note',text:'The video is on your Mac. To ask about what is in it, send a photo too.'})}
  else await upload(f,n)}});
// VOICE NOTE: tap to record, tap to stop; the recording goes to the Mac. (Talking to Kingmaker: the keyboard's mic.)
const micB=document.getElementById('mic');let rec=null,chunks=[];
micB.addEventListener('click',async()=>{if(rec){rec.stop();return}
 try{const s=await navigator.mediaDevices.getUserMedia({audio:true});const type=MediaRecorder.isTypeSupported('audio/mp4')?'audio/mp4':'audio/webm';
  rec=new MediaRecorder(s,{mimeType:type});chunks=[];rec.ondataavailable=e=>chunks.push(e.data);
  rec.onstop=()=>{s.getTracks().forEach(x=>x.stop());micB.classList.remove('rec');micB.textContent='🎙 Voice note';const blob=new Blob(chunks,{type});rec=null;
   upload(blob,'voice-note-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')+(type==='audio/mp4'?'.m4a':'.webm'))};
  rec.start();micB.classList.add('rec');micB.textContent='■ Stop'}catch(e){add({who:'note',text:'Microphone: '+(e.name==='NotAllowedError'?'not allowed for this site.':e.message)})}});
// ── CALL KINGMAKER (lib/phone-voice.mjs): hands-free. The phone listens (its echo cancelling on), sends each utterance as
// 16 kHz PCM, Kingmaker's answer is spoken back; the crest pulses with the voice. Turn-taking, with barge-in: speaking
// over Kingmaker stops it. WALKIE-TALKIE: hold to talk, let go to send, the fallback when a live call can't run (the
// mic stream blocked, the Wi-Fi dropping, the app sent to the background), switched to by itself or by hand.
const C={el:document.getElementById('call'),st:document.getElementById('cst'),line:document.getElementById('line'),orb:document.getElementById('orb'),
 on:false,walkie:false,muted:false,voice:true,state:'',ctx:null,src:null,node:null,stream:null,buf:[],speaking:false,quiet:0,floor:.004,fails:0,audio:new Audio(),busy:false,lastAt:0};
C.audio.setAttribute('playsinline','');
// iOS only lets an <audio> element play from inside a user gesture, and an AudioContext starts suspended. So on the
// first Call/Answer/hold/Voice tap we RESUME the context and UNLOCK the element with a silent clip; after that the
// answer audio (which plays after an awaited fetch, outside any gesture) is allowed.
const SILENT_WAV='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
function unlockAudio(){try{C.ctx=C.ctx||new (window.AudioContext||window.webkitAudioContext)();if(C.ctx.state==='suspended')C.ctx.resume()}catch{}
 if(C.audioUnlocked)return;try{C.audio.muted=true;C.audio.src=SILENT_WAV;const p=C.audio.play();const fin=()=>{try{C.audio.pause()}catch{}C.audio.muted=false;C.audioUnlocked=true};(p&&p.then)?p.then(fin).catch(()=>{C.audio.muted=false}):fin()}catch{}}
function sayFailed(e){const tap=(e&&e.name==='NotAllowedError')||!C.audioUnlocked;add({who:'note',text:tap?'Tap the screen once, then ask again — iOS needs a tap before Kingmaker can speak out loud.':'I couldn’t play that reply out loud; the text is above.'});try{fetch('/voice/sayfail',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:String((e&&e.name)||e||'')})})}catch{}}
const setState=(s,t)=>{C.state=s;C.el.className='on'+(C.walkie?' walkie':'')+(s==='thinking'?' thinking':'')+(s==='incoming'?' incoming':'');C.st.textContent=t||({listening:'Listening',thinking:'Thinking',speaking:'Speaking',hold:'Hold to talk',muted:'Muted',paused:'Paused'}[s]||s)};
const glow=v=>{C.orb.style.transform='scale('+(1+Math.min(.22,v*3.2)).toFixed(3)+')';C.orb.style.setProperty('--glow',(0.35+Math.min(.65,v*9)).toFixed(2))};
function pcm16(chunks,rate){let n=0;for(const c of chunks)n+=c.length;const f=new Float32Array(n);let o=0;for(const c of chunks){f.set(c,o);o+=c.length}
 const ratio=rate/16000,len=Math.floor(n/ratio),out=new Int16Array(len);for(let i=0;i<len;i++){const v=f[Math.floor(i*ratio)];out[i]=Math.max(-1,Math.min(1,v))*32767}return out}
async function sendUtterance(chunks){if(!chunks.length)return;const body=pcm16(chunks,C.ctx.sampleRate);if(body.length<16000*0.35)return;
 if(C.ring){C.ringListen=false;setState('thinking');try{await fetch('/ring/heard?id='+encodeURIComponent(C.ring),{method:'POST',headers:{'content-type':'application/octet-stream'},body})}catch{}return}
 setState('thinking');C.busy=true;
 try{const r=await fetch('/voice/turn',{method:'POST',headers:{'content-type':'application/octet-stream'},body});const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error('turn');C.fails=0;if(!j.heard){C.busy=false;setState(C.walkie?'hold':'listening','Didn’t catch that');return}C.line.textContent='“'+j.heard+'”'}
 catch{C.busy=false;if(++C.fails>=2&&!C.walkie){toWalkie('The connection is weak: switched to hold-to-talk.')}else setState(C.walkie?'hold':'listening','Your Mac is out of reach')}}
async function speak(text){if(!C.on){return}C.line.textContent=text;if(!C.voice){C.busy=false;return setState(C.walkie?'hold':'listening')}
 try{const r=await fetch('/voice/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});if(r.status!==200)throw 0;
  const url=URL.createObjectURL(await r.blob());C.audio.src=url;C.speaking=true;setState('speaking');
  if(C.ctx&&!C.src){C.src=C.ctx.createMediaElementSource(C.audio);C.an=C.ctx.createAnalyser();C.an.fftSize=512;C.src.connect(C.an);C.an.connect(C.ctx.destination)}
  if(C.ctx&&C.ctx.state==='suspended'){try{await C.ctx.resume()}catch{}}
  applyRoute();await C.audio.play();await new Promise(res=>{C.audio.onended=res;C.audio.onpause=res});URL.revokeObjectURL(url)}catch(e){sayFailed(e)}
 C.speaking=false;C.busy=false;glow(0);if(C.on)setState(C.walkie?'hold':(C.muted?'muted':'listening'))}
function level(a){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*a[i];return Math.sqrt(s/a.length)}
async function openMic(){applyRoute();C.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});
 C.ctx=C.ctx||new (window.AudioContext||window.webkitAudioContext)();await C.ctx.resume();
 const src=C.ctx.createMediaStreamSource(C.stream),node=C.ctx.createScriptProcessor(4096,1,1);src.connect(node);node.connect(C.ctx.destination);C.node=node;
 node.onaudioprocess=e=>{const a=new Float32Array(e.inputBuffer.getChannelData(0));e.outputBuffer.getChannelData(0).fill(0);const v=level(a);
  if(C.speaking){if(C.an){const d=new Float32Array(C.an.fftSize);C.an.getFloatTimeDomainData(d);glow(level(d))}
   if(!C.walkie&&!C.muted&&v>Math.max(.05,C.floor*9)){C.bargeIn=(C.bargeIn||0)+1;if(C.bargeIn>=3){C.audio.pause();C.bargeIn=0;C.buf=[a];C.capturing=true}}else C.bargeIn=0;return}
  if(C.walkie){if(C.holding)C.buf.push(a),glow(v);else glow(0);return}
  if(C.muted||C.busy||(C.ring&&!C.ringListen)){glow(0);return}
  glow(v);if(!C.capturing){C.floor=C.floor*.97+v*.03;if(v>Math.max(.012,C.floor*3)){C.capturing=true;C.buf=[a];C.quiet=0}return}
  C.buf.push(a);if(v<Math.max(.008,C.floor*2))C.quiet+=a.length/C.ctx.sampleRate;else C.quiet=0;
  const secs=C.buf.length*4096/C.ctx.sampleRate;if(C.quiet>.9||secs>30){C.capturing=false;const chunks=C.buf;C.buf=[];sendUtterance(chunks)}}}
async function startCall(){C.on=true;C.walkie=false;C.fails=0;C.line.textContent='';setState('listening','Connecting');
 try{await openMic();setState('listening')}catch(e){toWalkie(e&&e.name==='NotAllowedError'?'The microphone isn’t allowed: Settings → Safari → Microphone.':'A live call can’t start here: hold to talk instead.')}
 try{if('wakeLock' in navigator)C.lock=await navigator.wakeLock.request('screen')}catch{}}
function endCall(){C.on=false;C.audio.pause();if(C.stream)C.stream.getTracks().forEach(t=>t.stop());if(C.node)C.node.disconnect();C.stream=C.node=null;C.capturing=false;C.buf=[];
 try{C.lock&&C.lock.release()}catch{}C.el.className='';glow(0)}
function toWalkie(why){C.walkie=true;document.getElementById('mode').textContent='Switch to a live call';setState('hold');if(why)C.line.textContent=why;
 if(!C.stream)openMic().catch(()=>{C.line.textContent='The microphone isn’t available: Settings → Safari → Microphone.'})}
function toCall(){C.walkie=false;document.getElementById('mode').textContent='Switch to hold-to-talk';setState(C.muted?'muted':'listening')}
document.getElementById('callB').addEventListener('click',()=>{unlockAudio();startCall()});document.getElementById('endB').addEventListener('click',endCall);
document.getElementById('muteB').addEventListener('click',e=>{C.muted=!C.muted;e.currentTarget.classList.toggle('off',C.muted);if(!C.speaking&&!C.walkie)setState(C.muted?'muted':'listening')});
document.getElementById('sndB').addEventListener('click',e=>{unlockAudio();C.voice=!C.voice;e.currentTarget.classList.toggle('off',!C.voice);if(!C.voice)C.audio.pause()});
document.getElementById('mode').addEventListener('click',()=>C.walkie?toCall():toWalkie());
// SPEAKER ↔ PRIVATE: route Kingmaker's replies to the earpiece for a quiet conversation, or out loud. Per phone.
// Safari's Audio Session is the lever: 'play-and-record' routes to the receiver (earpiece) while the mic is open, which
// is why Private keeps the call's mic live; 'playback' is the loudspeaker. Headphones take over either way. Where the
// API is missing (older iOS) the toggle is hidden and we say to use headphones, rather than show a switch that's dead.
const hasAudioSession='audioSession' in navigator;
function applyRoute(){try{if(hasAudioSession)navigator.audioSession.type=C.private?'play-and-record':'playback'}catch{}}
function setRoute(on){C.private=on;try{localStorage.km_route=on?'private':'speaker'}catch{}const b=document.getElementById('prvB');if(b){b.textContent=on?'🤫':'🔈';b.classList.toggle('on',on);document.getElementById('prvL').textContent=on?'Private':'Speaker'}applyRoute()}
if(!hasAudioSession){const w=document.getElementById('prvWrap');if(w)w.style.display='none';try{if(localStorage.km_route_hint!=='1'){add({who:'note',text:'Use headphones for a private conversation.'});localStorage.km_route_hint='1'}}catch{}}
else{let want=false;try{want=localStorage.km_route==='private'}catch{}setRoute(want);document.getElementById('prvB').addEventListener('click',()=>{unlockAudio();setRoute(!C.private);if(C.private&&C.on&&!C.stream)openMic().catch(()=>{})})}
const ptt=document.getElementById('ptt');
ptt.addEventListener('pointerdown',e=>{e.preventDefault();unlockAudio();if(C.speaking)C.audio.pause();C.holding=true;C.buf=[];ptt.classList.add('down');setState('hold','Listening')});
const release=()=>{if(!C.holding)return;C.holding=false;ptt.classList.remove('down');const chunks=C.buf;C.buf=[];sendUtterance(chunks)};
ptt.addEventListener('pointerup',release);ptt.addEventListener('pointercancel',release);ptt.addEventListener('pointerleave',release);
// iOS stops a web page's mic in the background: a call becomes hold-to-talk while away, and says so.
document.addEventListener('visibilitychange',()=>{if(C.on&&document.visibilityState==='hidden'&&!C.walkie)toWalkie('Kingmaker was in the background, so the call became hold-to-talk.')});
// Kingmaker's answers, from the conversation stream: spoken during a call.
C.q=Promise.resolve();const hearAnswer=l=>{if(C.on&&!C.ring&&l.who==='Kingmaker'&&Date.parse(l.at||0)>=C.lastAt-2000)C.q=C.q.then(()=>speak(l.text))};
// ── KINGMAKER CALLS YOU (lib/phone-ring.mjs): the CRM's calls to the owner ring here. Answer, then Kingmaker speaks;
// when it asks, the one reply goes back; Decline or End hangs up. A closed app gets the ring as a notification.
const ring=info=>{if(!info||!info.id||C.ring===info.id)return;C.ring=info.id;C.ringListen=false;C.walkie=false;C.on=true;C.line.textContent=(info.caller||'Kingmaker')+' is calling';setState('incoming','Incoming call')};
async function speakRing(seq,text){C.line.textContent=text;try{const r=await fetch('/voice/say',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
 if(r.status===200){const url=URL.createObjectURL(await r.blob());C.audio.src=url;C.speaking=true;setState('speaking');
  if(C.ctx&&!C.src){C.src=C.ctx.createMediaElementSource(C.audio);C.an=C.ctx.createAnalyser();C.an.fftSize=512;C.src.connect(C.an);C.an.connect(C.ctx.destination)}
  if(C.ctx&&C.ctx.state==='suspended'){try{await C.ctx.resume()}catch{}}
  applyRoute();await C.audio.play();await new Promise(res=>{C.audio.onended=res;C.audio.onpause=res});URL.revokeObjectURL(url)}}catch(e){sayFailed(e)}
 C.speaking=false;glow(0);if(C.ring)fetch('/ring/played?id='+encodeURIComponent(C.ring)+'&seq='+seq,{method:'POST'}).catch(()=>{})}
C.rq=Promise.resolve();
document.getElementById('ansB').addEventListener('click',async()=>{if(!C.ring)return;unlockAudio();setState('listening','Connecting');
 try{await openMic()}catch{C.line.textContent='The microphone isn’t allowed: Settings → Safari → Microphone.'}
 const r=await fetch('/ring/answer?id='+encodeURIComponent(C.ring),{method:'POST'}).catch(()=>null);if(!r||!r.ok){ringOver('The call already ended.');return}setState('listening','Connected')});
document.getElementById('decB').addEventListener('click',()=>{if(C.ring)fetch('/ring/decline?id='+encodeURIComponent(C.ring),{method:'POST'}).catch(()=>{});ringOver('')});
function ringOver(why){C.ring=null;C.ringListen=false;endCall();if(why)add({who:'note',text:why})}
const endB=document.getElementById('endB');endB.addEventListener('click',()=>{if(C.ring){fetch('/ring/hangup?id='+encodeURIComponent(C.ring),{method:'POST'}).catch(()=>{});ringOver('')}},true);
const checkRing=async()=>{try{const a=await (await fetch('/ring/active',{cache:'no-store'})).json();if(a&&a.state==='ringing')ring(a)}catch{}};
if(new URLSearchParams(location.search).get('ring'))checkRing();
navigator.serviceWorker&&navigator.serviceWorker.addEventListener('message',e=>{if(e.data&&e.data.reload)location.reload();else if(e.data&&e.data.ring)checkRing()});
// "Allow calls": Web Push for a Home Screen app (iOS 16.4+), only on the owner's tap; until then, rings reach the open app.
const allowRow=document.getElementById('allowRow');
const b64=s=>{const p='='.repeat((4-s.length%4)%4),r=atob((s+p).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(r,c=>c.charCodeAt(0))};
if('PushManager' in window&&'Notification' in window&&Notification.permission!=='granted')allowRow.style.display='flex';
document.getElementById('allowB').addEventListener('click',async()=>{try{if(await Notification.requestPermission()!=='granted')return add({who:'note',text:'Calls stay in the open app: notifications are off for Kingmaker.'});
 const reg=await navigator.serviceWorker.ready,{key}=await (await fetch('/push/key')).json();
 const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(key)});
 await fetch('/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(sub)});allowRow.style.display='none';add({who:'field',text:'✓ Kingmaker can call you now, even with the app closed.'})}
 catch(e){add({who:'note',text:'Calls: '+(navigator.standalone?e.message:'add Kingmaker to your Home Screen first, then allow calls from there.')})}});
window.addEventListener('resize',fit);fit();
listen();
// Stay at this phone's resume link (so Add to Home Screen keeps it), and in Safari say how to make it an app.
history.replaceState(null,'','/?resume=__RESUME__');
if(!navigator.standalone&&!matchMedia('(display-mode: standalone)').matches)add({who:'field',text:'Make it an app: tap Share → Add to Home Screen, then open Kingmaker from there (full screen, no browser).'});
async function wake(){try{if('wakeLock' in navigator)await navigator.wakeLock.request('screen')}catch{}}
wake();document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')wake()});
document.addEventListener('touchmove',e=>{if(!e.target.closest('#talk'))e.preventDefault()},{passive:false});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').then(r=>r.update()).catch(()=>{});

// ── THE FIRST-OPEN TOUR: three steps, once per phone (localStorage km_tour), again with ?tour in the address. The lit
// control is ringed in gold, the card sits on the other half of the screen, Next and Skip are the only ways out.
(function(){const S=[
 {el:'f',t:'Ask Kingmaker anything',p:'Type here. Kingmaker does the work on your Mac and answers right here.'},
 {el:'callB',t:'Talk to it hands-free',p:'Tap Call and just talk, like a phone call. Kingmaker answers out loud.'},
 {el:function(){return document.getElementById('allowRow').style.display!=='none'?'allowB':'loc'},t:'Share only when you tap',
  p:'Location, camera and notes go to your Mac only when you tap them. Allow calls lets Kingmaker ring this phone when it needs you.'}];
let i=0;const T=document.getElementById('tour'),H=document.getElementById('tourHole'),C=document.getElementById('tourCard');
function seen(){try{return localStorage.km_tour==='1'}catch(e){return false}}
function done(){T.classList.remove('on');try{localStorage.km_tour='1'}catch(e){}}
function draw(){const s=S[i],id=typeof s.el==='function'?s.el():s.el,el=document.getElementById(id);
 document.getElementById('tourN').textContent='STEP '+(i+1)+' OF '+S.length;document.getElementById('tourT').textContent=s.t;document.getElementById('tourP').textContent=s.p;
 document.getElementById('tourNext').textContent=i+1<S.length?'Next':'Done';
 const r=el?el.getBoundingClientRect():null;
 if(r&&r.width){H.style.display='block';H.style.left=(r.left-6)+'px';H.style.top=(r.top-6)+'px';H.style.width=(r.width+12)+'px';H.style.height=(r.height+12)+'px'}else H.style.display='none';
 const low=r&&r.top>innerHeight/2;C.style.top=low?'calc(env(safe-area-inset-top) + 70px)':'';C.style.bottom=low?'':'calc(env(safe-area-inset-bottom) + 24px)'}
document.getElementById('tourNext').addEventListener('click',function(){if(i+1<S.length){i++;draw()}else done()});
document.getElementById('tourSkip').addEventListener('click',done);
addEventListener('resize',function(){if(T.classList.contains('on'))draw()});
if(!seen()||/[?&]tour\\b/.test(location.search)){T.classList.add('on');setTimeout(draw,60)}})();
</script></body></html>`;

/** The pages as the phone gets them, for scripts/phone-preview.mjs (a sample-data preview on this Mac) and the tests. */
/** The companion page's build hash: when APP_PAGE changes, /sw.js changes, and the SW reloads open windows (cache-bust). */
const COMPANION_BUILD = hash(APP_PAGE).slice(0, 12);
export const PREVIEW_PAGES = Object.freeze({ app: (resume = 'preview') => APP_PAGE.replace('__RESUME__', resume), pair: () => PAIR_PAGE, setup: (appUrl) => SETUP_PAGE(appUrl) });
