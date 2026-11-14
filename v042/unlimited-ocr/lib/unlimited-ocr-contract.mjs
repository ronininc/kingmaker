/**
 * lib/unlimited-ocr-contract.mjs — the Cage contract for baidu/Unlimited-OCR.
 *
 * Unlimited-OCR is a one-shot long-document parser (100-page PDFs in a
 * single pass, layout/tables/formulas preserved; DeepSeek-OCR lineage).
 * It fits the ingestion pipeline and the universal file handler. It also
 * arrives with two hard facts that shape this contract:
 *
 *   1. CUDA-ONLY upstream. Every documented inference path (Transformers,
 *      vLLM, SGLang) requires CUDA. There is no MLX / GGUF / Apple
 *      Silicon path. On a Mac this engine does not run until a port is
 *      PROVEN by the feasibility spike (see INTAKE.md) — the contract
 *      refuses Mac invocations outright rather than letting a caller
 *      discover it at runtime.
 *   2. trust_remote_code. The upstream loader executes Python shipped in
 *      the model repo (configuration_deepseek_v2.py et al.). Under the
 *      Cage that code is VENDORED at the pinned commits below and loaded
 *      from the local snapshot only. Runtime downloads from the hub are
 *      refused — a model that can change its own code between runs is
 *      not pinned, whatever its weights say.
 *
 * The contract is pure decision logic: given an invocation, it returns
 * allow/refuse with reasons. Execution belongs to the host, on a host
 * class the contract admits.
 */

export const OCR_PIN = Object.freeze({
  repo: 'baidu/Unlimited-OCR',
  repoCommit: '92ad94b53a51950fea0416aced42331dfb4dd59e',
  modelRepo: 'baidu/Unlimited-OCR',
  modelRevision: '8249d20b2822a7d8a4c22c8d8c9069b5ac36bda3',
  license: 'MIT',
  paper: 'arXiv 2606.23050',
});

/** Host classes and their standing:
 *  cuda-node    — a governed GPU node (the EAGLE-4 pattern): ADMITTED.
 *  apple-silicon — REFUSED until the feasibility spike passes and this
 *                  contract is amended with the spike's receipt.
 *  anything else — REFUSED. */
export const HOST_CLASSES = Object.freeze(['cuda-node', 'apple-silicon']);

/** Document inputs the engine may take. Anything else is not an OCR job. */
export const DOCUMENT_EXTENSIONS = Object.freeze(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp']);

/**
 * decideOcrInvocation({ hostClass, modelRevision, repoCommit, codeSource, inputPath, spikeReceipt })
 *   codeSource: 'vendored-snapshot' | 'hub-download'
 * Returns { allow, reasons[] } — every refusal names its reason.
 */
export function decideOcrInvocation(inv = {}) {
  const reasons = [];
  if (!HOST_CLASSES.includes(inv.hostClass)) {
    reasons.push(`unknown host class "${inv.hostClass ?? '(none)'}" — refused`);
  }
  if (inv.hostClass === 'apple-silicon' && !inv.spikeReceipt) {
    reasons.push('Apple Silicon is CUDA-gated upstream: refused until the feasibility spike passes and its receipt is presented (INTAKE.md)');
  }
  if (inv.modelRevision !== OCR_PIN.modelRevision) {
    reasons.push(`model revision ${inv.modelRevision ?? '(none)'} is not the pin ${OCR_PIN.modelRevision.slice(0, 12)}… — refused`);
  }
  if (inv.repoCommit !== OCR_PIN.repoCommit) {
    reasons.push(`repo commit ${inv.repoCommit ?? '(none)'} is not the pin ${OCR_PIN.repoCommit.slice(0, 12)}… — refused`);
  }
  if (inv.codeSource !== 'vendored-snapshot') {
    reasons.push('model code must load from the pinned vendored snapshot — hub downloads at runtime execute unpinned remote code (trust_remote_code), refused');
  }
  const lower = String(inv.inputPath ?? '').toLowerCase();
  if (!DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    reasons.push(`input "${inv.inputPath ?? '(none)'}" is not a document the engine takes (${DOCUMENT_EXTENSIONS.join(' ')}) — refused`);
  }
  return { allow: reasons.length === 0, reasons };
}

/** The spike's pass criteria, as data — the Mac feasibility spike either
 *  produces this receipt or the engine stays a GPU-node lane. */
export const SPIKE_PASS_CRITERIA = Object.freeze({
  artifact: 'a converted Apple Silicon build (MLX or llama.cpp-vision class) derived from the pinned revision',
  checks: [
    'parses a 10-page mixed PDF (text + table + formula) end to end on the 8 GB M3 profile',
    'table structure survives (row/column fidelity spot-checked against the CUDA reference output)',
    'peak memory stays inside the profile budget during the parse',
    'output is markdown + layout JSON, matching the contract output shape',
  ],
  receipt: 'measurements + the reference-diff result, filed with this intake; the contract is amended to admit apple-silicon only with that receipt attached',
});
