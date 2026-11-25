#!/usr/bin/env python3
"""Verify and stage an owner-pinned non-secret runtime kit for isolated CI assembly."""
import argparse
import hashlib
import json
import pathlib
import re
import tarfile

KINDS = {
    "voice-runtime", "guardrails-runtime", "guardrails-config",
    "agent-runtime", "knowledge-runtime", "playwright-browsers",
}
REQUIRED_FILES = {
    "voice-runtime": ("manifest.json",),
    "guardrails-runtime": ("runtime-manifest.json", "solomon-guardrails"),
    "guardrails-config": ("policy-manifest.json", "config.yml"),
    "agent-runtime": ("goose",),
    "knowledge-runtime": ("northstar-tools-manifest.json",),
    "playwright-browsers": ("solomon-runtime-manifest.json", "solomon-runtime-manifest.json.sha256"),
}

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def stage(root, expected, source, engine, destination):
    plan_file = root / "runtime-kit.json"
    if not plan_file.is_file() or plan_file.is_symlink() or plan_file.stat().st_size > 65536 or digest(plan_file) != expected:
        raise ValueError("runtime-kit.json does not match the owner-pinned SHA-256")
    plan = json.loads(plan_file.read_text())
    if plan.get("schema") != "kingmaker.ci-runtime-kit/1" or plan.get("sourceCommit") != source or plan.get("engineCommit") != engine:
        raise ValueError("runtime-kit.json does not bind the pinned source and engine")
    rows = plan.get("inputs")
    if not isinstance(rows, list) or len(rows) != len(KINDS) or {r.get("kind") for r in rows} != KINDS:
        raise ValueError("runtime kit must name all six kinds, each exactly once")
    if len({r.get("archive") for r in rows}) != len(rows):
        raise ValueError("runtime kit archive filenames must be distinct")
    destination.mkdir(parents=True, exist_ok=True)
    prepared = []
    for row in rows:
        kind, filename = row.get("kind"), row.get("archive")
        if not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.tar(?:\.gz)?", filename):
            raise ValueError(f"{kind}: invalid archive filename")
        path = root / filename
        if path.is_symlink() or not path.is_file() or type(row.get("size")) is not int or path.stat().st_size != row["size"] or digest(path) != row.get("sha256"):
            raise ValueError(f"{kind}: archive size or SHA-256 mismatch")
        if (destination / kind).exists() or (destination / kind).is_symlink():
            raise ValueError(f"{kind}: refusing to overwrite an existing runtime")
        prepared.append((kind, path))
    for kind, path in prepared:
        with tarfile.open(path) as archive:
            # All records must stay inside their one named runtime. Handle macOS
            # bsdtar data, but never restore special files, modes or out-of-tree links.
            def data_filter(member, extraction_root):
                parts = pathlib.PurePosixPath(member.name).parts
                if not parts or parts[0] != kind or ".." in parts:
                    raise ValueError(f"{kind}: archive entry escapes its runtime root")
                base = pathlib.Path(extraction_root).resolve()
                kind_root = base / kind
                if not (base / member.name).resolve().is_relative_to(kind_root):
                    raise ValueError(f"{kind}: archive path resolves outside its runtime root")
                if member.issym() or member.islnk():
                    linked = pathlib.PurePosixPath(member.linkname)
                    link_parent = (base / member.name).parent if member.issym() else base
                    if linked.is_absolute() or not (link_parent / linked).resolve().is_relative_to(kind_root):
                        raise ValueError(f"{kind}: link escapes its runtime root")
                return tarfile.data_filter(member, extraction_root)
            archive.extractall(destination, filter=data_filter)
        for filename in REQUIRED_FILES[kind]:
            if not (destination / kind / filename).is_file():
                raise ValueError(f"{kind}: required staged file missing ({filename})")
    guard = destination / "guardrails-runtime"
    recorded = json.loads((guard / "runtime-manifest.json").read_text())
    if digest(guard / "solomon-guardrails") != recorded.get("executableSha256"):
        raise ValueError("guardrails executable differs from its existing manifest pin")
    browsers = destination / "playwright-browsers"
    browser_hash = (browsers / "solomon-runtime-manifest.json.sha256").read_text().split()
    if len(browser_hash) != 2 or browser_hash[1] != "solomon-runtime-manifest.json" or browser_hash[0] != digest(browsers / browser_hash[1]):
        raise ValueError("browser runtime manifest differs from its existing pin")
    print("Owner-pinned kit verified and staged: " + ", ".join(sorted(KINDS)))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("kit", "destination"):
        parser.add_argument("--" + name, type=pathlib.Path, required=True)
    for name in ("sha256", "source", "engine"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if any(not re.fullmatch(f"[a-f0-9]{{{length}}}", value)
           for length, value in [(64, args.sha256), (40, args.source), (40, args.engine)]):
        parser.error("Expected manifest SHA-256 and two full commit SHAs")
    try:
        stage(args.kit, args.sha256, args.source, args.engine, args.destination)
    except (OSError, ValueError, AttributeError, TypeError, tarfile.TarError) as error:
        parser.exit(1, f"runtime kit refused: {error}\n")

if __name__ == "__main__":
    main()
