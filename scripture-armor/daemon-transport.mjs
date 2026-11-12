// daemon-transport.mjs — THE one place the vault daemon's local transport
// endpoint is computed. Before this module existed, the expression
//     flags.socket ? path.resolve(flags.socket) : path.join(dir, 'vaultd.sock')
// was copy-pasted across vaultd.mjs, armor.mjs, launch.mjs, dashboard.mjs,
// submit-transport-guard.mjs and protection-status.mjs, and the owner
// channel's paths were derived by string surgery on the socket path.
//
// Platforms:
//   POSIX — a Unix-domain socket file inside the identity store:
//           <identityDir>/vaultd.sock, byte-identical to the historical
//           layout, with the owner channel in <identityDir>/owner/.
//   win32 — Node's IPC contract ("Identifying paths for IPC connections")
//           requires a named pipe: the path must refer to an entry in
//           \\?\pipe\ or \\.\pipe\; a filesystem path is not a legal
//           endpoint and libuv does not translate one. The pipe name is
//           derived from the identity dir (sha256 of the normalized dir,
//           first 12 hex chars), so the standalone and Kingmaker-bundled
//           products — which already hold different identity dirs
//           (product-paths.mjs) — get different pipes with no extra
//           logic, and every process that knows the identity dir
//           computes the same name.
//
// Owner-channel FILES (the per-daemon token, the dual-approval confirm
// records) are anchored on the identity dir on EVERY platform: they are
// real files and never derive from the transport name — a pipe name is
// not a path, and string surgery on it was the trap. Only the two
// ENDPOINTS (requester + owner) become pipes on win32.
//
// Every function takes an injectable `platform` (default process.platform)
// and uses the matching path module, so the mapping is unit-checkable on
// any host by injecting the platform — no faked globals.

import path from 'node:path';
import crypto from 'node:crypto';

export const SOCKET_BASENAME = 'vaultd.sock';
export const PIPE_PREFIX = '\\\\.\\pipe\\scripture-armor-vaultd-';

function pathFor(platform) { return platform === 'win32' ? path.win32 : path.posix; }

/** True when an endpoint string names a Windows pipe rather than a file. */
export function isPipeEndpoint(endpoint) {
  return typeof endpoint === 'string'
    && (endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('\\\\?\\pipe\\'));
}

// The hash input: the identity dir normalized under the target platform's
// rules. A trailing separator (other than at a root) must not change the
// name; on win32 the path is case-folded, because Windows paths are
// case-insensitive and the same store reached through a differently-cased
// path must still name the same pipe.
function identityKey(identityDir, platform) {
  const p = pathFor(platform);
  let n = p.normalize(String(identityDir));
  const root = p.parse(n).root;
  while (n.length > root.length && n.endsWith(p.sep)) n = n.slice(0, -1);
  return platform === 'win32' ? n.toLowerCase() : n;
}

/** The win32 named-pipe name for an identity dir. */
export function pipeNameFor(identityDir) {
  const h = crypto.createHash('sha256').update(identityKey(identityDir, 'win32'), 'utf8').digest('hex').slice(0, 12);
  return `${PIPE_PREFIX}${h}`;
}

/**
 * The full transport layout for one identity store:
 *   socket          — the requester endpoint (POSIX path / win32 pipe)
 *   ownerSocket     — the owner endpoint (POSIX path / win32 pipe)
 *   ownerDir        — the real directory holding the owner FILES
 *   ownerTokenPath  — real file, identity-dir anchored on every platform
 *   ownerConfirmPath(id) — real file, same anchor
 *   isPipe          — true on win32 (endpoints are pipes, not files:
 *                     no unlink/chmod/stat applies to them)
 */
export function transportFor(identityDir, platform = process.platform) {
  const p = pathFor(platform);
  const pipe = platform === 'win32';
  const socket = pipe ? pipeNameFor(identityDir) : p.join(identityDir, SOCKET_BASENAME);
  const ownerDir = p.join(identityDir, 'owner');
  const ownerSocket = pipe ? `${socket}.owner` : p.join(ownerDir, `${SOCKET_BASENAME}.owner`);
  return Object.freeze({
    platform,
    isPipe: pipe,
    identityDir: String(identityDir),
    socket,
    ownerDir,
    ownerSocket,
    ownerTokenPath: p.join(ownerDir, `${SOCKET_BASENAME}.owner.token`),
    ownerConfirmPath: (id) => p.join(ownerDir, `${SOCKET_BASENAME}.confirm-${id}.json`),
  });
}

/** The default requester endpoint for an identity dir. */
export function daemonSocketFor(identityDir, platform = process.platform) {
  return transportFor(identityDir, platform).socket;
}

/**
 * An explicit endpoint (a --socket flag, $ARMOR_VAULTD_SOCKET, a peer's
 * stored daemon_socket) is an OVERRIDE and stays the caller's word:
 * POSIX callers historically path.resolve()d it, and still do; on win32
 * the value passes through untouched — path.resolve() would rewrite a
 * pipe name into a filesystem path and break it.
 */
export function resolveEndpoint(explicit, identityDir, platform = process.platform) {
  if (!explicit) return daemonSocketFor(identityDir, platform);
  if (platform === 'win32') return String(explicit);
  return pathFor(platform).resolve(String(explicit));
}
