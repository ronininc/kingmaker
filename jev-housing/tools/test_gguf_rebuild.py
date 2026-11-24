"""Synthetic regression tests. The child executable emits fixture arrays."""
import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gguf_score_min import HEAD_B, HEAD_W, TEMPERATURE, head_parameters
from rebuild_gguf import LLAMA_COMMIT, sha256, verify_checkpoint, verify_split_layout

TOOLS = Path(__file__).resolve().parent
PROMPT = b"<|im_start|>user\nKeep literal \\n.\n<|im_end|>\n"


class GGUFRebuildTests(unittest.TestCase):
    def test_split_layout_rejects_missing_and_fused_tensors(self):
        names = {f"blk.{layer}.{suffix}.weight" for layer in range(24) if layer % 4 != 3
                 for suffix in ("ssm_alpha", "ssm_beta", "attn_qkv", "attn_gate")}
        verify_split_layout("qwen35", names)
        old = "blk.0.ssm_beta.weight"
        with self.assertRaisesRegex(SystemExit, old):
            verify_split_layout("qwen35", names - {old})
        with self.assertRaisesRegex(SystemExit, "unexpected fused tensor"):
            verify_split_layout("qwen35", names | {"blk.0.attn_qkv_gate.weight"})

    def test_checkpoint_pins_are_checked_before_conversion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            names = ["model.safetensors", "config.json", "model.safetensors.index.json"]
            pins = []
            for name in names:
                path = root / name
                path.write_text(name)
                pins.append({"path": name, "sha256": sha256(path), "size": len(name)})
            (root / "housing-manifest.json").write_text(json.dumps({
                "merge": {"shards": pins[:1], "config": pins[1], "index": pins[2]}}))
            with patch("rebuild_gguf.ROOT", root):
                verify_checkpoint(root)
                (root / names[0]).write_text("x" * len(names[0]))
                with self.assertRaisesRegex(SystemExit, "merged checkpoint pin mismatch"):
                    verify_checkpoint(root)

    def setUp(self):
        self._fixture_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._fixture_dir.cleanup)
        self.root = Path(self._fixture_dir.name)
        self.gguf = self.root / "model.gguf"
        self.gguf.write_bytes(b"synthetic fixture, no model weights")
        self.prompt = self.root / "prompt.txt"
        self.prompt.write_bytes(PROMPT)
        self.embedding = self.root / "fixture-embedding"
        self.fake_embedding()

    def fake_embedding(self, *, build=LLAMA_COMMIT[:7], vector_length=2048, fail=False):
        self.embedding.write_text(f"""#!{sys.executable}
import json, pathlib, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("version: 11081 ({build})", file=sys.stderr)
    raise SystemExit(0)
assert pathlib.Path(args[args.index("--binary-file") + 1]).read_bytes() == {PROMPT!r}
assert "--no-escape" in args
assert args[args.index("--embd-separator") + 1] != "\\n"
assert args[args.index("--pooling") + 1] == "none"
assert args[args.index("--embd-normalize") + 1] == "-1"
if {fail!r}:
    print("batch_decode : failed to process", file=sys.stderr)
    raise SystemExit(0)
n = {vector_length}
print(json.dumps([[3.0] + [0.0] * (n - 1), [5.0] + [0.0] * (n - 1)]))
print("llama_perf_context_print:        load time = 2.50 ms", file=sys.stderr)
""")
        self.embedding.chmod(0o700)

    def invoke(self, *args):
        cmd = [sys.executable, "-B", str(TOOLS / "gguf_score_min.py"), "--embedding",
               str(self.embedding), "--gguf", str(self.gguf)]
        return subprocess.run(cmd + list(args), capture_output=True, text=True)

    def test_single_prompt_receipt_proves_numeric_housed_head(self):
        result = self.invoke("--prompt-file", str(self.prompt), "--expected-tokens", "2")
        self.assertEqual(result.returncode, 0, result.stderr)
        row = json.loads(result.stdout)
        w, b = head_parameters()
        self.assertAlmostEqual(row["score"], 5.0 * w[0] + b)
        self.assertTrue(row["loaded"])
        self.assertTrue(row["scored_through_head"])
        self.assertEqual(row["model_calls"], 1)
        self.assertEqual(row["tokens"], 2)
        self.assertEqual(row["load_time_ms"], 2.5)
        self.assertGreater(row["elapsed_ms"], 0)
        self.assertGreater(row["peak_rss_bytes"], 0)
        self.assertEqual(row["gguf_sha256"], sha256(self.gguf))
        self.assertEqual(row["head_weight_sha256"], sha256(HEAD_W))
        self.assertEqual(row["head_bias_sha256"], sha256(HEAD_B))

    def test_current_llama_version_format_is_accepted(self):
        self.fake_embedding(build=f"build 1, commit {LLAMA_COMMIT[:7]}")
        result = self.invoke("--prompt-file", str(self.prompt), "--expected-tokens", "2")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_version_gate_allows_memory_tight_mac_startup(self):
        source = (TOOLS / "gguf_score_min.py").read_text()
        self.assertIn('timeout=60', source)

    def test_single_prompt_rejects_false_load_or_score(self):
        for fixture, expected in [
            ({"build": "7654321"}, "does not report the pinned build"),
            ({"fail": True}, "batch_decode : failed to process"),
            ({"vector_length": 3}, "invalid raw final hidden state"),
        ]:
            with self.subTest(fixture=fixture):
                self.fake_embedding(**fixture)
                result = self.invoke("--prompt-file", str(self.prompt))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_prompt_token_mismatch_is_rejected(self):
        result = self.invoke("--prompt-file", str(self.prompt), "--expected-tokens", "3")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected 3, got 2", result.stderr)

    def test_fresh_fixture_comparison_and_no_stale_receipt(self):
        w, b = head_parameters()
        logit = 5.0 * w[0] + b
        yes = 1 / (1 + math.exp(-logit / TEMPERATURE))
        record = {"fixture": "demo", "key": "safe", "kind": "noul",
                  "option_keys": ["false", "true"]}
        manifest = [dict(record, files=[self.prompt.name], token_counts=[2])]
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        reference = self.root / "reference.json"
        reference.write_text(json.dumps({"results": [
            dict(record, logits=[logit], probabilities=[1 - yes, yes])]}))
        receipt = self.root / "receipt.json"
        args = ("--fresh", "--label", "fixture", "--texts", str(self.root),
                "--reference", str(reference), "--out", str(receipt))
        result = self.invoke(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        row = json.loads(receipt.read_text())
        self.assertEqual(row["model_calls"], 1)
        self.assertAlmostEqual(row["comparison_vs_reference"]["worst_prob_delta"], 0.0)
        result = self.invoke(*args)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("output already exists", result.stderr)


if __name__ == "__main__":
    unittest.main()
