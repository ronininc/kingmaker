"""Measure local models through Ollama. Usage: python3 -I bench_models.py OUT.jsonl HOST model [model...]
HOST is an Ollama base URL (http://127.0.0.1:11434). Each model: cold load, then 3 fixed turns.
Records load s, prompt tok/s, gen tok/s, wall s per turn, ollama-reported resident size, swap delta (macOS only)."""
import json, subprocess, sys, time, urllib.request

OUT, HOST, MODELS = sys.argv[1], sys.argv[2].rstrip("/"), sys.argv[3:]
TURNS = [
    ("short", "In one sentence: what is a sales tax?"),
    ("steps", "List 5 steps to follow up with a lead who went quiet. Be brief."),
    ("code", "Write a Python function is_valid_email(s) using a regex. Code only."),
]


def post(path, body, timeout=600):
    req = urllib.request.Request(HOST + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def swap_mb():
    try:
        s = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
        return float(s.split("used = ")[1].split("M")[0])
    except Exception:
        return None


def resident(model):
    try:
        with urllib.request.urlopen(HOST + "/api/ps", timeout=10) as r:
            for m in json.loads(r.read()).get("models", []):
                if m["name"].startswith(model):
                    return {"size_gb": round(m.get("size", 0) / 1e9, 2), "vram_gb": round(m.get("size_vram", 0) / 1e9, 2)}
    except Exception:
        pass
    return None


with open(OUT, "a") as f:
    for model in MODELS:
        post("/api/generate", {"model": model, "keep_alive": 0}, 60)  # unload so the load is cold
        time.sleep(2)
        swap0 = swap_mb()
        for name, prompt in TURNS:
            t0 = time.time()
            try:
                r = post("/api/generate", {"model": model, "prompt": prompt, "stream": False, "think": False,
                                           "options": {"num_predict": 160, "num_ctx": 4096, "temperature": 0}})
            except Exception as e:
                rec = {"model": model, "turn": name, "error": str(e)[:200]}
            else:
                ns = 1e9
                rec = {
                    "model": model, "turn": name, "host": HOST,
                    "wall_s": round(time.time() - t0, 2),
                    "load_s": round(r.get("load_duration", 0) / ns, 2),
                    "prompt_tok_s": round(r.get("prompt_eval_count", 0) / max(r.get("prompt_eval_duration", 1) / ns, 1e-9), 1),
                    "gen_tok_s": round(r.get("eval_count", 0) / max(r.get("eval_duration", 1) / ns, 1e-9), 1),
                    "gen_tokens": r.get("eval_count"),
                    "resident": resident(model),
                    "swap_delta_mb": (round(swap_mb() - swap0, 0) if swap0 is not None else None),
                    "sample": (r.get("response") or "")[:160],
                }
            print(json.dumps(rec), flush=True)
            f.write(json.dumps(rec) + "\n")
        post("/api/generate", {"model": model, "keep_alive": 0}, 60)
