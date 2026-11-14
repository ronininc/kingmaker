// Timed JSON HTTP for command modules. This file does not read the filesystem
// or the environment: the caller passes a finished URL. That split keeps a
// module that reads local state from also opening the network.

export async function fetchJson(url, { method = 'GET', body, headers, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  if (typeof response.json === 'function') {
    try { json = await response.json(); }
    catch (error) { if (response.ok) throw error; }
  }
  return { ok: response.ok, status: response.status, json };
}
