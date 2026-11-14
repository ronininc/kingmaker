"""Translation bench for the code translator (design 2026-11-14, section 3.3).

Usage:
  python3 -I eval_translate.py OUT.jsonl model [model...]   score models over the tasks
  python3 -I eval_translate.py --validate                   check the tasks themselves:
        every source parses in its own language, every reference translation parses in
        its target language, and references (and sources, where executable) pass their
        own fixed test vectors. No model needed — this proves the bench machinery.

Scoring mirrors the langcheck contract: a real parse check in the target language
(node --check / type-stripping + node --check / py_compile / bash -n — parse-only,
nothing is executed for the parse), plus fixed test-vector equivalence where the
target is executable (the snippets are tiny pure functions, run in throwaway
processes, exactly like eval_models.py's code task).

Model-mode records — one JSON line per (model, task) appended to OUT:
  {"model", "task", "pair", "parse", "vectors", "ok"}
These lines are the first per-pair translation evidence; folding them into the
selector's eval lane is the follow-on the design names (section 3.3).
"""
import json, re, shlex, subprocess, sys, tempfile, urllib.request
from pathlib import Path

HOST = "http://127.0.0.1:11434"
TASKS_FILE = Path(__file__).with_name("translate_tasks.json")
EXT = {"javascript": ".js", "typescript": ".ts", "python": ".py", "bash": ".sh"}
STRIP_JS = ("const {stripTypeScriptTypes}=require('node:module');const fs=require('node:fs');"
            "process.stdout.write(stripTypeScriptTypes(fs.readFileSync(process.argv[1],'utf8')));")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)


def strip_ts(code):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "in.ts"
        f.write_text(code)
        r = run(["node", "-e", STRIP_JS, str(f)])
        if r.returncode != 0:
            raise ValueError(f"typescript strip failed: {r.stderr.strip()[:160]}")
        return r.stdout


def parse_ok(code, language):
    """A real parse check in the file's own language. Parse-only: nothing executes."""
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / ("check" + EXT[language])
        f.write_text(code)
        try:
            if language == "javascript":
                return run(["node", "--check", str(f)]).returncode == 0
            if language == "typescript":
                g = Path(d) / "stripped.mjs"
                g.write_text(strip_ts(code))
                return run(["node", "--check", str(g)]).returncode == 0
            if language == "python":
                import os
                env = {**os.environ, "PYTHONPYCACHEPREFIX": str(Path(d) / "pyc")}
                return run(["python3", "-m", "py_compile", str(f)], env=env).returncode == 0
            if language == "bash":
                return run(["bash", "-n", str(f)]).returncode == 0
        except Exception:
            return False
    return False


def run_vectors(code, language, fn, vectors):
    """Execute the snippet's named function against the fixed vectors.
    True/False, or None when the task carries no vectors."""
    if not vectors:
        return None
    expects = [v["expect"] for v in vectors]
    try:
        with tempfile.TemporaryDirectory() as d:
            if language == "python":
                args = repr([v["args"] for v in vectors])  # repr: JSON values as Python literals
                f = Path(d) / "run.py"
                f.write_text(code + f"\nimport json as _j\nprint(_j.dumps([{fn}(*_a) for _a in {args}]))\n")
                r = run(["python3", str(f)])
                if r.returncode != 0:
                    return False
                return json.loads(r.stdout.strip().splitlines()[-1]) == expects
            if language in ("javascript", "typescript"):
                js = strip_ts(code) if language == "typescript" else code
                calls = ", ".join(f"{fn}({', '.join(json.dumps(a) for a in v['args'])})" for v in vectors)
                f = Path(d) / "run.mjs"
                f.write_text(js + f"\nconsole.log(JSON.stringify([{calls}]));\n")
                r = run(["node", str(f)])
                if r.returncode != 0:
                    return False
                return json.loads(r.stdout.strip().splitlines()[-1]) == expects
            if language == "bash":
                src = Path(d) / "code.sh"
                src.write_text(code)
                drv = Path(d) / "run.sh"
                lines = [f"source {shlex.quote(str(src))}"]
                for v in vectors:
                    lines.append(" ".join([fn] + [shlex.quote(str(a)) for a in v["args"]]))
                drv.write_text("\n".join(lines) + "\n")
                r = run(["bash", str(drv)])
                if r.returncode != 0:
                    return False
                got = [line.strip() for line in r.stdout.strip().splitlines()]
                return got == [str(e) for e in expects]
    except Exception:
        return False
    return False


def ask(model, prompt):
    body = {"model": model, "prompt": prompt, "stream": False, "think": False,
            "options": {"num_predict": 1200, "num_ctx": 4096, "temperature": 0}}
    req = urllib.request.Request(HOST + "/api/generate", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return re.sub(r"<think>.*?</think>", "", json.loads(r.read()).get("response", ""), flags=re.S).strip()


PROMPT = """You are the code translator inside a conducted Kingmaker method. Translate the given source code into the target language named below. Preserve behavior: same inputs, same outputs, same edge cases. Use the target language's ordinary idioms where they do not change behavior. Output ONLY the translated code — no explanation, no markdown fences. The first line of the output must be a comment in the target language's own comment syntax containing the marker kingmaker-translate and stating: translated from {src} to {tgt}.

Source language: {src}
Target language: {tgt}

Source code:
{code}"""


def extract(out):
    m = re.search(r"```(?:[a-z+#-]*)\n(.*?)```", out, re.S)
    return (m.group(1) if m else out).strip() + "\n"


def load_tasks():
    return json.loads(TASKS_FILE.read_text())["tasks"]


def validate():
    tasks = load_tasks()
    bad = 0
    for t in tasks:
        checks = {
            "source parses": parse_ok(t["source"], t["source_language"]),
            "reference parses": parse_ok(t["reference"], t["target_language"]),
            "reference vectors": run_vectors(t["reference"], t["target_language"], t["target_function"], t["vectors"]),
            "source vectors": run_vectors(t["source"], t["source_language"], t["source_function"], t["vectors"]),
        }
        ok = all(v is not False for v in checks.values())
        bad += 0 if ok else 1
        print(f"{t['id']} ({t['source_language']} -> {t['target_language']}): " +
              " ".join(f"{k}:{'✓' if v else '✗'}" for k, v in checks.items()), flush=True)
    print(f"validate: {len(tasks) - bad}/{len(tasks)} tasks sound")
    return 1 if bad else 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--validate":
        return validate()
    out_path, models = sys.argv[1], sys.argv[2:]
    tasks = load_tasks()
    with open(out_path, "a") as f:
        for model in models:
            for t in tasks:
                try:
                    raw = ask(model, PROMPT.format(src=t["source_language"], tgt=t["target_language"], code=t["source"]))
                    code = extract(raw)
                    p = parse_ok(code, t["target_language"])
                    v = run_vectors(code, t["target_language"], t["target_function"], t["vectors"])
                    ok = bool(p and v is not False)
                except Exception:
                    p, v, ok = False, False, False
                rec = {"model": model, "task": t["id"], "pair": f"{t['source_language']}->{t['target_language']}",
                       "parse": p, "vectors": v, "ok": ok}
                f.write(json.dumps(rec) + "\n")
                f.flush()
                print(model, t["id"], rec["pair"], "✓" if ok else "✗", f"parse:{p} vectors:{v}", flush=True)
            try:
                urllib.request.urlopen(urllib.request.Request(HOST + "/api/generate", json.dumps({"model": model, "keep_alive": 0}).encode(), {"Content-Type": "application/json"}), timeout=60).read()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
