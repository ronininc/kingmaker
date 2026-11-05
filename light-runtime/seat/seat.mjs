// light-runtime/seat/seat.mjs — THE BROWSER SEAT: the load-bearing engine that runs IN the
// tab (Robbie's three-layer split, 2026-10-28; spec: kingmaker-browser-runtime-spec.md).
//
// This file reaches the page ONLY through the device layer's verified session handoff
// (light-runtime/artifact.mjs): the sealed engine package was signature-verified and opened
// by the native layer, and this module is part of that opened bundle. The page holds no keys —
// not the installation signer, not the armor identity, nothing that can sign or unseal.
//
// What the seat does, in order:
//   1. Reads the engine manifest (pins + signer, from the opened package).
//   2. Fetches the wllama runtime and the weights from the device layer as BYTES and verifies
//      each sha256 against the manifest pins before anything is instantiated. A mismatch is
//      a refusal, not a warning.
//   3. Loads the model in-tab (wllama: GGUF, WebGPU offload when the browser offers it,
//      Wasm otherwise) — inference executes here, on this device's GPU/CPU, never streamed
//      from a cloud and never run by the server.
//   4. Registers with the light runtime's ask router as a seat — only once the model is
//      loaded, so registration IS readiness — and takes 'write'-lane asks off its poll,
//      answering them locally and reporting its diagnostics as a labelled self-report.
//
// The seat is an engine, never the brain's hands (the spec's sandbox rule): it can only
// produce text for the lane the router already decided. Tools, governance and approvals stay
// native, behind the fallback seat.

const sha256Hex = async (buf) => {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const getJson = async (path) => (await (await fetch(path, { cache: 'no-store' })).json());

/**
 * Start the seat. `onStatus(state, detail)` reports every transition for the wall:
 * manifest → verifying → loading → ready → answering… / refused / error.
 * Returns { stop() } — stopping ends the poll loop; the seat goes stale at the router.
 */
export async function startSeat({ onStatus = () => {} } = {}) {
  let stopped = false;
  const status = (s, d) => { try { onStatus(s, d); } catch { /* the wall's paint never breaks the seat */ } };
  try {
    status('manifest', 'reading the engine manifest');
    const manifest = await getJson('/engine/manifest');
    if (!manifest?.weights) { status('refused', 'the manifest pins no weights — no model to load'); return { stop() {} }; }
    const pinOf = (path) => [...(manifest.pinned ?? []), ...(manifest.bundle ?? [])].find((p) => p.path === path);

    status('verifying', 'checking the runtime against the manifest pins');
    const fetchPinned = async (path, pin) => {
      const buf = await (await fetch(`/engine/file/${path}`, { cache: 'no-store' })).arrayBuffer();
      const digest = await sha256Hex(buf);
      if (!pin || digest !== pin.sha256) throw new Error(`pin mismatch for ${path}: manifest ${pin?.sha256 ?? 'none'} vs fetched ${digest}`);
      return buf;
    };
    const wasmPin = pinOf('vendor/wllama/wasm/wllama.wasm');
    const wasmBuf = await fetchPinned('vendor/wllama/wasm/wllama.wasm', wasmPin);
    const jsPin = pinOf('vendor/wllama/index.js');
    const jsBuf = await fetchPinned('vendor/wllama/index.js', jsPin);
    const wasmUrl = URL.createObjectURL(new Blob([wasmBuf], { type: 'application/wasm' }));
    const jsUrl = URL.createObjectURL(new Blob([jsBuf], { type: 'text/javascript' }));
    const { Wllama } = await import(jsUrl);

    const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const wllama = new Wllama({ default: wasmUrl, 'single-thread/wllama.wasm': wasmUrl, 'multi-thread/wllama.wasm': wasmUrl }, { suppressNativeLog: true });
    // GPU support is claimed only on a REAL adapter: navigator.gpu existing (or wllama's
    // isSupportWebGPU, which is synchronous in v3 and checks API presence) is not evidence an
    // adapter will answer — headless browsers expose the API with no adapter behind it, and a
    // seat that reports "WebGPU" on that evidence is inventing a measurement.
    let adapter = null;
    try { adapter = webgpu ? await navigator.gpu.requestAdapter() : null; } catch { adapter = null; }
    let gpuSupported = false;
    try { gpuSupported = Boolean(adapter && wllama.isSupportWebGPU()); } catch { gpuSupported = false; }

    status('loading', `weights ${manifest.weights.name} — verifying, then loading in-tab`);
    const weightsBuf = await (await fetch(`/engine/file/weights/${manifest.weights.name}`, { cache: 'no-store' })).arrayBuffer();
    const wDigest = await sha256Hex(weightsBuf);
    if (wDigest !== manifest.weights.sha256) { status('refused', `weights pin mismatch: manifest ${manifest.weights.sha256} vs fetched ${wDigest}`); return { stop() {} }; }
    const loadT0 = performance.now();
    await wllama.loadModel([new Blob([weightsBuf])], { n_ctx: 2048, n_gpu_layers: gpuSupported ? 99 : 0 });
    const loadMs = Math.round(performance.now() - loadT0);
    status('ready', `${manifest.model} loaded in-tab in ${loadMs} ms (${gpuSupported ? 'WebGPU' : 'Wasm'})`);

    const reg = await post('/seat/register', { label: `browser seat · ${manifest.model}`, capabilities: { webgpu: gpuSupported, model: manifest.model, runtime: 'wllama', loadMs } });
    if (!reg.json?.ok) { status('error', `seat registration refused: ${reg.json?.error ?? reg.status}`); return { stop() {} }; }
    const { seatId, token } = reg.json;

    const answerOne = async (ask) => {
      const t0 = performance.now();
      let firstTokenMs = null, text = '', chunks = 0, usage = null;
      await wllama.createChatCompletion({
        messages: [{ role: 'user', content: ask.text }],
        max_tokens: 256, temperature: 0.7, stream: true,
        onData: (chunk) => {
          if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - t0);
          const delta = chunk?.choices?.[0]?.delta?.content ?? '';
          if (delta) { text += delta; chunks += 1; }
          if (chunk?.usage) usage = chunk.usage;
        },
      });
      const totalMs = Math.round(performance.now() - t0);
      const generated = usage?.completion_tokens ?? (chunks || null);
      const decodeMs = firstTokenMs != null ? totalMs - firstTokenMs : null;
      const decodeTokS = generated && decodeMs > 0 ? Math.round((generated / (decodeMs / 1000)) * 10) / 10 : null;
      return {
        answer: text.trim(),
        diagnostics: {
          model: manifest.model, webgpu: gpuSupported, loadMs,
          firstTokenMs, totalMs, promptTokens: usage?.prompt_tokens ?? null,
          generatedTokens: generated, decodeTokS,
        },
      };
    };

    (async () => {
      while (!stopped) {
        try {
          const { json } = await post('/seat/poll', { seatId, token });
          if (json?.ask) {
            status('answering', json.ask.id);
            try {
              const r = await answerOne(json.ask);
              await post('/seat/result', { seatId, token, askId: json.ask.id, ...r });
              status('ready', 'answered; waiting for the next ask');
            } catch (e) {
              await post('/seat/result', { seatId, token, askId: json.ask.id, error: String(e?.message ?? e) });
              status('ready', `an ask failed in-tab: ${String(e?.message ?? e)}`);
            }
          }
        } catch { /* a lost poll is retried; silence here never fakes a state */ }
        await new Promise((r) => setTimeout(r, 1200));
      }
    })();

    return { stop() { stopped = true; } };
  } catch (e) {
    status('error', String(e?.message ?? e));
    return { stop() {} };
  }
}
