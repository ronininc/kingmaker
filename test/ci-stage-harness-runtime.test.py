import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ci-stage-harness-runtime.py"
SPEC = importlib.util.spec_from_file_location("stage_kit", SCRIPT)
KIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(KIT)
SOURCE = "a" * 40
ENGINE = "b" * 40

class RuntimeKitTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.root = Path(self.root.name)
        self.staged = self.root / "staged"

    @staticmethod
    def put(archive, name, contents):
        info = tarfile.TarInfo(name)
        info.size = len(contents)
        archive.addfile(info, io.BytesIO(contents))

    def kit(self, *, wrong_guardrails=False, link=False):
        rows = []
        for kind, files in KIT.REQUIRED_FILES.items():
            path = self.root / f"{kind}.tar.gz"
            contents = {name: b"fixture" for name in files}
            if kind == "guardrails-runtime":
                guard_hash = hashlib.sha256(contents["solomon-guardrails"]).hexdigest()
                contents["runtime-manifest.json"] = json.dumps({
                    "executableSha256": "0" * 64 if wrong_guardrails else guard_hash,
                }).encode()
            if kind == "playwright-browsers":
                browser_hash = hashlib.sha256(contents["solomon-runtime-manifest.json"]).hexdigest()
                contents["solomon-runtime-manifest.json.sha256"] = f"{browser_hash}  solomon-runtime-manifest.json\n".encode()
            with tarfile.open(path, "w:gz") as archive:
                for name, data in contents.items():
                    self.put(archive, f"{kind}/{name}", data)
                if link and kind == "knowledge-runtime":
                    escaping = tarfile.TarInfo(f"{kind}/escape")
                    escaping.type = tarfile.SYMTYPE
                    escaping.linkname = "../guardrails-runtime"
                    archive.addfile(escaping)
            rows.append({"kind": kind, "archive": path.name, "size": path.stat().st_size, "sha256": KIT.digest(path)})
        manifest = self.root / "runtime-kit.json"
        manifest.write_text(json.dumps({"schema": "kingmaker.ci-runtime-kit/1", "sourceCommit": SOURCE, "engineCommit": ENGINE, "inputs": rows}))
        return KIT.digest(manifest)

    def test_valid_kit_stages_all_six(self):
        KIT.stage(self.root, self.kit(), SOURCE, ENGINE, self.staged)
        self.assertEqual({p.name for p in self.staged.iterdir()}, KIT.KINDS)

    def test_digest_mismatch_is_rejected_before_staging(self):
        expected = self.kit()
        with (self.root / "voice-runtime.tar.gz").open("ab") as stream:
            stream.write(b"modified")
        with self.assertRaisesRegex(ValueError, "size or SHA-256 mismatch"):
            KIT.stage(self.root, expected, SOURCE, ENGINE, self.staged)
        self.assertEqual(list(self.staged.iterdir()), [])

    def test_cross_runtime_link_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "link escapes"):
            KIT.stage(self.root, self.kit(link=True), SOURCE, ENGINE, self.staged)
        self.assertFalse((self.staged / "knowledge-runtime" / "escape").is_symlink())

    def test_wrong_engine_commit_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "does not bind"):
            KIT.stage(self.root, self.kit(), SOURCE, "c" * 40, self.staged)

    def test_guardrails_executable_is_never_repinned(self):
        with self.assertRaisesRegex(ValueError, "differs from its existing manifest pin"):
            KIT.stage(self.root, self.kit(wrong_guardrails=True), SOURCE, ENGINE, self.staged)

if __name__ == "__main__":
    unittest.main()
