# Admitted local streamed Kronos runner

`EXISTING_VENV_PYTHON scripts/run-local-streamed-kronos.py --request request.json`

This is a reusable single-request subprocess, not a service or default route. It is disabled unless the caller explicitly supplies admission. Only the two already reviewed original Kronos checkpoint/config pairs and two exact original source-module hashes are supported. Other hashes reject, even if a caller marks them admitted. No arbitrary source/provider discovery, downloads, training, generic LLM or publication capability is enabled.

## Request

```json
{
  "schema": "kingmaker.local-streamed-kronos/1",
  "mode": "tokenizer",
  "admission": {
    "enabled": true,
    "pins": {
      "checkpoint_sha256": "REVIEWED_HASH",
      "config_sha256": "REVIEWED_HASH",
      "kronos_py_sha256": "REVIEWED_HASH",
      "module_py_sha256": "REVIEWED_HASH"
    }
  },
  "paths": {"repository": "/existing/Kronos", "checkpoint": "/existing/model.safetensors", "config": "/existing/config.json"},
  "budget": {"threads": 1, "deadline_seconds": 15, "max_rss_bytes": 805306368},
  "input": {"values": [[[0, 0, 0, 0, 0, 0]]]}
}
```

`forecast` input instead contains `s1_ids`, `s2_ids`, `s1_targets` with shape [1,T], and `stamp` [1,T,5]. Integer IDs 0..1023, timestamps minute/hour/weekday/day/month within the original embedding bounds. This is teacher-forced forward evaluation, NOT an autonomous forecast. Tokenizer values are finite bounded floats [1,T,6]. Both limit sequence length to 1..16, batch1. Threads1..2, deadline1..30 seconds, peak RSS budget128..768MiB. JSON request size <=64KiB. Caller should invoke the trusted existing Python executable with isolated interpreter mode `-I` and a subprocess kill timeout; never trust an arbitrary executable from untrusted input.

## Execution and trust

No standard full-checkpoint load or oracle runs in the operational path. Only selected checkpoint is integrity-scanned once with <=4MiB chunks, validating its pinned whole-file hash and binding each tensor range to that hash. That startup scan DOES read every tensor of the selected model, not all library models; receipt reports it separately. Thereafter modules read required ranges via local `pread`, verify hashes before use, execute on CPU, and evict weights. No HTTP is needed operationally. Receipts call this local file-range streaming, not cloud inference. Streaming still performs compute and rereads reused tensors.

Verified source bytes are compiled only after matching hardcoded reviewed hashes. Repository is not added to the import search path; arbitrary package `__init__` is not executed. Config and checkpoint hashes must match their mode. This does not sandbox the installed Python environment or dependencies. Use the trusted existing runtime, not a user-controlled virtualenv. Caller admission expresses local authorization, not a cryptographic signature or access-control system.

All parameters construct directly as meta placeholders. The tokenizer's tiny derived nonpersistent buffer uses its original CPU implementation. Posthooks evict on success or module exceptions; outer finally evicts partial prehook loads, closes the file and removes hooks. SIGTERM and wall-time deadline raise through cleanup. SIGKILL cannot run Python cleanup but subprocess termination releases its resources. Parent must impose a hard kill timeout for native operations that defer signal processing. RSS monitoring is a guard checked at boundaries, NOT an OS-enforced hard resident-memory cap; an allocation may temporarily exceed it.

## Receipt

Success schema `kingmaker.local-streamed-kronos-result/1`, `ok:true`, `cleanup_completed:true`, mode, exact `input_bindings`, input SHA256, Python/Torch/device versions, output shapes/arrays, elapsed seconds, process peak RSS, counts including startup integrity bytes, execution range reads/bytes and peak/live weight bytes. Input hash uses Python sorted compact JSON; do not assume a different language's float serialization yields the same hash. No input is written by the runner. Parent registry should store hashes and scoped receipt, not raw user input/output by default.

Failure exits1 with the same schema, `ok:false`, error type/message, and cleanup status when execution entered the protected region. Early admission errors have `cleanup_completed:false` because no runtime/resources were created. Never persist a failed run as verified capability.

## Verification

Eight local integration tests cover disabled admission, wrong pins, thread/RSS budgets, input shape, injected corrupted range after partial loads, SIGTERM after partial loads, and both operational modes versus separately run original full-checkpoint oracle. Both numerical comparisons are exact. Tests require the local request fixtures and installed source/checkpoints in `weight-adaptation-evidence`; they do not download fixtures. Run using the existing venv Python `test/local_streamed_kronos_test.py`.

Operational runs without oracle: tokenizer peak RSS331,022,336 bytes, forecast338,853,888 bytes; respective elapsed2.00s and1.37s including import/setup. Outputs are model forward results on synthetic inputs, not independent task-quality evidence. This runner is not wired into normal request routing by itself. No installed signed application or library admission was changed.

## JS operational integration

`lib/local-streamed-kronos.mjs` invokes the explicitly caller-selected trusted existing Python with `-I`, not a resolved symlink that loses its virtual environment. It binds request pins to the successful receipt, requires zero remaining weight bytes and cleanup, imposes a35-second parent deadline and SIGKILL fallback after cancellation, bounds stdout, and removes the0600 temporary request (including user input) in finally. Successful log evidence omits raw outputs and input values; it stores hashes, shapes and actual resource counts. Failed/canceled runs are not recorded.

Both tokenizer and forecast were actually executed through this wrapper and the persistent verification registry using existing approved local files. Subprocess cancellation was actually exercised. `createIdleKronosVerification` connects the two-hour controller to this same local-only cancellable path. It does not autostart: the current macOS pressure probe is denied, and unknown OS health must continue to refuse rather than guess. No live two-hour automatic cycle has been verified or activated.

### Updated idle guard

The denied sysctl probe is superseded by an explicitly labeled headroom-and-swap guard (`memory_pressure -Q` plus stable `vm_stat` swap counters over timely samples), not a claim of measured normal kernel pressure. Integrated live observation found65% headroom and stable swap but only130,973,696 bytes of actual free RAM, below256MiB; it correctly returned `memory-reserve`. HID idle was about9.7minutes, also below two hours. No idle job was activated.
